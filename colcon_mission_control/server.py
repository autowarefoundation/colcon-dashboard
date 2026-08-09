#!/usr/bin/env python3
"""Colcon Mission Control - a live web dashboard for colcon builds.

Tails the events.log that colcon writes for every build, reconstructs the
exact job graph and job states from it, and serves a single-page UI with a
live dependency graph, a timeline, and isolated per-package log panes.

Zero dependencies: Python 3.8+ standard library only. Works on any colcon
workspace:

    colcon-mission-control [WORKSPACE] [--port N] [--host 127.0.0.1] [--stop]
"""

import argparse
import ast
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

try:
    import fcntl
except ImportError:  # non-Unix: run without the single-instance lock
    fcntl = None
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

NAMESPACE_RE = re.compile(r"Parsed command line arguments: Namespace\((?P<body>.*)\)\s*$")
NS_FIELD_RE = re.compile(r"(\w+)=(\[[^\]]*\]|'(?:[^'\\]|\\.)*'|True|False|None|-?\d+)")

EVENT_RE = re.compile(rb"^\[\s*([0-9.]+)\] \(([^)]*)\) (\w+): (.*)$")
RC_RE = re.compile(rb"'rc': (?:'([^']+)'|(-?\d+))")
PROGRESS_RE = re.compile(rb"'progress': '([^']*)'")
DEP_KEY_RES = (re.compile(rb"'([^']+)': '/"),      # dict repr  {'name': '/path'}
               re.compile(rb"\('([^']+)', '/"))    # legacy     [('name', '/path')]
PCT_RE = re.compile(rb"\[\s*(\d{1,3})%\]")

DEP_TAGS = ("buildtool_depend", "build_depend", "depend", "exec_depend", "run_depend")

LOG_FILES = {
    "combined": "stdout_stderr.log",
    "stdout": "stdout.log",
    "stderr": "stderr.log",
    "command": "command.log",
}


def parse_build_id_time(build_id):
    """build_2026-08-09_09-56-51 -> epoch seconds (local time), or None."""
    m = re.search(r"(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})", build_id)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S").timestamp()
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Workspace package discovery (metadata + full-workspace graph)
# ---------------------------------------------------------------------------

class PackageIndex:
    """All packages found under the workspace's base paths, with direct deps."""

    PRUNE_NAMES = {"build", "install", "log", "node_modules", "__pycache__"}

    def __init__(self, workspace):
        self.workspace = workspace
        self.packages = {}  # name -> {path, deps:set, build_type}
        self.scanned_at = 0.0

    def scan(self, base_paths):
        pkgs = {}
        for base in base_paths or ["."]:
            root = os.path.normpath(os.path.join(self.workspace, base))
            if not os.path.isdir(root):
                continue
            for dirpath, dirnames, filenames in os.walk(root):
                rel = os.path.relpath(dirpath, self.workspace)
                depth = 0 if rel == "." else rel.count(os.sep) + 1
                if depth > 14:
                    dirnames[:] = []
                    continue
                dirnames[:] = [
                    d for d in dirnames
                    if not d.startswith(".") and d not in self.PRUNE_NAMES
                ]
                if "COLCON_IGNORE" in filenames:
                    dirnames[:] = []
                    continue
                if "package.xml" not in filenames:
                    continue
                info = self._parse_package_xml(os.path.join(dirpath, "package.xml"))
                if info:
                    name, deps, build_type = info
                    if name not in pkgs:
                        pkgs[name] = {
                            "path": os.path.relpath(dirpath, self.workspace),
                            "deps": deps,
                            "build_type": build_type,
                        }
                dirnames[:] = []  # a package dir does not nest further packages
        for name, info in pkgs.items():
            info["deps"] = {d for d in info["deps"] if d in pkgs and d != name}
        self.packages = pkgs
        self.scanned_at = time.time()

    def dep_closure(self, name, _memo=None):
        memo = _memo if _memo is not None else {}
        if name in memo:
            return memo[name]
        memo[name] = set()  # cycle guard
        out = set()
        for d in self.packages.get(name, {}).get("deps", ()):
            out.add(d)
            out |= self.dep_closure(d, memo)
        memo[name] = out
        return out

    @staticmethod
    def _parse_package_xml(path):
        try:
            tree = ET.parse(path)
        except (ET.ParseError, OSError):
            return None
        root = tree.getroot()
        name_el = root.find("name")
        if name_el is None or not (name_el.text or "").strip():
            return None
        name = name_el.text.strip()
        deps = set()
        for tag in DEP_TAGS:
            for el in root.findall(tag):
                if el.text and el.text.strip():
                    deps.add(el.text.strip())
        build_type = "ament_cmake"
        export = root.find("export")
        if export is not None:
            bt = export.find("build_type")
            if bt is not None and bt.text:
                build_type = bt.text.strip()
        return name, deps, build_type


def parse_namespace(logger_path):
    """Extract simple fields of colcon's 'Parsed command line arguments' line."""
    try:
        with open(logger_path, "r", errors="replace") as f:
            head = f.read(512 * 1024)
    except OSError:
        return None
    for line in head.splitlines():
        m = NAMESPACE_RE.search(line)
        if not m:
            continue
        fields = {}
        for key, raw in NS_FIELD_RE.findall(m.group("body")):
            try:
                fields[key] = ast.literal_eval(raw)
            except (ValueError, SyntaxError):
                pass
        return fields
    return None


# ---------------------------------------------------------------------------
# events.log tailer - the ground truth for job states
# ---------------------------------------------------------------------------

class EventLog:
    def __init__(self, path):
        self.path = path
        self.offset = 0
        self.partial = b""
        self.jobs = {}        # name -> job dict, insertion-ordered
        self.unselected = set()
        self.last_t = 0.0
        self.shutdown = False
        self.graph_dirty = True

    def _job(self, name):
        job = self.jobs.get(name)
        if job is None:
            job = self.jobs[name] = {
                "deps": set(), "queued": None, "started": None, "ended": None,
                "rc": None, "skipped": False, "phase": "", "pct": None,
                "stderr_lines": 0,
            }
        return job

    def poll(self, max_bytes=32 * 1024 * 1024):
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return
        if size < self.offset:
            self.__init__(self.path)
            return self.poll(max_bytes)
        if size == self.offset:
            return
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            chunk = f.read(min(size - self.offset, max_bytes))
            self.offset += len(chunk)
        data = self.partial + chunk
        lines = data.split(b"\n")
        self.partial = lines.pop()
        for line in lines:
            self._handle(line)

    def _handle(self, line):
        m = EVENT_RE.match(line)
        if not m:
            return
        t = float(m.group(1))
        self.last_t = max(self.last_t, t)
        event = m.group(3)
        if event == b"TimerEvent":
            return
        name = m.group(2).decode("utf-8", "replace")
        payload = m.group(4)
        if event == b"StdoutLine" or event == b"StderrLine":
            job = self._job(name)
            if event == b"StderrLine":
                job["stderr_lines"] += 1
            if b"%]" in payload:
                pm = PCT_RE.search(payload)
                if pm:
                    job["pct"] = min(100, int(pm.group(1)))
        elif event == b"JobQueued":
            job = self._job(name)
            job["queued"] = t
            deps = set()
            for dep_re in DEP_KEY_RES:
                deps |= {k.decode("utf-8", "replace")
                         for k in dep_re.findall(payload)}
            job["deps"] = deps
            self.graph_dirty = True
        elif event == b"JobStarted":
            job = self._job(name)
            job["started"] = t
            job["pct"] = None
        elif event == b"JobEnded":
            job = self._job(name)
            job["ended"] = t
            rm = RC_RE.search(payload)
            if rm:
                job["rc"] = rm.group(1).decode() if rm.group(1) else int(rm.group(2))
        elif event == b"JobProgress":
            pm = PROGRESS_RE.search(payload)
            if pm:
                self._job(name)["phase"] = pm.group(1).decode("utf-8", "replace")
        elif event == b"JobSkipped":
            self._job(name)["skipped"] = True
        elif event == b"JobUnselected":
            self.unselected.add(name)
        elif event == b"EventReactorShutdown":
            self.shutdown = True

    def mtime(self):
        try:
            return os.stat(self.path).st_mtime
        except OSError:
            return 0.0


# ---------------------------------------------------------------------------
# Build monitor
# ---------------------------------------------------------------------------

class BuildMonitor:
    def __init__(self, workspace, log_base="log"):
        self.workspace = os.path.realpath(workspace)
        self.log_base = os.path.join(self.workspace, log_base)
        self.index = PackageIndex(self.workspace)
        self.lock = threading.Lock()
        self.state_json = json.dumps({"error": "scanning..."})
        self.graph_json = json.dumps({"packages": {}})
        self.build_id = None
        self.build_dir = None
        self.events = None
        self.namespace = None
        self.direct_deps = {}  # transitive reduction of the job dep closures
        self.seq = 0
        self._prev_cpu = {}

    def sample_system(self):
        """CPU %, per-core %, memory and swap from /proc; None if unavailable."""
        info = {}
        try:
            rows = []
            with open("/proc/stat") as f:
                for line in f:
                    if not line.startswith("cpu"):
                        break
                    parts = line.split()
                    vals = [int(x) for x in parts[1:11]]
                    rows.append((parts[0], sum(vals),
                                 vals[3] + (vals[4] if len(vals) > 4 else 0)))
            prev, self._prev_cpu = self._prev_cpu, {
                name: (total, idle) for name, total, idle in rows}
            cores = []
            for name, total, idle in rows:
                p = prev.get(name)
                if not p or total <= p[0]:
                    continue
                pct = round(100 * (1 - (idle - p[1]) / (total - p[0])), 1)
                if name == "cpu":
                    info["cpu"] = pct
                else:
                    cores.append(round(pct))
            if cores:
                info["cores"] = cores
            info["load"] = round(os.getloadavg()[0], 1)
            mem = {}
            with open("/proc/meminfo") as f:
                for line in f:
                    key, _, rest = line.partition(":")
                    if key in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
                        mem[key] = int(rest.strip().split()[0])  # kB
            if mem.get("MemTotal"):
                info["mem_total"] = mem["MemTotal"]
                info["mem_used"] = mem["MemTotal"] - mem.get("MemAvailable", 0)
            if mem.get("SwapTotal"):
                info["swap_total"] = mem["SwapTotal"]
                info["swap_used"] = mem["SwapTotal"] - mem.get("SwapFree", 0)
        except (OSError, ValueError):
            pass
        return info or None

    # -- build dir resolution ------------------------------------------------

    def resolve_latest(self):
        latest = os.path.join(self.log_base, "latest_build")
        if os.path.isdir(latest):
            return os.path.realpath(latest)
        try:
            candidates = sorted(
                d for d in os.listdir(self.log_base) if d.startswith("build_")
            )
        except OSError:
            return None
        return os.path.join(self.log_base, candidates[-1]) if candidates else None

    def list_builds(self):
        try:
            builds = sorted(
                (d for d in os.listdir(self.log_base) if d.startswith("build_")),
                reverse=True,
            )
        except OSError:
            builds = []
        return {"builds": builds, "latest": self.build_id}

    # -- graph reduction -----------------------------------------------------

    def reduce_graph(self):
        """Direct edges from colcon's per-job recursive dependency sets."""
        jobs = self.events.jobs
        memo = {}
        full = {}
        for name, job in jobs.items():
            full[name] = set(job["deps"])

        def closure_of(dep):
            if dep in full:
                return full[dep]
            if dep not in memo:
                memo[dep] = self.index.dep_closure(dep)
            return memo[dep]

        direct = {}
        for name, deps in full.items():
            covered = set()
            for d in deps:
                covered |= closure_of(d)
            direct[name] = deps - covered
        self.direct_deps = direct
        self.events.graph_dirty = False

    # -- main scan -----------------------------------------------------------

    def scan_once(self):
        build_dir = self.resolve_latest()
        if not build_dir:
            with self.lock:
                self.state_json = json.dumps(
                    {"error": "no colcon build logs found under "
                              f"{self.log_base}", "workspace": self.workspace,
                     "sys": self.sample_system(), "seq": self.seq})
            return
        build_id = os.path.basename(build_dir)
        if build_id != self.build_id:
            self.build_id = build_id
            self.build_dir = build_dir
            self.events = EventLog(os.path.join(build_dir, "events.log"))
            self.namespace = None
            self.direct_deps = {}

        if self.namespace is None:
            self.namespace = parse_namespace(
                os.path.join(build_dir, "logger_all.log"))
        if time.time() - self.index.scanned_at > 120:
            base_paths = (self.namespace or {}).get("base_paths") or ["."]
            self.index.scan(base_paths)

        ev = self.events
        ev.poll()
        if ev.graph_dirty:
            self.reduce_graph()

        if not os.path.exists(ev.path):
            with self.lock:
                self.state_json = json.dumps(
                    {"error": f"no events.log in {build_dir} yet",
                     "build_id": build_id, "seq": self.seq})
            return

        now = time.time()
        active = (not ev.shutdown) and (now - ev.mtime() < 15.0)
        epoch0 = parse_build_id_time(build_id) or (ev.mtime() - ev.last_t)

        jobs = ev.jobs
        done = {n for n, j in jobs.items() if j["ended"] is not None and j["rc"] == 0}
        packages = {}
        for name, job in jobs.items():
            entry = {}
            if job["ended"] is not None:
                if job["rc"] == 0:
                    st = "done"
                elif job["rc"] == "SIGINT":
                    st = "aborted"
                else:
                    st = "failed"
                    entry["rc"] = job["rc"]
            elif job["started"] is not None:
                st = "building" if active else "aborted"
                entry["ph"] = job["phase"]
                if job["pct"] is not None:
                    entry["pct"] = job["pct"]
            elif job["skipped"]:
                st = "skipped"
            else:
                blockers = job["deps"] & set(jobs) - done
                failed_deps = {b for b in blockers
                               if jobs[b]["ended"] is not None and jobs[b]["rc"] != 0}
                if failed_deps or any(jobs[b]["skipped"] for b in blockers):
                    st = "blocked"
                elif not blockers:
                    st = "ready" if active else "skipped"
                else:
                    st = "waiting" if active else "skipped"
            entry["s"] = st
            if job["started"] is not None:
                entry["t0"] = round(epoch0 + job["started"], 2)
            if job["ended"] is not None:
                entry["t1"] = round(epoch0 + job["ended"], 2)
            if job["stderr_lines"]:
                entry["err"] = job["stderr_lines"]
            if job["started"] is not None:
                try:
                    entry["log"] = os.path.getsize(
                        os.path.join(build_dir, name, "stdout_stderr.log"))
                except OSError:
                    pass
            packages[name] = entry

        counts = {}
        for p in packages.values():
            counts[p["s"]] = counts.get(p["s"], 0) + 1

        state = {
            "workspace": self.workspace,
            "build_id": build_id,
            "active": bool(active),
            "workers": (self.namespace or {}).get("parallel_workers"),
            "build_started": epoch0,
            "elapsed": round((now - epoch0) if active else ev.last_t, 1),
            "now": round(now, 2),
            "counts": counts,
            "total": len(packages),
            "packages": packages,
            "sys": self.sample_system(),
            "seq": self.seq,
        }

        idx = self.index.packages
        graph_pkgs = {}
        for name in set(idx) | set(jobs) | ev.unselected:
            if name in self.direct_deps:
                deps = sorted(self.direct_deps[name])
            else:
                deps = sorted(idx.get(name, {}).get("deps") or [])
            graph_pkgs[name] = {
                "deps": deps,
                "build_type": idx.get(name, {}).get("build_type", ""),
                "path": idx.get(name, {}).get("path", ""),
                "in_build": name in jobs,
            }
        graph = {"build_id": build_id, "packages": graph_pkgs}

        self.seq += 1
        with self.lock:
            self.state_json = json.dumps(state, separators=(",", ":"))
            self.graph_json = json.dumps(graph, separators=(",", ":"))

    def run(self, interval=0.8):
        while True:
            try:
                self.scan_once()
            except Exception as exc:  # keep the monitor alive, report the error
                with self.lock:
                    self.state_json = json.dumps(
                        {"error": f"{type(exc).__name__}: {exc}", "seq": self.seq})
            time.sleep(interval)

    # -- log serving ---------------------------------------------------------

    def read_log(self, pkg, which, offset, build=None):
        if which not in LOG_FILES or "/" in pkg or ".." in pkg or not pkg:
            return None
        build_dir = self.build_dir
        if build and re.fullmatch(r"build_[\w.-]+", build):
            build_dir = os.path.join(self.log_base, build)
        if not build_dir:
            return None
        path = os.path.join(build_dir, pkg, LOG_FILES[which])
        try:
            size = os.path.getsize(path)
        except OSError:
            return {"size": 0, "offset": 0, "data": "", "reset": False}
        reset = False
        if offset < 0:  # initial request: tail the last 128 KiB
            offset = max(0, size - 128 * 1024)
            reset = True
        if offset > size:
            offset, reset = 0, True
        with open(path, "rb") as f:
            f.seek(offset)
            raw = f.read(512 * 1024)
        return {
            "size": size,
            "offset": offset + len(raw),
            "data": raw.decode("utf-8", errors="replace"),
            "reset": reset,
        }


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    monitor = None  # set in main()

    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        mon = self.monitor
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = unquote(url.path)

        if path == "/api/state":
            with mon.lock:
                return self._send(200, mon.state_json)
        if path == "/api/graph":
            with mon.lock:
                return self._send(200, mon.graph_json)
        if path == "/api/builds":
            return self._send(200, json.dumps(mon.list_builds()))
        if path.startswith("/api/log/"):
            pkg = path[len("/api/log/"):]
            which = q.get("file", ["combined"])[0]
            try:
                offset = int(q.get("offset", ["-1"])[0])
            except ValueError:
                offset = -1
            build = q.get("build", [None])[0]
            result = mon.read_log(pkg, which, offset, build)
            if result is None:
                return self._send(400, json.dumps({"error": "bad request"}))
            return self._send(200, json.dumps(result))

        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep):
            return self._send(404, json.dumps({"error": "not found"}))
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            return self._send(404, json.dumps({"error": "not found"}))
        ext = os.path.splitext(full)[1]
        return self._send(200, body, MIME.get(ext, "application/octet-stream"))


# ---------------------------------------------------------------------------
# Single instance per workspace
# ---------------------------------------------------------------------------

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache",
                         "colcon-mission-control")


def instance_path(workspace):
    key = hashlib.sha1(workspace.encode()).hexdigest()[:12]
    return os.path.join(CACHE_DIR, key + ".json")


def default_port(workspace):
    return 8600 + int(hashlib.sha1(workspace.encode()).hexdigest()[:8], 16) % 300


def read_instance(workspace):
    try:
        with open(instance_path(workspace)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def probe_instance(info, timeout=0.8):
    """True when the recorded server is alive and watches this workspace."""
    if not info or "port" not in info:
        return False
    url = f"http://{info.get('host', '127.0.0.1')}:{info['port']}/api/state"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            state = json.load(r)
        return state.get("workspace") == info.get("workspace")
    except (OSError, ValueError):
        return False


def instance_url(info):
    return f"http://{info.get('host', '127.0.0.1')}:{info['port']}/"


def ensure_running(workspace, wait=4.0):
    """Reuse the workspace's server, or spawn a detached one.

    Returns (url, started) - url is None when the server did not come up.
    """
    workspace = os.path.realpath(workspace)
    info = read_instance(workspace)
    if probe_instance(info):
        return instance_url(info), False
    os.makedirs(CACHE_DIR, exist_ok=True)
    log_file = open(os.path.join(CACHE_DIR, "spawn.log"), "ab")
    subprocess.Popen(
        [sys.executable, "-m", "colcon_mission_control", workspace],
        stdout=log_file, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, start_new_session=True)
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(0.2)
        info = read_instance(workspace)
        if probe_instance(info):
            return instance_url(info), True
    return None, True


def main():
    ap = argparse.ArgumentParser(
        description="Colcon Mission Control - live colcon build dashboard")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="colcon workspace root (default: current directory)")
    ap.add_argument("--port", type=int, default=None,
                    help="HTTP port (default: a stable per-workspace port)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--log-base", default="log",
                    help="log directory relative to the workspace (default: log)")
    ap.add_argument("--stop", action="store_true",
                    help="stop the server that watches this workspace")
    args = ap.parse_args()

    workspace = os.path.realpath(args.workspace)
    if not os.path.isdir(workspace):
        raise SystemExit(f"not a directory: {workspace}")

    if args.stop:
        info = read_instance(workspace)
        if info and probe_instance(info):
            os.kill(info["pid"], signal.SIGTERM)
            print(f"stopped the server for {workspace} (pid {info['pid']})")
        else:
            print(f"no server runs for {workspace}")
        return

    # one server per workspace: hold an exclusive lock on the instance file
    os.makedirs(CACHE_DIR, exist_ok=True)
    lock_file = open(instance_path(workspace), "a+")
    if fcntl is not None:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lock_file.seek(0)
            try:
                info = json.loads(lock_file.read() or "{}")
            except ValueError:
                info = {}
            if "port" in info:
                print(f"already running for {workspace}: {instance_url(info)}")
            else:
                print(f"another server is starting for {workspace}")
            return

    port = args.port if args.port else default_port(workspace)
    try:
        server = ThreadingHTTPServer((args.host, port), Handler)
    except OSError:
        if args.port:
            raise SystemExit(f"port {args.port} is in use")
        server = ThreadingHTTPServer((args.host, 0), Handler)  # any free port
    port = server.server_address[1]

    lock_file.seek(0)
    lock_file.truncate()
    json.dump({"workspace": workspace, "host": args.host, "port": port,
               "pid": os.getpid()}, lock_file)
    lock_file.flush()

    monitor = BuildMonitor(workspace, args.log_base)
    threading.Thread(target=monitor.run, daemon=True).start()
    Handler.monitor = monitor

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print("Colcon Mission Control")
    print(f"  workspace: {workspace}")
    print(f"  url:       http://{args.host}:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.unlink(instance_path(workspace))
        except OSError:
            pass


if __name__ == "__main__":
    main()
