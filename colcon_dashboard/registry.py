"""One server per machine: the workspace registry and discovery.

Holds a BuildMonitor per (workspace, pinned build), the persisted recents
list, and the home-directory scan for colcon workspaces.
"""

import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import quote

from . import __version__, browser, notify
from .config import CONFIG
from .events import BUILD_DIR_RE, parse_build_id_time, run_start_time
from .monitor import BuildMonitor
from .remote import (RemoteBuildMonitor, canonical_workspace,
                     parse_remote_workspace)

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache",
                         "colcon-dashboard")
SERVER_FILE = os.path.join(CACHE_DIR, "server.json")
REGISTRY_FILE = os.path.join(CACHE_DIR, "workspaces.json")
GLOBAL_PORT = 8642
NOTIFY_MODES = ("off", "on", "sound")


class Registry:
    """Monitors for any number of workspaces, plus the recents list."""

    def __init__(self, log_base="log"):
        self.log_base = log_base
        self.lock = threading.Lock()
        self.monitors = {}
        self.stats_cache = {}
        try:
            with open(REGISTRY_FILE) as f:
                self.recents = json.load(f)
        except (OSError, ValueError):
            self.recents = []
        self.base_url = None  # set in main(): what a click on a notification opens
        self.notify_mode = self._load_notify()

    def _save(self):
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(REGISTRY_FILE, "w") as f:
                json.dump(self.recents, f)
        except OSError:
            pass

    def touch(self, ws):
        with self.lock:
            head = self.recents[0] if self.recents else None
            if head and head["path"] == ws and \
                    time.time() - head["last_used"] < 60:
                return
            old = next((r for r in self.recents if r["path"] == ws), None)
            self.recents = [r for r in self.recents if r["path"] != ws]
            entry = {"path": ws, "last_used": time.time()}
            if old and old.get("fav"):
                entry["fav"] = True
            self.recents.insert(0, entry)
            del self.recents[24:]
            self._save()

    def set_favorite(self, ws, fav):
        with self.lock:
            for r in self.recents:
                if r["path"] == ws:
                    r["fav"] = bool(fav)
                    break
            else:
                self.recents.insert(
                    0, {"path": ws, "last_used": time.time(),
                        "fav": bool(fav)})
            self._save()

    def stats(self, ws):
        """Build count, log size, and last build time, cached briefly."""
        now = time.time()
        cached = self.stats_cache.get(ws)
        if cached and now - cached[0] < 60:
            return cached[1]
        out = {"builds": 0, "log_size": 0, "last_build": None,
               "last_outcome": None}
        log_dir = os.path.join(ws, self.log_base)
        newest = newest_name = None
        try:
            for name in os.listdir(log_dir):
                if name.startswith("build_"):
                    out["builds"] += 1
                    t = parse_build_id_time(name)
                    if t and (newest is None or t > newest):
                        newest, newest_name = t, name
        except OSError:
            pass
        if newest_name:
            # the newest name, as in the run list, but its real start:
            # a container run names itself in its own time zone
            out["last_build"] = run_start_time(os.path.join(log_dir, newest_name))
            # only the outcome the monitor already cached: a cold
            # events.log pass per listed workspace costs too much here
            try:
                with open(os.path.join(log_dir, newest_name,
                                       BuildMonitor.OUTCOME_FILE)) as f:
                    info = json.load(f)
                if info.get("v") == BuildMonitor.OUTCOME_V:
                    out["last_outcome"] = info.get("outcome")
            except (OSError, ValueError, AttributeError):
                pass
        total = 0
        for dirpath, _dirnames, filenames in os.walk(log_dir):
            for fn in filenames:
                try:
                    total += os.stat(os.path.join(dirpath, fn)).st_size
                except OSError:
                    pass
        out["log_size"] = total
        self.stats_cache[ws] = (now, out)
        return out

    def monitor(self, ws, build=None, touch=True):
        remote = None
        try:
            remote = parse_remote_workspace(ws)
            ws = remote.uri if remote else canonical_workspace(ws)
        except (OSError, ValueError, TypeError):
            return None
        if remote is None and not os.path.isdir(ws):
            return None
        if build and not BUILD_DIR_RE.fullmatch(build):
            return None
        key = (ws, build)
        with self.lock:
            self._stop_idle_pinned()
            mon = self.monitors.get(key)
            if mon is None:
                mon = (RemoteBuildMonitor(remote, self.log_base, pin_build=build)
                       if remote else
                       BuildMonitor(ws, self.log_base, pin_build=build))
                if build is None:
                    mon.on_prune = (lambda deleted, ws=ws:
                                    self._auto_pruned(ws, deleted))
                    mon.on_event = (lambda kind, data, ws=ws:
                                    self._build_event(ws, kind, data))
                self.monitors[key] = mon
                threading.Thread(target=mon.run, daemon=True).start()
        if touch:
            self.touch(ws)
        return mon

    PINNED_IDLE = 600  # seconds without a request before a pinned monitor stops

    def _stop_idle_pinned(self):
        """A monitor for an old build (opened from the build picker) keeps a
        thread and a log buffer. Stop it when nobody asked for it for a
        while; the next request starts a fresh one. Call with self.lock."""
        now = time.time()
        for key, mon in list(self.monitors.items()):
            if key[1] is not None and now - mon.last_request > self.PINNED_IDLE:
                del self.monitors[key]
                mon.stop()

    def _auto_pruned(self, ws, deleted):
        """After a monitor auto-prunes: mirror the manual-prune cleanup."""
        for name in deleted:
            self.drop_pinned(ws, name)
        self.stats_cache.pop(ws, None)

    def drop_pinned(self, ws, build):
        with self.lock:
            mon = self.monitors.pop((ws, build), None)
        if mon is not None:
            mon.stop()  # its scan thread ends on the next tick
        return mon is not None

    # -- desktop notifications from the server ----------------------------
    # A page on this machine hands its bell to the server (notify.js), so
    # that the notifications come also with no page open. None: no page
    # chose yet.

    @staticmethod
    def _notify_file():
        return os.path.join(CACHE_DIR, "notify.json")

    def _load_notify(self):
        try:
            with open(self._notify_file()) as f:
                mode = json.load(f).get("mode")
        except (OSError, ValueError, AttributeError):
            return None
        return mode if mode in NOTIFY_MODES else None

    def set_notify_mode(self, mode):
        if mode not in NOTIFY_MODES:
            return False
        self.notify_mode = mode
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(self._notify_file(), "w") as f:
                json.dump({"mode": mode}, f)
        except OSError:
            pass
        if self.notifying():
            self.watch_recents()
        return True

    def notifying(self):
        return self.notify_mode in ("on", "sound")

    def watch_recents(self):
        """Watch every recent workspace, also with no page open: auto-prune,
        the [notify] command, and the desktop notifications need it."""
        for entry in list(self.recents):
            path = entry.get("path", "")
            if parse_remote_workspace(path) or os.path.isdir(path):
                self.monitor(entry["path"], touch=False)

    def _build_event(self, ws, kind, data):
        if not self.notifying() or not notify.available():
            return
        name = os.path.basename(ws) or "colcon"
        if kind == "failed":
            title, body = f"✗ {data['name']} failed", f"the first failure in {name}"
        else:
            c, total = data["counts"], data["total"]
            if not total:
                return
            if c.get("failed"):
                title, body = f"✗ {name}: build failed", f"{c['failed']} of {total} packages failed"
            elif c.get("done", 0) == total:
                mins, secs = divmod(int(round(data["elapsed"] or 0)), 60)
                took = f"{mins}m {secs}s" if mins else f"{secs}s"
                title, body = f"✓ {name}: build complete", f"{total} packages in {took}"
            else:
                title = f"◌ {name}: build stopped"
                body = f"{c.get('done', 0)}/{total} done, {c.get('aborted', 0)} aborted"
        url = self.base_url and self.base_url + "?ws=" + quote(ws, safe="")
        notify.send(title, body, urgent=title.startswith("✗"),
                    on_click=(lambda: browser.open_dashboard(url)) if url else None)

    def test_notify(self):
        return notify.send("Colcon Dashboard", "Notifications work.",
                           on_click=(lambda: browser.open_dashboard(self.base_url))
                           if self.base_url else None)

    def busy(self, grace):
        """True while a restart would cut off work: an AI analysis runs,
        or a watched build runs or wrote its log less than grace seconds
        ago. The notification, the [notify] command, and the prune run
        right after the end of a build."""
        with self.lock:
            monitors = list(self.monitors.values())
        for mon in monitors:
            with mon.lock:
                analyses = list(mon.analyses.values())
            if any(a.running for a in analyses):
                return True
        now = time.time()
        for w in self.live():
            if w["active"]:
                return True
            if not w["build_id"]:
                continue
            if parse_remote_workspace(w["path"]):
                continue
            log = os.path.join(w["path"], self.log_base, w["build_id"], "events.log")
            try:
                if now - os.stat(log).st_mtime < grace:
                    return True
            except OSError:
                pass
        return False

    def live(self):
        """The watched workspaces and their builds, cheap enough for the
        tray to ask every few seconds (overview() reads the log sizes)."""
        with self.lock:
            monitors = [(k[0], m) for k, m in self.monitors.items() if k[1] is None]
        out = []
        for ws, mon in monitors:
            try:
                with mon.lock:
                    state = json.loads(mon.state_json)
            except ValueError:
                continue
            counts = state.get("counts") or {}
            out.append({"path": ws, "build_id": state.get("build_id"),
                        "active": bool(state.get("active")), "total": state.get("total") or 0,
                        "done": counts.get("done", 0), "failed": counts.get("failed", 0)})
        out.sort(key=lambda e: (not e["active"], e["path"]))
        return out

    def last_workspace(self):
        """The most recently viewed workspace that still exists, or None.
        Every page request with a workspace moves it to the front."""
        with self.lock:
            recents = list(self.recents)
        for entry in recents:
            path = entry.get("path", "")
            if parse_remote_workspace(path) or os.path.isdir(path):
                return entry["path"]
        return None

    def overview(self):
        with self.lock:
            recents = [dict(r) for r in self.recents]
            monitors = dict(self.monitors)
        out = []
        for r in recents:
            remote = parse_remote_workspace(r["path"])
            entry = {"path": r["path"], "last_used": r.get("last_used"),
                     "fav": bool(r.get("fav")),
                     "exists": True if remote else os.path.isdir(r["path"])}
            if remote:
                entry["remote"] = {
                    "scheme": remote.scheme, "host": remote.host,
                    "container": remote.container, "path": remote.path,
                }
            elif entry["exists"]:
                entry.update(self.stats(r["path"]))
            mon = monitors.get((r["path"], None))
            if mon is not None:
                try:
                    with mon.lock:
                        state = json.loads(mon.state_json)
                    entry["build_id"] = state.get("build_id")
                    entry["active"] = state.get("active")
                    entry["done"] = (state.get("counts") or {}).get("done")
                    entry["total"] = state.get("total")
                except ValueError:
                    pass
            out.append(entry)
        # building right now first, then favorites, then the recently used
        out.sort(key=lambda e: (not e.get("active"), not e["fav"],
                                -(e.get("last_used") or 0)))
        return {"workspaces": out}


PYPI_URL = "https://pypi.org/pypi/colcon-dashboard/json"
DEB_PACKAGE = "python3-colcon-dashboard"
DEB_DIR = "/usr/lib/python3/dist-packages"
PKG_DIR = os.path.dirname(os.path.abspath(__file__))
# seconds between checks: PyPI is a network request, and apt-cache only
# reads the package lists that apt refreshes by itself
UPDATE_INTERVAL = {"pypi": 86400, "apt": 3600}
UPGRADE_COMMAND = {
    "apt": f"sudo apt install --only-upgrade {DEB_PACKAGE}",
    "pipx": "pipx upgrade colcon-dashboard",
    # the pip of this Python: a venv install is not on PATH, and the
    # system pip refuses or installs into ~/.local instead
    "pip": "%s -m pip install --upgrade colcon-dashboard"
           % shlex.quote(sys.executable or "python3"),
}
_update_thread = None


def install_source():
    """How this copy was installed: "apt" (the deb package), "pipx", or
    "pip" (pip, a venv, or a source checkout)."""
    if os.path.realpath(PKG_DIR).startswith(DEB_DIR + os.sep):
        return "apt"
    if f"{os.sep}pipx{os.sep}venvs{os.sep}" in sys.prefix + os.sep:
        return "pipx"
    return "pip"


def update_check_on():
    """check_updates from config.ini. When it is unset, the deb package
    checks and other installs do not: apt-cache sends nothing over the
    network, and a PyPI request does."""
    if CONFIG.check_updates is not None:
        return CONFIG.check_updates
    return install_source() == "apt"


def _ver_key(version):
    nums = [int(x) for x in re.findall(r"\d+", version or "")[:3]]
    return tuple(nums + [0] * (3 - len(nums)))


def _upstream(deb_version):
    """0.11.2 from the deb version 0.11.2ppa1~ubuntu24.04.1; None from
    "(none)", the answer of apt-cache for an unknown package."""
    m = re.match(r"(?:\d+:)?(\d+(?:\.\d+)*)", deb_version or "")
    return m.group(1) if m else None


def _apt_candidate():
    """The version that an apt upgrade installs, from the local package
    lists. LC_ALL=C, because apt-cache translates the field names."""
    try:
        out = subprocess.run(
            ["apt-cache", "policy", DEB_PACKAGE], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=dict(os.environ, LC_ALL="C"), timeout=30, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(rb"^\s*Candidate:\s*(\S+)", out, re.M)
    return _upstream(m.group(1).decode("ascii", "replace")) if m else None


def _disk_version():
    """__version__ of the files on disk. An upgrade replaces them under
    a running server, and the server keeps the old code until it
    restarts."""
    try:
        with open(os.path.join(PKG_DIR, "__init__.py")) as f:
            m = re.search(r"""__version__\s*=\s*["']([^"']+)""", f.read())
    except OSError:
        return None
    return m.group(1) if m else None


def _read_update():
    try:
        with open(os.path.join(CACHE_DIR, "update.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _check_update_now(source):
    """Ask apt or PyPI for the newest version and cache the answer.
    Returns the answer, or None when the check failed."""
    data = {"checked_at": time.time(), "source": source}
    latest = None
    if source == "apt":
        latest = _apt_candidate()
    else:
        try:
            with urllib.request.urlopen(PYPI_URL, timeout=6) as r:
                latest = json.load(r)["info"]["version"]
        except (OSError, ValueError, KeyError):
            pass
    fresh = latest
    if latest is None:
        old = _read_update()  # keep a stale answer over none
        if old and old.get("source", "pypi") == source:
            latest = old.get("latest")
    if latest:
        data["latest"] = latest
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(os.path.join(CACHE_DIR, "update.json"), "w") as f:
            json.dump(data, f)
    except OSError:
        pass
    return fresh


def _update_source():
    """The install kind, and where its updates come from: the deb
    package asks apt, other installs ask PyPI."""
    install = install_source()
    return install, "apt" if install == "apt" else "pypi"


def _cached_update(source):
    data = _read_update()
    if data and data.get("source", "pypi") != source:
        return None  # the install changed: the old answer does not apply
    return data


UPGRADE_LOOK = 30  # seconds between looks at the files on disk
UPGRADE_GRACE = 120  # seconds after the end of a build without a restart
_upgrade = {"seen": None, "error": None}


def auto_restart_on():
    """auto_restart from config.ini: on unless the user turned it off."""
    return CONFIG.auto_restart is not False


def _pkg_stamp():
    """The file count, the total size, and the newest mtime of the
    package files. An upgrade that still writes files changes it."""
    count = size = newest = 0
    for root, dirs, files in os.walk(PKG_DIR):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in files:
            try:
                st = os.stat(os.path.join(root, name))
            except OSError:
                continue
            count += 1
            size += st.st_size
            newest = max(newest, st.st_mtime)
    return count, size, newest


def _new_code_loads(version):
    """(True, None) when a fresh Python imports the server code of
    version, else (False, the reason). A restart into a half-written or
    broken install would end the server for good."""
    code = ("import colcon_dashboard.cli, colcon_dashboard; "
            "print(colcon_dashboard.__version__)")
    try:
        r = subprocess.run([sys.executable, "-c", code],
                           stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)
    if r.returncode != 0:
        lines = r.stderr.strip().splitlines()
        return False, lines[-1] if lines else "exit code %d" % r.returncode
    loaded = r.stdout.strip()
    if loaded != version:
        return False, "it loads version %s" % loaded
    return True, None


def upgrade_ready(registry):
    """One look at the files on disk: True when the server can restart
    into the newer version that an upgrade put there.

    Two looks in a row must see the same files, so that the upgrade is
    done. The server must not be busy (Registry.busy): the end of a build
    still gets its notification and its prune, and an AI analysis keeps
    its answer. Then a fresh Python must load the new code."""
    disk = _disk_version()
    if not disk or _ver_key(disk) <= _ver_key(__version__):
        _upgrade["seen"] = None
        return False
    stamp = (disk, _pkg_stamp())
    if stamp != _upgrade["seen"]:
        _upgrade["seen"] = stamp  # the upgrade can still write files
        return False
    if registry.busy(UPGRADE_GRACE):
        return False
    ok, err = _new_code_loads(disk)
    if not ok:
        if err != _upgrade["error"]:
            print(f"auto restart: version {disk} does not load: {err}",
                  file=sys.stderr, flush=True)
        _upgrade["error"] = err
        _upgrade["seen"] = None  # look again: a fix can follow
        return False
    _upgrade["error"] = None
    return True


def watch_upgrade(registry, restart, look=UPGRADE_LOOK):
    """Call restart once an upgrade is ready (upgrade_ready). An
    upgrade replaces the files under this process, and the pages that it
    serves then come from the new version: a restart makes the server
    match them again. Runs in a daemon thread."""
    while True:
        time.sleep(look)
        try:
            ready = upgrade_ready(registry)
        except Exception as e:  # the watch must never stop the server
            print(f"auto restart: {e}", file=sys.stderr, flush=True)
            continue
        if ready:
            print(f"auto restart: version {_disk_version()} is installed,"
                  " restarting", file=sys.stderr, flush=True)
            restart()
            return


def _auto_restarts():
    """True when this server restarts by itself into a newer version."""
    return auto_restart_on() and not _upgrade["error"]


def update_status():
    """The note for the workspace picker, or None.

    kind "restart": an upgrade replaced the files on disk, and this
    server still runs the old code. kind "upgrade": a newer version is
    out. The deb package asks apt, so the note appears only when apt can
    install the version. Other installs ask PyPI. The check runs in the
    background at most once per UPDATE_INTERVAL: no request waits on it.
    """
    global _update_thread
    disk = _disk_version()
    if disk and _ver_key(disk) > _ver_key(__version__):
        return {"kind": "restart", "latest": disk, "current": __version__,
                "auto": _auto_restarts()}
    if not update_check_on():
        return None
    install, source = _update_source()
    data = _cached_update(source)
    stale = data is None \
        or time.time() - data.get("checked_at", 0) > UPDATE_INTERVAL[source]
    if stale and (_update_thread is None or not _update_thread.is_alive()):
        _update_thread = threading.Thread(target=_check_update_now,
                                          args=(source,), daemon=True)
        _update_thread.start()
    latest = (data or {}).get("latest")
    if latest and _ver_key(latest) > _ver_key(__version__):
        return {"kind": "upgrade", "latest": latest, "current": __version__,
                "source": source, "command": UPGRADE_COMMAND[install]}
    return None


def update_info():
    """The version state for the About section of the settings: the
    newest version from the last check, the time of that check, and the
    command that upgrades this install. "installed" is a newer version
    that an upgrade put on disk while this server runs."""
    install, source = _update_source()
    data = _cached_update(source) or {}
    latest = data.get("latest")
    disk = _disk_version()
    return {
        "current": __version__,
        "installed": disk if disk and _ver_key(disk) > _ver_key(__version__) else None,
        "auto_restart": _auto_restarts(),
        "latest": latest,
        "newer": bool(latest) and _ver_key(latest) > _ver_key(__version__),
        "checked_at": data.get("checked_at"),
        "auto": update_check_on(),
        "source": source,
        "command": UPGRADE_COMMAND[install],
    }


def check_update():
    """Check for a newer version now, because the user clicked "Check
    now". This also runs when check_updates is off: the click asks for
    the one request."""
    ok = _check_update_now(_update_source()[1]) is not None
    return dict(update_info(), ok=ok)


SCAN_PRUNE = {"node_modules", "__pycache__", "build", "install", "log",
              "src", "snap", "Downloads", "Pictures", "Music", "Videos"}


def discover_workspaces(root=None, max_depth=4):
    """Directories under root that look like colcon workspaces."""
    root = root or os.path.expanduser("~")
    found = []

    def walk(d, depth):
        try:
            names = set(os.listdir(d))
        except OSError:
            return
        if "log" in names or "build" in names:
            has_build_logs = False
            try:
                has_build_logs = any(
                    n == "latest_build" or n.startswith("build_")
                    for n in os.listdir(os.path.join(d, "log")))
            except OSError:
                pass
            if has_build_logs or ("src" in names and "install" in names):
                found.append(d)
                return  # a workspace does not nest more workspaces
        if depth >= max_depth:
            return
        for n in sorted(names):
            if n.startswith(".") or n in SCAN_PRUNE:
                continue
            p = os.path.join(d, n)
            if os.path.isdir(p) and not os.path.islink(p):
                walk(p, depth + 1)

    walk(root, 0)
    return found


def discover_all(extra_roots=(), home=True):
    """discover_workspaces over extra_roots, and over the home directory
    when home is true (the user allowed it: config scan_home).

    Overlapping roots find a workspace twice; keep its first find.
    """
    found, seen = [], set()
    roots = [os.path.expanduser("~")] if home else []
    for root in [*roots, *extra_roots]:
        for d in discover_workspaces(root):
            real = os.path.realpath(d)
            if real not in seen:
                seen.add(real)
                found.append(d)
    return found
