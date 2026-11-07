"""Desktop notifications from the server, with no dashboard page open.

The server sends them through notify-send (libnotify-bin), else through
gdbus (libglib2.0-bin). Both talk to the notification service of the
desktop session over D-Bus, so they work only on a machine with a
logged-in desktop: a headless build machine has no session bus, and
there the page sends the notifications from the browser instead.
"""

import os
import shutil
import subprocess
import threading

ICON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "icon-192.png")
APP_NAME = "Colcon Dashboard"
DESKTOP_ENTRY = "io.github.autowarefoundation.ColconDashboard"


def session_bus():
    """True when a D-Bus session bus exists for this user."""
    if os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        return True
    runtime = os.environ.get("XDG_RUNTIME_DIR") or "/run/user/%d" % os.getuid()
    return os.path.exists(os.path.join(runtime, "bus"))


def available():
    return session_bus() and bool(shutil.which("notify-send") or shutil.which("gdbus"))


_actions = None


def notify_send_has_actions():
    """libnotify 0.7.9 (Ubuntu 22.04) and newer: -A, and it waits."""
    global _actions
    if _actions is None:
        try:
            r = subprocess.run(["notify-send", "--help"], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, timeout=5)
            _actions = "--action" in r.stdout
        except (OSError, subprocess.SubprocessError):
            _actions = False
    return _actions


def command(title, body, urgent=False, action=False):
    """The command line that shows one notification, or None."""
    if shutil.which("notify-send"):
        cmd = ["notify-send", "-a", APP_NAME, "-i", ICON,
               "-u", "critical" if urgent else "normal",
               "-h", "string:desktop-entry:" + DESKTOP_ENTRY]
        if action:
            cmd += ["-A", "default=Open"]
        return cmd + ["--", title, body]
    if shutil.which("gdbus"):
        quote = lambda s: '"%s"' % s.replace("\\", "\\\\").replace('"', '\\"')
        return ["gdbus", "call", "--session", "--dest", "org.freedesktop.Notifications",
                "--object-path", "/org/freedesktop/Notifications",
                "--method", "org.freedesktop.Notifications.Notify",
                quote(APP_NAME), "0", quote(ICON), quote(title), quote(body),
                "[]", "{}", "-1"]
    return None


def send(title, body, urgent=False, on_click=None):
    """Show a notification. on_click runs when the user clicks it, where
    notify-send supports actions. Never blocks the caller."""
    action = on_click is not None and shutil.which("notify-send") is not None \
        and notify_send_has_actions()
    cmd = command(title, body, urgent, action)
    if cmd is None:
        return False

    def run():
        try:
            # with an action, notify-send waits until the notification
            # closes and prints the name of the clicked action
            r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True,
                               timeout=3600 if action else 30)
        except (OSError, subprocess.SubprocessError):
            return
        if action and r.stdout.strip() == "default":
            try:
                on_click()
            except Exception:  # a click must never take the server down
                pass
    threading.Thread(target=run, daemon=True).start()
    return True
