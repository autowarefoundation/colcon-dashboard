"""The desktop side: the --app launcher, the tray launcher, server
control for the tray, and the applications-menu entry.

colcon-dashboard --app starts the server when none answers, then opens
the dashboard in the browser that fits best (browser.py): the installed
dashboard app, an app window, or a browser window.

colcon-dashboard --tray shows the tray icon (tray.py). The tray needs
PyGObject (Gio, GLib, GdkPixbuf), which comes from apt, not from pip:

    sudo apt install python3-gi gir1.2-gdkpixbuf-2.0

A pipx or venv install cannot see it. Then launch_tray() runs the tray
under the system Python, with only this package on its path, and the
server commands still run under the install's own Python. This module
itself is standard library only. The server never imports it or tray.py.
"""

import os
import shutil
import subprocess
import sys
import time

from . import browser
from .cli import probe_server, read_server, register_workspace, server_url
from .registry import CACHE_DIR
from .service import APP_ID, SYSTEM_PYTHON, TRAY_CHECK, unit_known

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PKG_DIR, "data")
# the Python of the install, when the tray runs under the system Python
PYTHON_ENV = "COLCON_DASHBOARD_PYTHON"
SHIM_DIR = os.path.join(CACHE_DIR, "app-path")
APT_HINT = "sudo apt install python3-gi gir1.2-gdkpixbuf-2.0"


def gi_works(python=None):
    """True when python (default: this one) can run the tray."""
    if python is None:
        try:
            exec(TRAY_CHECK, {})
        except (ImportError, ValueError):  # no gi, or a missing typelib
            return False
        return True
    try:
        return subprocess.run([python, "-c", TRAY_CHECK], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        return False


def shim_path():
    """A directory that holds only this package, for another Python's
    path: the whole site-packages of a venv would shadow system modules."""
    os.makedirs(SHIM_DIR, exist_ok=True)
    link = os.path.join(SHIM_DIR, "colcon_dashboard")
    if os.path.realpath(link) != PKG_DIR:
        if os.path.lexists(link):
            os.unlink(link)
        os.symlink(PKG_DIR, link)
    return SHIM_DIR


def not_system_python():
    """True in a venv (pipx makes one) or under another interpreter. A
    venv Python links to the system binary, so the path alone cannot tell."""
    return (sys.prefix != sys.base_prefix
            or os.path.realpath(sys.executable) != os.path.realpath(SYSTEM_PYTHON))


def launch_tray():
    """Show the tray icon. Returns only when the tray quits."""
    if gi_works():
        from .tray import run
        return run()
    if os.path.exists(SYSTEM_PYTHON) and not_system_python() and gi_works(SYSTEM_PYTHON):
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            p for p in (shim_path(), env.get("PYTHONPATH")) if p)
        env.setdefault(PYTHON_ENV, sys.executable)
        os.execve(SYSTEM_PYTHON, [SYSTEM_PYTHON, "-m", "colcon_dashboard.tray"], env)
    raise SystemExit(f"the tray icon needs PyGObject. Install it with:\n  {APT_HINT}")


def open_app(workspace=None):
    """colcon-dashboard --app: start the server when none answers, then
    open the dashboard."""
    info = read_server()
    if not probe_server(info):
        ok, msg = start_server()
        if not ok:
            raise SystemExit(msg)
        info = read_server()
    if workspace:
        register_workspace(info, workspace)
    url = server_url(info, workspace)
    browser.open_dashboard(url)
    print(f"opened {url}")


# -- the server, seen from the tray --------------------------------------------

def cli_cmd(*args):
    """The colcon-dashboard command line, under the install's own Python."""
    return [os.environ.get(PYTHON_ENV) or sys.executable, "-m", "colcon_dashboard", *args]


def child_env():
    """The environment for server commands: without the shim, so the
    install's Python finds its own copy of the package."""
    env = dict(os.environ)
    parts = [p for p in env.get("PYTHONPATH", "").split(os.pathsep)
             if p and os.path.realpath(p) != os.path.realpath(SHIM_DIR)]
    if parts:
        env["PYTHONPATH"] = os.pathsep.join(parts)
    else:
        env.pop("PYTHONPATH", None)
    env.pop(PYTHON_ENV, None)
    return env


def run_cli(*args, timeout=30):
    """Run a command line action. Returns (ok, the last output line)."""
    try:
        r = subprocess.run(cli_cmd(*args), env=child_env(), timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           stdin=subprocess.DEVNULL, text=True)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    return r.returncode == 0, lines[-1] if lines else ""


def wait_alive(alive, deadline=10.0):
    end = time.time() + deadline
    while time.time() < end:
        if probe_server(read_server()) == alive:
            return True
        time.sleep(0.25)
    return False


def start_server():
    """Through the service when systemd knows it, else in the background,
    where the server outlives the caller. Returns (ok, message)."""
    if unit_known():
        ok, msg = run_cli("--start-service")
        return (ok and wait_alive(True)), msg
    os.makedirs(CACHE_DIR, exist_ok=True)
    log_path = os.path.join(CACHE_DIR, "server.log")
    log = open(log_path, "ab")
    try:
        subprocess.Popen(cli_cmd(), env=child_env(), stdin=subprocess.DEVNULL,
                         stdout=log, stderr=subprocess.STDOUT,
                         start_new_session=True)
    except OSError as exc:
        return False, str(exc)
    finally:
        log.close()
    if wait_alive(True):
        return True, "the server runs"
    return False, f"the server did not answer; see {log_path}"


def stop_server():
    """Stop the server. The service stays enabled for the next login."""
    if unit_known():
        ok, msg = run_cli("--stop-service")
    else:
        ok, msg = run_cli("--stop")
    return (ok and wait_alive(False)), msg


def restart_server():
    if unit_known():
        ok, msg = run_cli("--restart-service")
        return (ok and wait_alive(True)), msg
    ok, msg = stop_server()
    return start_server() if ok else (ok, msg)


# -- the app-menu entry --------------------------------------------------------

def data_home():
    return os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share")


def entry_path():
    return os.path.join(data_home(), "applications", APP_ID + ".desktop")


def icon_path():
    return os.path.join(data_home(), "icons", "hicolor", "scalable", "apps", APP_ID + ".svg")


def desktop_entry(exe):
    """The packaged entry, with Exec pointed at exe: a pipx or venv
    script is often not on the PATH of the desktop session."""
    with open(os.path.join(DATA_DIR, APP_ID + ".desktop")) as f:
        text = f.read()
    return text.replace("Exec=colcon-dashboard ", f"Exec={exe} ")


def command_path():
    """The absolute path of the colcon-dashboard command that runs now."""
    found = shutil.which("colcon-dashboard")
    script = os.path.abspath(sys.argv[0]) if sys.argv and sys.argv[0] else None
    if script and os.path.basename(script) == "colcon-dashboard" and os.access(script, os.X_OK):
        return script
    return found or "colcon-dashboard"


def install_desktop():
    for path in (entry_path(), icon_path()):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(entry_path(), "w") as f:
        f.write(desktop_entry(command_path()))
    shutil.copyfile(os.path.join(DATA_DIR, APP_ID + ".svg"), icon_path())
    print(f"wrote {entry_path()}\nwrote {icon_path()}")
    for cmd in (["update-desktop-database", os.path.dirname(entry_path())],
                ["gtk-update-icon-cache", "-qtf", os.path.join(data_home(), "icons", "hicolor")]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("Colcon Dashboard is now in the applications menu. It opens the dashboard"
          " in your browser.")


def uninstall_desktop():
    removed = False
    for path in (entry_path(), icon_path()):
        if os.path.exists(path):
            os.unlink(path)
            print(f"removed {path}")
            removed = True
    if not removed:
        print("the applications menu entry is not installed")
