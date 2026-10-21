"""The desktop app: launch, server control, and the app-menu entry.

The window itself lives in gui.py and needs GTK 4, libadwaita, and
WebKitGTK 6.0 through PyGObject. Those come from apt, not from pip:

    sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-webkit-6.0

A pipx or venv install cannot see them. Then launch() runs the app under
the system Python, with only this package on its path, and the server
commands still run under the install's own Python. This module itself
is standard library only; the server never imports it or gui.py.
"""

import os
import shutil
import subprocess
import sys
import time

from .cli import probe_server, read_server, server_url, unit_path, user_systemd_works
from .registry import CACHE_DIR

APP_ID = "io.github.autowarefoundation.ColconDashboard"
PKG_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PKG_DIR, "data")
SYSTEM_PYTHON = "/usr/bin/python3"
# the Python of the install, when the app runs under the system Python
PYTHON_ENV = "COLCON_DASHBOARD_PYTHON"
SHIM_DIR = os.path.join(CACHE_DIR, "app-path")
APT_HINT = ("sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1"
            " gir1.2-webkit-6.0")
GI_CHECK = ("import gi; gi.require_version('Gtk', '4.0');"
            " gi.require_version('Adw', '1'); gi.require_version('WebKit', '6.0');"
            " from gi.repository import Adw, Gtk, WebKit")


def gi_problem():
    """None when this Python can show the window, else the reason."""
    try:
        exec(GI_CHECK, {})
    except (ImportError, ValueError) as exc:  # no gi, or a missing typelib
        return str(exc)
    return None


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


def launch(workspace=None):
    """Show the app window. Returns only when the window closes."""
    problem = gi_problem()
    if problem is None:
        from .gui import run
        return run(workspace)
    if (os.path.exists(SYSTEM_PYTHON) and not_system_python()
            and subprocess.run([SYSTEM_PYTHON, "-c", GI_CHECK],
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL).returncode == 0):
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            p for p in (shim_path(), env.get("PYTHONPATH")) if p)
        env.setdefault(PYTHON_ENV, sys.executable)
        args = [SYSTEM_PYTHON, "-m", "colcon_dashboard.gui"]
        os.execve(SYSTEM_PYTHON, args + ([workspace] if workspace else []), env)
    raise SystemExit(
        f"the desktop app needs GTK 4, libadwaita, and WebKitGTK 6.0 ({problem}).\n"
        f"Install them with:\n  {APT_HINT}\n"
        "or open the dashboard in a browser:  colcon-dashboard --open")


# -- the server, seen from the app ---------------------------------------------

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


def service_installed():
    return os.path.exists(unit_path())


def server_status():
    """What the app shows: does a server answer, where, and who runs it."""
    info = read_server()
    alive = probe_server(info)
    return {
        "alive": alive,
        "url": server_url(info) if alive else None,
        "pid": info.get("pid") if alive else None,
        "service": service_installed(),
        "systemd": user_systemd_works(),
    }


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
    """Through the service when it is installed, else in the background,
    where the server outlives the window. Returns (ok, message)."""
    if service_installed():
        ok, msg = run_cli("--start-service")
        return (ok and wait_alive(True)), msg
    os.makedirs(CACHE_DIR, exist_ok=True)
    log = open(os.path.join(CACHE_DIR, "server.log"), "ab")
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
    return False, f"the server did not answer; see {os.path.join(CACHE_DIR, 'server.log')}"


def stop_server():
    if service_installed():
        ok, msg = run_cli("--stop-service")
    else:
        ok, msg = run_cli("--stop")
    return (ok and wait_alive(False)), msg


def restart_server():
    if service_installed():
        ok, msg = run_cli("--restart-service")
        return (ok and wait_alive(True)), msg
    ok, msg = stop_server()
    return start_server() if ok else (ok, msg)


def set_start_at_login(on):
    """Install or remove the systemd user service."""
    if on and not user_systemd_works():
        return False, "systemd user services do not work on this machine"
    ok, msg = run_cli("--install-service" if on else "--uninstall-service", timeout=60)
    return ok, msg


# -- the app-menu entry --------------------------------------------------------

def data_home():
    return os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share")


def entry_path():
    return os.path.join(data_home(), "applications", APP_ID + ".desktop")


def icon_path():
    return os.path.join(data_home(), "icons", "hicolor", "scalable", "apps", APP_ID + ".svg")


def system_entry():
    """The entry that the deb package installs, or None."""
    for base in ("/usr/share", "/usr/local/share"):
        path = os.path.join(base, "applications", APP_ID + ".desktop")
        if os.path.exists(path):
            return path
    return None


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
    print("Colcon Dashboard is now in the applications menu")
    if gi_problem() and subprocess.run(
            [SYSTEM_PYTHON, "-c", GI_CHECK], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL).returncode != 0:
        print(f"the app needs GTK 4, libadwaita, and WebKitGTK 6.0:\n  {APT_HINT}")


def uninstall_desktop():
    removed = False
    for path in (entry_path(), icon_path()):
        if os.path.exists(path):
            os.unlink(path)
            print(f"removed {path}")
            removed = True
    if not removed:
        print("the applications menu entry is not installed")


def desktop_installed():
    return os.path.exists(entry_path()) or system_entry() is not None
