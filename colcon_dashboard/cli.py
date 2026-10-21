"""The colcon-dashboard command line.

Starts (or finds) the single per-machine server, and handles the
maintenance and systemd user service commands:

    colcon-dashboard [WORKSPACE] [--port N] [--host 127.0.0.1]
    colcon-dashboard --status | --list | --prune [--keep N] | --stop
    colcon-dashboard --install-service | --uninstall-service |
                     --start-service | --stop-service |
                     --restart-service | --service-status

Option defaults resolve as: command line > config.ini > built-in.
"""

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

try:
    import fcntl
except ImportError:  # non-Unix: run without the single-instance lock
    fcntl = None
from http.server import ThreadingHTTPServer
from urllib.parse import quote

from . import __version__
from .config import CONFIG, write_template
from .monitor import prune_builds
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
    url = f"http://{display_host(info.get('host'))}:{info['port']}/api/ping"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r).get("app") == "colcon-dashboard"
    except (OSError, ValueError):
        return False


def display_host(host):
    """A host a browser can open: the wildcard binds become loopback."""
    return "127.0.0.1" if host in (None, "", "0.0.0.0", "::") else host


def lan_ip():
    """The primary LAN address, or None. The UDP connect never sends."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 1))  # TEST-NET-1: routing lookup only
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def server_url(info, workspace=None):
    base = f"http://{display_host(info.get('host'))}:{info['port']}/"
    if workspace:
        base += "?ws=" + quote(workspace, safe="")
    return base


def api_url(info, path):
    return f"http://{display_host(info.get('host'))}:{info['port']}{path}"


def register_workspace(info, workspace, timeout=2.0):
    url = api_url(info, "/api/register?ws=" + quote(workspace, safe=""))
    try:
        with urllib.request.urlopen(url, data=b"", timeout=timeout) as r:
            return json.load(r).get("ok", False)
    except (OSError, ValueError):
        return False


def fmt_dur(sec):
    """44s, 12m 5s, 1h 0m 5s: units, like the page shows them."""
    sec = max(0, int(round(sec)))
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    parts = [(h, "h"), (m, "m"), (s, "s")] if h else [(m, "m"), (s, "s")] if m else [(s, "s")]
    while len(parts) > 1 and parts[-1][0] == 0:
        parts.pop()
    return " ".join(f"{v}{u}" for v, u in parts)


def fmt_bytes(n):
    for unit in ("B", "K", "M", "G"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" or n >= 10 \
                else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}T"


def resolve_workspace(arg):
    workspace = os.path.realpath(arg or ".")
    if not os.path.isdir(workspace):
        raise SystemExit(f"not a directory: {workspace}")
    return workspace


# -- systemd user service ----------------------------------------------------

SERVICE = "colcon-dashboard.service"

SERVICE_UNIT = """\
[Unit]
Description=Colcon Dashboard

[Service]
ExecStart={exe} -m colcon_dashboard
Restart=on-failure

[Install]
WantedBy=default.target
"""


def unit_path():
    return os.path.join(os.path.expanduser("~"), ".config", "systemd",
                        "user", SERVICE)


def systemctl(*args):
    try:
        return subprocess.run(["systemctl", "--user", *args]).returncode
    except OSError:  # no systemctl at all
        return 127


def user_systemd_works():
    """False in most containers and in WSL without systemd: there is no
    systemctl, or no user session bus to talk to."""
    if not shutil.which("systemctl"):
        return False
    try:
        return subprocess.run(["systemctl", "--user", "show-environment"],
                              stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        return False


def wait_for_server(deadline=6.0):
    """The server info once it answers, or None."""
    end = time.time() + deadline
    while time.time() < end:
        time.sleep(0.3)
        info = read_server()
        if probe_server(info):
            return info
    return None


def install_service():
    """Install and start the systemd user service."""
    if not user_systemd_works():
        raise SystemExit(
            "systemd user services do not work here (no systemctl, or no user\n"
            "session bus, as in many containers and in WSL without systemd).\n"
            "Run the server in a terminal instead:  colcon-dashboard\n"
            "or in the background:  nohup colcon-dashboard >/dev/null 2>&1 &")
    path = unit_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(SERVICE_UNIT.format(exe=sys.executable))
    print(f"wrote {path}")
    # the unit names this interpreter: after a reinstall from another
    # place (apt, pipx, a venv), run --install-service again
    print(f"the service runs: {sys.executable} -m colcon_dashboard")
    info = read_server()
    if probe_server(info):  # hand the lock to the service
        os.kill(info["pid"], signal.SIGTERM)
        time.sleep(0.5)
        print(f"stopped the running server (pid {info['pid']})")
    for cmd in (("daemon-reload",), ("enable", "--now", SERVICE)):
        if systemctl(*cmd) != 0:
            raise SystemExit(f"failed: systemctl --user {' '.join(cmd)}")
    created = None if CONFIG.exists else write_template(CONFIG.path)
    note = (" (new template; uncomment keys to set host, port, ...)"
            if created else "")
    print(f"config file: {CONFIG.path}{note}")
    info = wait_for_server()
    if info:
        print(f"service running: {server_url(info)}")
    else:
        print("the service started, but the server does not answer yet")


def uninstall_service():
    path = unit_path()
    if not os.path.exists(path):
        print("the service is not installed")
        return
    systemctl("disable", "--now", SERVICE)
    try:
        os.unlink(path)
    except OSError as exc:
        raise SystemExit(f"could not remove {path}: {exc}")
    systemctl("daemon-reload")
    print(f"removed {path}")


def require_service():
    if not os.path.exists(unit_path()):
        raise SystemExit(
            "the service is not installed; run --install-service first")


def service_verb(verb):
    require_service()
    if systemctl(verb, SERVICE) != 0:
        raise SystemExit(f"systemctl --user {verb} {SERVICE} failed")
    if verb in ("start", "restart"):
        info = wait_for_server()
        if info:
            print(f"service running: {server_url(info)}")
        else:
            print("the service started, but the server does not answer yet")
    else:
        print("service stopped")


def show_service_status():
    if os.path.exists(unit_path()):
        systemctl("status", "--no-pager", SERVICE)  # rc 3 when inactive
    else:
        print("the service is not installed")
    info = read_server()
    if probe_server(info):
        print(f"server answers: {server_url(info)} (pid {info['pid']})")
    else:
        print("the server does not answer")


# -- one-shot commands -------------------------------------------------------

def show_status(info, workspace):
    """Print what the page header shows, for terminals and scripts."""
    url = api_url(info, "/api/state?ws=" + quote(workspace, safe=""))
    state = None
    deadline = time.time() + 6
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                state = json.load(r)
        except (OSError, ValueError):
            raise SystemExit("the server does not answer")
        error = state.get("error", "")
        if state.get("build_id") and not error:
            break
        if error and "scanning" not in error \
                and not error.startswith("no events.log"):
            raise SystemExit(error)  # "no events.log yet" is transient
        time.sleep(0.2)
    if not state or not state.get("build_id"):
        raise SystemExit("the monitor produced no state in time")
    counts = state.get("counts") or {}
    done = counts.get("done", 0)
    failed = counts.get("failed", 0)
    total = state.get("total", 0)
    if state.get("active"):
        badge = "LIVE"
    elif failed:
        badge = "FAILED"
    elif done == total and total:
        badge = "COMPLETE"
    else:
        badge = "STOPPED"
    parts = [f"{done}/{total} done"]
    for key in ("building", "ready", "waiting", "blocked", "failed",
                "aborted", "skipped"):
        if counts.get(key):
            parts.append(f"{counts[key]} {key}")
    elapsed = state.get("elapsed") or 0
    rate = f"  ({done / (elapsed / 60):.1f} pkg/min)" if elapsed > 30 else ""
    print(f"workspace: {state.get('workspace', workspace)}")
    print(f"build:     {state.get('build_id')}  {badge}")
    print(f"packages:  {' · '.join(parts)}")
    print(f"elapsed:   {fmt_dur(elapsed)}{rate}")


def prune_cmd(info, alive, workspace, keep, log_base):
    keep = max(1, keep)
    if alive:
        # use the API only when the server confirms it watches the same
        # log dir; a mismatch, an older server (no /api/config), or an
        # error all prune locally, which is safe: the newest run of each
        # kind always survives, and that is where a live build writes
        try:
            with urllib.request.urlopen(api_url(info, "/api/config"),
                                        timeout=2) as r:
                server_base = json.load(r).get("log_base")
        except (OSError, ValueError):
            server_base = None
        if server_base != log_base:
            alive = False
    if alive:
        url = api_url(info, "/api/builds/prune?ws="
                      + quote(workspace, safe="") + f"&keep={keep}")
        req = urllib.request.Request(url, data=b"", method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                result = json.load(r)
        except (OSError, ValueError) as exc:
            raise SystemExit(f"prune failed: {exc}")
        if not result.get("ok"):
            raise SystemExit(f"prune failed: {result.get('error')}")
        deleted, freed = result["deleted"], result["freed"]
    else:
        log_dir = os.path.join(workspace, log_base)
        if not os.path.isdir(log_dir):
            raise SystemExit(f"no log directory: {log_dir}")
        failed = []
        names, freed = prune_builds(log_dir, keep, failed=failed)
        deleted = len(names)
        for name in failed:
            print(f"could not delete all of {name}: another user owns some files")
    print(f"deleted {deleted} runs, freed {fmt_bytes(freed)}")


EXAMPLES = """\
examples:
  colcon-dashboard .                 start the server (or reuse it) and open this workspace
  colcon-dashboard . --open          the same, and open it in the browser
  colcon-dashboard --install-service run the server at login, as a systemd user service
  colcon-dashboard --status          the build status of this workspace, in the terminal
  colcon-dashboard --prune --keep 5  delete all but the newest 5 builds and 5 test runs

The settings file is ~/.config/colcon-dashboard/config.ini. A flag always wins over it.
"""

# the actions: at most one per call
ACTIONS = ("stop", "stop_all", "list_workspaces", "status", "prune", "install_service",
           "uninstall_service", "start_service", "stop_service", "restart_service",
           "service_status")


def build_parser():
    ap = argparse.ArgumentParser(
        prog="colcon-dashboard",
        description="Colcon Dashboard - live colcon build dashboard",
        epilog=EXAMPLES, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workspace", nargs="?", default=None,
                    help="workspace to open (optional: the page can pick one)")
    ap.add_argument("--version", action="version",
                    version=f"colcon-dashboard {__version__}")
    srv = ap.add_argument_group("server")
    srv.add_argument("--open", action="store_true",
                     help="open the dashboard in the browser")
    srv.add_argument("--port", type=int, default=None,
                     help=f"HTTP port (default: {GLOBAL_PORT})")
    srv.add_argument("--host", default=None,
                     help="bind address (default: 127.0.0.1)")
    srv.add_argument("--log-base", default=None,
                     help="log directory relative to a workspace"
                          " (default: log)")
    srv.add_argument("--stop", action="store_true",
                     help="stop the dashboard server")
    srv.add_argument("--stop-all", action="store_true", help=argparse.SUPPRESS)
    srv.add_argument("--list", action="store_true", dest="list_workspaces",
                     help="list the known workspaces")
    srv.add_argument("--status", action="store_true",
                     help="print the workspace's build status and exit")
    mnt = ap.add_argument_group("maintenance")
    mnt.add_argument("--prune", action="store_true",
                     help="delete all but the newest runs of each kind"
                          " (see --keep)")
    mnt.add_argument("--keep", type=int, default=None,
                     help="how many runs of each kind --prune keeps"
                          " (default: 3)")
    svc = ap.add_argument_group("systemd user service")
    svc.add_argument("--install-service", action="store_true",
                     help="install and start the service, which starts the"
                          " server at login")
    svc.add_argument("--uninstall-service", action="store_true",
                     help="stop, disable, and remove the service")
    svc.add_argument("--start-service", action="store_true",
                     help="start the service")
    svc.add_argument("--stop-service", action="store_true",
                     help="stop the service")
    svc.add_argument("--restart-service", action="store_true",
                     help="restart the service (for example after a"
                          " config.ini change)")
    svc.add_argument("--service-status", action="store_true",
                     help="show the service status")
    return ap


def main():
    ap = build_parser()
    args = ap.parse_args()
    chosen = [a for a in ACTIONS if getattr(args, a)]
    if len(chosen) > 1:
        ap.error("choose one of: " + ", ".join(
            "--" + ("list" if a == "list_workspaces" else a.replace("_", "-"))
            for a in chosen))
    if args.keep is not None and not args.prune:
        ap.error("--keep works only with --prune")
    keep = args.keep if args.keep is not None else 3

    if args.install_service:
        return install_service()
    if args.uninstall_service:
        return uninstall_service()
    if args.start_service:
        return service_verb("start")
    if args.stop_service:
        return service_verb("stop")
    if args.restart_service:
        return service_verb("restart")
    if args.service_status:
        return show_service_status()

    host = args.host or CONFIG.host or "127.0.0.1"
    explicit_port = args.port if args.port is not None else CONFIG.port
    log_base = args.log_base or CONFIG.log_base or "log"

    info = read_server()
    alive = probe_server(info)

    if args.stop or args.stop_all:
        if alive:
            os.kill(info["pid"], signal.SIGTERM)
            print(f"stopped the dashboard server (pid {info['pid']})")
            if os.path.exists(unit_path()):
                print("the systemd service stays enabled and starts the"
                      " server again at login; use --stop-service or"
                      " --uninstall-service to manage it")
        else:
            print("no server runs")
        return

    if args.status:
        if not alive:
            raise SystemExit("no server runs")
        return show_status(info, resolve_workspace(args.workspace))

    if args.prune:
        return prune_cmd(info, alive, resolve_workspace(args.workspace),
                         keep, log_base)

    if args.list_workspaces:
        if alive:
            with urllib.request.urlopen(api_url(info, "/api/workspaces"),
                                        timeout=2) as r:
                entries = json.load(r).get("workspaces", [])
            print(f"server: {server_url(info)}  pid {info['pid']}")
            if CONFIG.exists:
                print(f"config: {CONFIG.path}")
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
        workspace = resolve_workspace(args.workspace)

    if alive:
        if workspace:
            register_workspace(info, workspace)
        print(f"already running: {server_url(info, workspace)}")
        # the running server keeps its own address: say so, not ignore it
        if args.port is not None and args.port != info.get("port"):
            print(f"note: --port {args.port} has no effect: the server already"
                  f" runs on port {info.get('port')}. Stop it first (--stop,"
                  " or --stop-service for the service).")
        if args.host is not None and args.host != info.get("host"):
            print(f"note: --host {args.host} has no effect: the server already"
                  f" binds {info.get('host')}. Stop it first.")
        if args.open:
            webbrowser.open(server_url(info, workspace))
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

    created = None if CONFIG.exists else write_template(CONFIG.path)

    ThreadingHTTPServer.daemon_threads = True  # a stop request must not hang
    port = explicit_port if explicit_port else GLOBAL_PORT
    try:
        server = ThreadingHTTPServer((host, port), Handler)
    except OSError:
        if explicit_port:
            where = "--port" if args.port is not None else CONFIG.path
            raise SystemExit(f"port {explicit_port} is in use ({where})")
        server = ThreadingHTTPServer((host, 0), Handler)  # any free port
        print(f"port {port} is in use: serving on port"
              f" {server.server_address[1]} instead")
    port = server.server_address[1]

    lock_file.seek(0)
    lock_file.truncate()
    json.dump({"host": host, "port": port, "pid": os.getpid()}, lock_file)
    lock_file.flush()

    registry = Registry(log_base)
    Handler.registry = registry
    if workspace:
        registry.monitor(workspace)
    if (CONFIG.auto_prune_keep and CONFIG.auto_prune_keep >= 1) or CONFIG.notify_command:
        # the headless service must watch builds to auto-prune them, and
        # to run the [notify] command when one ends
        for entry in list(registry.recents):
            if os.path.isdir(entry.get("path", "")):
                registry.monitor(entry["path"], touch=False)

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    info = {"host": host, "port": port}
    print("Colcon Dashboard")
    print(f"  url: {server_url(info)}")
    if created:
        print(f"  config: {created}  (new template)")
    if host in ("0.0.0.0", "::", ""):
        ip = lan_ip()
        if ip:
            print(f"  lan: http://{ip}:{port}/  (visible to your network)")
    if workspace:
        print(f"  workspace: {server_url(info, workspace)}")
    print("  stop: Ctrl+C, or colcon-dashboard --stop")
    if args.open:
        webbrowser.open(server_url(info, workspace))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.unlink(SERVER_FILE)
        except OSError:
            pass
