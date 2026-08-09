"""The colcon-dashboard command line.

Starts (or finds) the single per-machine server, and handles --stop,
--list, and the systemd user service install:

    colcon-dashboard [WORKSPACE] [--port N] [--host 127.0.0.1] [--stop]
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

try:
    import fcntl
except ImportError:  # non-Unix: run without the single-instance lock
    fcntl = None
from http.server import ThreadingHTTPServer
from urllib.parse import quote

from .registry import CACHE_DIR, GLOBAL_PORT, Registry, SERVER_FILE
from .web import Handler


def read_server():
    try:
        with open(SERVER_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def probe_server(info, timeout=0.8):
    """True when the recorded global server answers."""
    if not info or "port" not in info:
        return False
    url = f"http://{info.get('host', '127.0.0.1')}:{info['port']}/api/ping"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r).get("app") == "colcon-dashboard"
    except (OSError, ValueError):
        return False


def server_url(info, workspace=None):
    base = f"http://{info.get('host', '127.0.0.1')}:{info['port']}/"
    if workspace:
        base += "?ws=" + quote(workspace, safe="")
    return base


def register_workspace(info, workspace, timeout=2.0):
    url = (f"http://{info.get('host', '127.0.0.1')}:{info['port']}"
           f"/api/register?ws=" + quote(workspace, safe=""))
    try:
        with urllib.request.urlopen(url, data=b"", timeout=timeout) as r:
            return json.load(r).get("ok", False)
    except (OSError, ValueError):
        return False


SERVICE_UNIT = """\
[Unit]
Description=Colcon Dashboard

[Service]
ExecStart={exe} -m colcon_dashboard
Restart=on-failure

[Install]
WantedBy=default.target
"""


def install_service():
    """Install and start the systemd user service."""
    unit_dir = os.path.join(os.path.expanduser("~"), ".config",
                            "systemd", "user")
    os.makedirs(unit_dir, exist_ok=True)
    unit_path = os.path.join(unit_dir, "colcon-dashboard.service")
    with open(unit_path, "w") as f:
        f.write(SERVICE_UNIT.format(exe=sys.executable))
    print(f"wrote {unit_path}")
    info = read_server()
    if probe_server(info):  # hand the lock to the service
        os.kill(info["pid"], signal.SIGTERM)
        time.sleep(0.5)
        print(f"stopped the running server (pid {info['pid']})")
    for cmd in (["systemctl", "--user", "daemon-reload"],
                ["systemctl", "--user", "enable", "--now",
                 "colcon-dashboard.service"]):
        r = subprocess.run(cmd)
        if r.returncode != 0:
            raise SystemExit(f"failed: {' '.join(cmd)}")
    deadline = time.time() + 6
    while time.time() < deadline:
        time.sleep(0.3)
        info = read_server()
        if probe_server(info):
            print(f"service running: {server_url(info)}")
            return
    print("the service started, but the server does not answer yet")


def main():
    ap = argparse.ArgumentParser(
        description="Colcon Dashboard - live colcon build dashboard")
    ap.add_argument("workspace", nargs="?", default=None,
                    help="workspace to open (optional: the page can pick one)")
    ap.add_argument("--port", type=int, default=None,
                    help=f"HTTP port (default: {GLOBAL_PORT})")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--log-base", default="log",
                    help="log directory relative to a workspace (default: log)")
    ap.add_argument("--stop", action="store_true",
                    help="stop the dashboard server")
    ap.add_argument("--stop-all", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--list", action="store_true", dest="list_workspaces",
                    help="list the known workspaces")
    ap.add_argument("--install-service", action="store_true",
                    help="install and start the systemd user service")
    args = ap.parse_args()

    if args.install_service:
        install_service()
        return

    info = read_server()
    alive = probe_server(info)

    if args.stop or args.stop_all:
        if alive:
            os.kill(info["pid"], signal.SIGTERM)
            print(f"stopped the dashboard server (pid {info['pid']})")
        else:
            print("no server runs")
        return

    if args.list_workspaces:
        if alive:
            url = (f"http://{info.get('host', '127.0.0.1')}:{info['port']}"
                   f"/api/workspaces")
            with urllib.request.urlopen(url, timeout=2) as r:
                entries = json.load(r).get("workspaces", [])
            print(f"server: {server_url(info)}  pid {info['pid']}")
            for e in entries:
                state = ("building" if e.get("active")
                         else "idle" if e.get("build_id") else "")
                print(f"  {server_url(info, e['path'])}  {state}")
            if not entries:
                print("  no workspaces yet")
        else:
            print("no server runs")
        return

    workspace = None
    if args.workspace:
        workspace = os.path.realpath(args.workspace)
        if not os.path.isdir(workspace):
            raise SystemExit(f"not a directory: {workspace}")

    if alive:
        if workspace:
            register_workspace(info, workspace)
        print(f"already running: {server_url(info, workspace)}")
        return

    # one server per machine: hold an exclusive lock on the server file
    os.makedirs(CACHE_DIR, exist_ok=True)
    lock_file = open(SERVER_FILE, "a+")
    if fcntl is not None:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("another server is starting")
            return

    ThreadingHTTPServer.daemon_threads = True  # a stop request must not hang
    port = args.port if args.port else GLOBAL_PORT
    try:
        server = ThreadingHTTPServer((args.host, port), Handler)
    except OSError:
        if args.port:
            raise SystemExit(f"port {args.port} is in use")
        server = ThreadingHTTPServer((args.host, 0), Handler)  # any free port
    port = server.server_address[1]

    lock_file.seek(0)
    lock_file.truncate()
    json.dump({"host": args.host, "port": port, "pid": os.getpid()}, lock_file)
    lock_file.flush()

    registry = Registry(args.log_base)
    Handler.registry = registry
    if workspace:
        registry.monitor(workspace)

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    info = {"host": args.host, "port": port}
    print("Colcon Dashboard")
    print(f"  url: {server_url(info)}")
    if workspace:
        print(f"  workspace: {server_url(info, workspace)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.unlink(SERVER_FILE)
        except OSError:
            pass
