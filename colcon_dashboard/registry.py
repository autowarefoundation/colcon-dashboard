"""One server per machine: the workspace registry and discovery.

Holds a BuildMonitor per (workspace, pinned build), the persisted recents
list, and the home-directory scan for colcon workspaces.
"""

import json
import os
import re
import threading
import time
import urllib.request

from . import __version__
from .config import CONFIG
from .events import BUILD_DIR_RE, parse_build_id_time
from .monitor import BuildMonitor

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache",
                         "colcon-dashboard")
SERVER_FILE = os.path.join(CACHE_DIR, "server.json")
REGISTRY_FILE = os.path.join(CACHE_DIR, "workspaces.json")
GLOBAL_PORT = 8642


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
        out = {"builds": 0, "log_size": 0, "last_build": None}
        log_dir = os.path.join(ws, self.log_base)
        newest = None
        try:
            for name in os.listdir(log_dir):
                if name.startswith("build_"):
                    out["builds"] += 1
                    t = parse_build_id_time(name)
                    if t and (newest is None or t > newest):
                        newest = t
        except OSError:
            pass
        out["last_build"] = newest
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
        try:
            ws = os.path.realpath(os.path.expanduser(ws))
        except (OSError, ValueError):
            return None
        if not os.path.isdir(ws):
            return None
        if build and not BUILD_DIR_RE.fullmatch(build):
            return None
        key = (ws, build)
        with self.lock:
            mon = self.monitors.get(key)
            if mon is None:
                mon = BuildMonitor(ws, self.log_base, pin_build=build)
                if build is None:
                    mon.on_prune = (lambda deleted, ws=ws:
                                    self._auto_pruned(ws, deleted))
                self.monitors[key] = mon
                threading.Thread(target=mon.run, daemon=True).start()
        if touch:
            self.touch(ws)
        return mon

    def _auto_pruned(self, ws, deleted):
        """After a monitor auto-prunes: mirror the manual-prune cleanup."""
        for name in deleted:
            self.drop_pinned(ws, name)
        self.stats_cache.pop(ws, None)

    def drop_pinned(self, ws, build):
        with self.lock:
            mon = self.monitors.pop((ws, build), None)
        if mon is not None:
            mon.stopped = True  # its scan thread ends on the next tick
        return mon is not None

    def overview(self):
        with self.lock:
            recents = [dict(r) for r in self.recents]
            monitors = dict(self.monitors)
        out = []
        for r in recents:
            entry = {"path": r["path"], "last_used": r.get("last_used"),
                     "fav": bool(r.get("fav")),
                     "exists": os.path.isdir(r["path"])}
            if entry["exists"]:
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
UPDATE_INTERVAL = 86400
_update_thread = None


def _ver_key(version):
    nums = [int(x) for x in re.findall(r"\d+", version or "")[:3]]
    return tuple(nums + [0] * (3 - len(nums)))


def _read_update():
    try:
        with open(os.path.join(CACHE_DIR, "update.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _check_update_now():
    data = {"checked_at": time.time()}
    try:
        with urllib.request.urlopen(PYPI_URL, timeout=6) as r:
            data["latest"] = json.load(r)["info"]["version"]
    except (OSError, ValueError, KeyError):
        old = _read_update()  # keep a stale answer over none
        if old and old.get("latest"):
            data["latest"] = old["latest"]
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(os.path.join(CACHE_DIR, "update.json"), "w") as f:
            json.dump(data, f)
    except OSError:
        pass


def update_status():
    """{'latest', 'current'} when PyPI has a newer release, else None.

    Opt-in through check_updates in config.ini. At most one check a
    day, always in the background: no request ever waits on PyPI.
    """
    global _update_thread
    if not CONFIG.check_updates:
        return None
    data = _read_update()
    stale = data is None \
        or time.time() - data.get("checked_at", 0) > UPDATE_INTERVAL
    if stale and (_update_thread is None or not _update_thread.is_alive()):
        _update_thread = threading.Thread(target=_check_update_now,
                                          daemon=True)
        _update_thread.start()
    latest = (data or {}).get("latest")
    if latest and _ver_key(latest) > _ver_key(__version__):
        return {"latest": latest, "current": __version__}
    return None


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
