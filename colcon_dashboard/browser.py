"""Open the dashboard in the browser that fits it best.

The order of tries:

1. The dashboard app that a Chromium-family browser installed. Its
   manifest asks the browser to focus the open window, not to open a
   second one.
2. A Chromium-family browser with --app=URL: a window with no tabs and
   no address bar.
3. Firefox in a new window. Firefox cannot install the dashboard yet on
   most Linux systems.
4. The default browser, through Python's webbrowser module.

The default browser of the desktop (xdg-settings) decides between 1-2
and 3, so a Firefox user never gets Chrome only because Chrome exists.
The [ui] browser key of config.ini overrides the guess: auto, chromium,
firefox, or default. Standard library only: the server uses this for
clicks on notifications, and the tray and --app use it too.
"""

import configparser
import glob
import os
import shlex
import shutil
import subprocess
import webbrowser
from urllib.parse import urlparse

from .config import CONFIG

APP_NAME = "Colcon Dashboard"
CHROMIUM = ("chrom", "brave", "edge", "vivaldi", "opera")
GECKO = ("firefox", "librewolf", "waterfox", "floorp")
CHROMIUM_BINS = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                 "brave-browser", "microsoft-edge", "vivaldi")


def app_dirs():
    """The directories of .desktop files, the user's first."""
    home = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local",
                                                           "share")
    dirs = [home] + (os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":")
    dirs += ["/var/lib/snapd/desktop", "/var/lib/flatpak/exports/share",
             os.path.join(home, "flatpak", "exports", "share")]
    out = []
    for d in dirs:
        path = os.path.join(d, "applications")
        if d and path not in out:
            out.append(path)
    return out


def read_entry(path):
    """The [Desktop Entry] section of a .desktop file as a dict."""
    cp = configparser.ConfigParser(interpolation=None, strict=False)
    cp.optionxform = str
    try:
        cp.read(path, encoding="utf-8")
        return dict(cp["Desktop Entry"])
    except (configparser.Error, KeyError, OSError, UnicodeDecodeError):
        return {}


def entry_argv(entry):
    """The Exec line as a list, without the %U-style field codes."""
    try:
        argv = shlex.split(entry.get("Exec", ""))
    except ValueError:
        return []
    return [a for a in argv if not (a.startswith("%") or a.startswith("@@"))]


def kind_of(name, argv=()):
    """chromium, firefox, or other, from an entry name or a command."""
    text = " ".join([name, *(os.path.basename(a) for a in argv[:3])]).lower()
    if any(k in text for k in GECKO):
        return "firefox"
    if any(k in text for k in CHROMIUM):
        return "chromium"
    return "other"


def default_browser():
    """(kind, argv) of the desktop's default browser, or ("other", [])."""
    try:
        name = subprocess.run(["xdg-settings", "get", "default-web-browser"],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        name = ""
    if not name:
        return "other", []
    for d in app_dirs():
        path = os.path.join(d, name)
        if os.path.exists(path):
            argv = entry_argv(read_entry(path))
            return kind_of(name, argv), argv
    return kind_of(name), []


def installed_app():
    """The launch command of the dashboard app that a Chromium-family
    browser installed, or None. Chrome writes its entry as, for example,
    ~/.local/share/applications/chrome-<id>-Default.desktop."""
    for d in app_dirs()[:1]:
        for path in sorted(glob.glob(os.path.join(d, "*.desktop"))):
            entry = read_entry(path)
            argv = entry_argv(entry)
            if entry.get("Name") == APP_NAME and any(a.startswith("--app-id=") for a in argv):
                return argv
    return None


def spawn(argv):
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
        return True
    except OSError:
        return False


def chromium_argv():
    for name in CHROMIUM_BINS:
        path = shutil.which(name)
        if path:
            return [path]
    return None


def plan(url, preference=None, default=None, app=None):
    """The command that opens url, or None for the webbrowser module.
    The arguments after url exist for the tests."""
    preference = (preference or CONFIG.browser or "auto").lower()
    if preference == "default":
        return None
    if preference == "chromium":
        kind, argv = "chromium", chromium_argv() or []
    elif preference == "firefox":
        kind, argv = "firefox", [shutil.which("firefox") or "firefox"]
    else:
        kind, argv = default if default is not None else default_browser()
    if kind == "chromium":
        app = app if app is not None else installed_app()
        if app:
            # a workspace link opens in the app; the page takes it from
            # window.launchQueue when the app focuses its open window
            if urlparse(url).query:
                return app + ["--app-launch-url-for-shortcuts-menu-item=" + url]
            return app
        if argv:
            return argv + ["--app=" + url]
    if kind == "firefox" and argv:
        return argv + ["--new-window", url]
    return None


def open_dashboard(url, preference=None):
    """Open url, the dashboard address. Returns True when something ran."""
    argv = plan(url, preference)
    if argv and spawn(argv):
        return True
    return webbrowser.open(url)
