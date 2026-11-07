"""The systemd user service and the tray's autostart entry.

The CLI (--install-service and the other service commands) and the
settings dialog of the page (through web.py) both use this module. It
is standard library only and never imports GTK or PyGObject.

The service unit can come from two places. --install-service writes
~/.config/systemd/user/colcon-dashboard.service, and the deb package
installs /usr/lib/systemd/user/colcon-dashboard.service and enables it
for every user. A user unit file overrides the package unit.
"""

import os
import shutil
import subprocess
import sys

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

APP_ID = "io.github.autowarefoundation.ColconDashboard"
TRAY_ID = APP_ID + ".Tray"

TRAY_ENTRY = """\
[Desktop Entry]
Type=Application
Name=Colcon Dashboard Tray
Comment=The tray icon of Colcon Dashboard
Exec={exe} -m colcon_dashboard --tray
Icon={app_id}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
"""

# the tray speaks D-Bus through PyGObject: Gio, GLib, and GdkPixbuf
TRAY_CHECK = ("import gi; gi.require_version('GdkPixbuf', '2.0');"
              " from gi.repository import GdkPixbuf, Gio, GLib")
SYSTEM_PYTHON = "/usr/bin/python3"


def unit_path():
    return os.path.join(os.path.expanduser("~"), ".config", "systemd",
                        "user", SERVICE)


def systemctl(*args, quiet=False):
    """Run systemctl --user. Returns the exit code (127: no systemctl)."""
    out = subprocess.DEVNULL if quiet else None
    try:
        return subprocess.run(["systemctl", "--user", *args],
                              stdout=out, stderr=out).returncode
    except OSError:
        return 127


def systemctl_out(*args):
    """The output of systemctl --user, stripped, or "" on a failure."""
    try:
        r = subprocess.run(["systemctl", "--user", *args], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip()


def user_systemd_works():
    """False in most containers and in WSL without systemd: there is no
    systemctl, or no user session bus to talk to."""
    if not shutil.which("systemctl"):
        return False
    return systemctl("show-environment", quiet=True) == 0


# where a package installs user units (systemd.unit(5))
PACKAGE_UNIT_DIRS = ("/etc/systemd/user", "/usr/local/lib/systemd/user",
                     "/usr/lib/systemd/user", "/lib/systemd/user")


def unit_known():
    """True when the unit exists: the user's or the package's. Right
    after an apt install, systemd sees it only after a daemon-reload."""
    if os.path.exists(unit_path()):
        return True
    if any(os.path.exists(os.path.join(d, SERVICE)) for d in PACKAGE_UNIT_DIRS):
        return True
    if not shutil.which("systemctl"):
        return False
    return systemctl_out("show", "-p", "LoadState", "--value", SERVICE) == "loaded"


def reload_if_unseen():
    """A daemon-reload when systemd does not see the unit yet."""
    if systemctl_out("show", "-p", "LoadState", "--value", SERVICE) != "loaded":
        systemctl("daemon-reload", quiet=True)


def login_enabled():
    """True when the service starts at login."""
    return systemctl_out("is-enabled", SERVICE) in ("enabled", "enabled-runtime")


def under_service():
    """True when this process runs as the systemd user service."""
    try:
        with open("/proc/self/cgroup") as f:
            return "/" + SERVICE in f.read()
    except OSError:
        return False


def write_unit(exe=None):
    path = unit_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(SERVICE_UNIT.format(exe=exe or sys.executable))
    return path


def set_login(on):
    """Make the service start at login, or stop that. It does not start
    or stop the server that runs now. Returns (ok, message)."""
    if not user_systemd_works():
        return False, "systemd user services do not work on this machine"
    if on:
        if not unit_known():
            write_unit()
        reload_if_unseen()
        if systemctl_out("is-enabled", SERVICE) == "masked":
            systemctl("unmask", SERVICE, quiet=True)
        systemctl("enable", SERVICE, quiet=True)
        return login_enabled(), "the server starts at login"
    systemctl("disable", SERVICE, quiet=True)
    if login_enabled():
        # the deb package enables the unit for all users: only a mask
        # turns it off for one user, and a mask needs the user unit gone
        if os.path.exists(unit_path()):
            return False, ("the package starts the server for all users. Remove "
                           f"{unit_path()} (colcon-dashboard --uninstall-service), "
                           "then switch this off")
        systemctl("mask", SERVICE, quiet=True)
    return not login_enabled(), "the server no longer starts at login"


def restart_unit():
    """Ask systemd to restart the service, without waiting: the caller
    can be the service itself, which the restart ends."""
    return systemctl("--no-block", "restart", SERVICE, quiet=True) == 0


# -- the tray ----------------------------------------------------------------

def autostart_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config")
    return os.path.join(base, "autostart", TRAY_ID + ".desktop")


def tray_autostart():
    return os.path.exists(autostart_path())


def gi_python(exe=None):
    """A Python that can run the tray, or None: this one, else the
    system Python (a pipx or venv install cannot see apt's PyGObject)."""
    for python in (exe or sys.executable, SYSTEM_PYTHON):
        try:
            if subprocess.run([python, "-c", TRAY_CHECK], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=20).returncode == 0:
                return python
        except (OSError, subprocess.SubprocessError):
            continue
    return None


_tray_supported = None


def tray_supported():
    """True when some Python here has PyGObject. Cached: it costs a
    subprocess, and an apt install meanwhile is rare."""
    global _tray_supported
    if _tray_supported is None:
        _tray_supported = gi_python() is not None
    return _tray_supported


def set_tray_autostart(on):
    """Write or remove the autostart entry. With on, also start the tray
    now. Returns (ok, message)."""
    path = autostart_path()
    if not on:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            return False, str(exc)
        return True, "the tray icon no longer starts at login"
    if not tray_supported():
        return False, "the tray icon needs PyGObject: sudo apt install python3-gi"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(TRAY_ENTRY.format(exe=sys.executable, app_id=APP_ID))
    start_tray()
    return True, "the tray icon starts at login"


def start_tray():
    """Start the tray now, apart from this process. In the service, a
    plain child would end with every service restart, so systemd-run
    gives the tray a unit of its own."""
    cmd = [sys.executable, "-m", "colcon_dashboard", "--tray"]
    if under_service() and shutil.which("systemd-run"):
        cmd = ["systemd-run", "--user", "--quiet", "--collect", "--unit",
               "colcon-dashboard-tray-%d" % os.getpid(), *cmd]
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return False
    return True
