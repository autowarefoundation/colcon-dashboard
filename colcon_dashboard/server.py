#!/usr/bin/env python3
"""Colcon Dashboard - a live web dashboard for colcon builds.

Tails the events.log that colcon writes for every build, reconstructs the
exact job graph and job states from it, and serves a single-page UI with a
live dependency graph, a timeline, and isolated per-package log panes.

Zero dependencies: Python 3.8+ standard library only. Works on any colcon
workspace:

    colcon-dashboard [WORKSPACE] [--port N] [--host 127.0.0.1] [--stop]
"""

import argparse
import ast
import json
import os
import re
import shutil
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
from urllib.parse import parse_qs, quote, unquote, urlparse

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
    "streams": "streams.log",
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
# Combined build log - the terminal view, synthesized from the event stream
# ---------------------------------------------------------------------------

LINE_PAYLOAD_RE = re.compile(
    rb"'line': (b'(?:[^'\\]|\\.)*'|b\"(?:[^\"\\]|\\.)*\")")


def payload_line(payload):
    """The output line carried by a StdoutLine/StderrLine event, or None."""
    m = LINE_PAYLOAD_RE.search(payload)
    if not m:
        return None
    try:
        raw = ast.literal_eval(m.group(1).decode("latin-1"))
        return raw.decode("utf-8", "replace").rstrip("\n")
    except (ValueError, SyntaxError):
        return None


class BuildLogBuffer:
    """Append-only text buffer with a byte-offset API and a size cap."""

    MAX = 48 * 1024 * 1024
    TRIM = 8 * 1024 * 1024

    def __init__(self):
        self._lock = threading.Lock()
        self._buf = bytearray()
        self._base = 0  # logical offset of _buf[0]

    def append(self, text):
        with self._lock:
            self._buf += (text + "\n").encode("utf-8", "replace")
            if len(self._buf) > self.MAX:
                del self._buf[:self.TRIM]
                self._base += self.TRIM

    def read(self, offset, cap=512 * 1024, limit=None, align=False):
        if limit:
            cap = min(cap, limit)
        with self._lock:
            size = self._base + len(self._buf)
            reset = False
            if offset < 0 or offset > size or offset < self._base:
                offset = max(self._base, size - 128 * 1024)
                reset = True
            start = offset - self._base
            data = bytes(self._buf[start:start + cap])
        end = offset + len(data)
        if (reset or align) and offset > 0 and data:
            i = data.find(b"\n")  # do not start mid-line
            if i >= 0:
                offset += i + 1
                data = data[i + 1:]
        return {"size": size, "start": offset, "offset": end,
                "data": data.decode("utf-8", "replace"), "reset": reset}


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
        self.buildlog = BuildLogBuffer()

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
            line = payload_line(payload)
            if line is not None:
                self.buildlog.append(f"[{t:9.3f}s] [{name}] {line}")
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
            self.buildlog.append(f"[{t:9.3f}s] Starting >>> {name}")
        elif event == b"JobEnded":
            job = self._job(name)
            job["ended"] = t
            rm = RC_RE.search(payload)
            if rm:
                job["rc"] = rm.group(1).decode() if rm.group(1) else int(rm.group(2))
            dur = t - (job["started"] if job["started"] is not None else t)
            if job["rc"] == 0:
                self.buildlog.append(f"[{t:9.3f}s] Finished <<< {name} [{dur:.1f}s]")
            elif job["rc"] == "SIGINT":
                self.buildlog.append(f"[{t:9.3f}s] Aborted  <<< {name} [{dur:.1f}s]")
            else:
                self.buildlog.append(
                    f"[{t:9.3f}s] Failed   <<< {name} [{dur:.1f}s] "
                    f"(exit code {job['rc']})")
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
    def __init__(self, workspace, log_base="log", pin_build=None):
        self.workspace = os.path.realpath(workspace)
        self.log_base = os.path.join(self.workspace, log_base)
        self.pin_build = pin_build  # a fixed historical build, or None
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
        self.last_request = time.time()
        self._prev_cpu = {}
        self._builds_cache = None
        self.analyses = {}  # (build_dir, pkg) -> AIAnalysis

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
        if self.pin_build:  # a fixed historical build
            p = os.path.join(self.log_base, self.pin_build)
            return p if os.path.isdir(p) else None
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

    OUTCOME_FILE = ".colcon-dashboard.json"

    def _read_outcome(self, build_dir):
        try:
            with open(os.path.join(build_dir, self.OUTCOME_FILE)) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _compute_outcome(self, build_dir):
        """One streaming pass over events.log; cached in the build folder."""
        path = os.path.join(build_dir, "events.log")
        total = done = failed = aborted = skipped = 0
        shutdown = False
        try:
            mtime = os.stat(path).st_mtime
            with open(path, "rb") as f:
                for line in f:
                    if b"JobQueued" in line:
                        total += 1
                    elif b"JobEnded" in line:
                        m = RC_RE.search(line)
                        if not m:
                            continue
                        if m.group(1):  # a signal name, e.g. SIGINT
                            aborted += 1
                        elif int(m.group(2)) == 0:
                            done += 1
                        else:
                            failed += 1
                    elif b"JobSkipped" in line:
                        skipped += 1
                    elif b"EventReactorShutdown" in line:
                        shutdown = True
        except OSError:
            return None
        if not shutdown and time.time() - mtime < 120:
            return None  # the build still runs: nothing to cache
        # Skipped jobs never emit JobEnded, so a finished run satisfies
        # done+failed+aborted+skipped == total even after a failure cascade.
        if failed:
            outcome = "failed"
        elif aborted or not shutdown \
                or done + failed + aborted + skipped < total:
            outcome = "aborted"
        elif total:
            outcome = "passed"
        else:
            outcome = "empty"
        info = {"outcome": outcome, "done": done, "total": total,
                "failed": failed, "aborted": aborted, "skipped": skipped}
        try:
            with open(os.path.join(build_dir, self.OUTCOME_FILE), "w") as f:
                json.dump(info, f)
        except OSError:
            pass
        return info

    def list_builds(self):
        try:
            names = sorted(
                (d for d in os.listdir(self.log_base) if d.startswith("build_")),
                reverse=True,
            )
        except OSError:
            names = []
        now = time.time()
        if self._builds_cache and now - self._builds_cache[0] < 30 \
                and self._builds_cache[1] == names:
            return self._builds_cache[2]
        builds = []
        pending = []
        for name in names:
            bdir = os.path.join(self.log_base, name)
            size = 0
            for dp, _dn, fns in os.walk(bdir):
                for fn in fns:
                    try:
                        size += os.stat(os.path.join(dp, fn)).st_size
                    except OSError:
                        pass
            entry = {"id": name, "time": parse_build_id_time(name),
                     "size": size}
            info = self._read_outcome(bdir)
            if info:
                entry.update(info)
            elif not (name == self.build_id
                      and getattr(self, "active_flag", False)):
                pending.append(name)
            builds.append(entry)
        result = {"builds": builds, "latest": self.build_id,
                  "pinned": self.pin_build}
        self._builds_cache = (now, names, result)
        if pending and not getattr(self, "_outcome_busy", False):
            self._outcome_busy = True

            def work(todo):
                for n in todo:
                    self._compute_outcome(os.path.join(self.log_base, n))
                self._builds_cache = None
                self._outcome_busy = False

            threading.Thread(target=work, args=(pending,),
                             daemon=True).start()
        return result

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
        self.active_flag = bool(active)
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
            "ai": bool(CLAUDE_BIN),
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

    def run(self):
        while True:
            try:
                self.scan_once()
            except Exception as exc:  # keep the monitor alive, report the error
                with self.lock:
                    self.state_json = json.dumps(
                        {"error": f"{type(exc).__name__}: {exc}", "seq": self.seq})
            # scan fast while someone watches, slow down when nobody does
            watched = time.time() - self.last_request < 15
            time.sleep(0.8 if watched else 4.0)

    # -- log serving ---------------------------------------------------------

    def read_log(self, pkg, which, offset, build=None, limit=None, align=False):
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
            return {"size": 0, "start": 0, "offset": 0, "data": "",
                    "reset": False}
        reset = False
        if offset < 0:  # initial request: tail the last 128 KiB
            offset = max(0, size - 128 * 1024)
            reset = True
        if offset > size:
            offset, reset = 0, True
        cap = 512 * 1024
        if limit:
            cap = min(cap, limit)
        with open(path, "rb") as f:
            f.seek(offset)
            raw = f.read(cap)
        end = offset + len(raw)
        if (reset or align) and offset > 0 and raw:
            i = raw.find(b"\n")  # do not start mid-line
            if i >= 0:
                offset += i + 1
                raw = raw[i + 1:]
        return {
            "size": size,
            "start": offset,
            "offset": end,
            "data": raw.decode("utf-8", errors="replace"),
            "reset": reset,
        }

    # -- AI failure analysis -------------------------------------------------

    def analysis(self, pkg, build=None):
        """The AIAnalysis for one package of one build; None without claude."""
        if not CLAUDE_BIN or "/" in pkg or ".." in pkg or not pkg:
            return None
        build_dir = self.build_dir
        if build and re.fullmatch(r"build_[\w.-]+", build):
            build_dir = os.path.join(self.log_base, build)
        if not build_dir or not os.path.isdir(os.path.join(build_dir, pkg)):
            return None
        key = (build_dir, pkg)
        with self.lock:
            a = self.analyses.get(key)
            if a is None:
                a = self.analyses[key] = AIAnalysis(
                    self.workspace, build_dir, pkg)
        return a

    def ai_prompt(self, pkg, build_dir):
        src = self.index.packages.get(pkg, {}).get("path", "")
        tail = b""
        for fn in ("stderr.log", "stdout_stderr.log"):
            path = os.path.join(build_dir, pkg, fn)
            try:
                with open(path, "rb") as f:
                    f.seek(max(0, os.path.getsize(path) - 24 * 1024))
                    tail = f.read()
            except OSError:
                continue
            if tail.strip():
                break
        return (
            f"The colcon build of the package '{pkg}' failed in this"
            " workspace.\n"
            + (f"The package source is in {src}.\n" if src else "")
            + "Find the reason and answer briefly:\n"
              "1. The exact error, with the file and line it points to.\n"
              "2. The root cause.\n"
              "3. A concrete fix.\n"
              "Read source files when they help. Do not change any file.\n"
              "The tail of the failed build log follows.\n\n"
            + tail.decode("utf-8", "replace")
        )


# ---------------------------------------------------------------------------
# AI failure analysis: shell out to the claude CLI when it is installed
# ---------------------------------------------------------------------------

def _find_claude():
    """The claude CLI; ~/.local/bin is not on the systemd user PATH."""
    found = shutil.which("claude")
    if found:
        return found
    cand = os.path.join(os.path.expanduser("~"), ".local", "bin", "claude")
    return cand if os.access(cand, os.X_OK) else None


CLAUDE_BIN = _find_claude()
AI_FILE = "claude-analysis.json"
AI_DIM = "\x1b[90m"
AI_BOLD = "\x1b[1m"
AI_RESET = "\x1b[0m"


class AIAnalysis:
    """One claude CLI conversation about one package's failure.

    The transcript accumulates in memory and persists next to the package's
    logs, so a finished analysis survives a server restart. The saved session
    id lets --resume turn the analysis into a conversation.
    """

    def __init__(self, workspace, build_dir, pkg):
        self.workspace = workspace
        self.build_dir = build_dir
        self.pkg = pkg
        self.lock = threading.Lock()
        self.buf = b""
        self.running = False
        self.session_id = None
        try:
            with open(self._path()) as f:
                d = json.load(f)
            self.buf = d.get("text", "").encode()
            self.session_id = d.get("session_id")
        except (OSError, ValueError):
            pass

    def _path(self):
        return os.path.join(self.build_dir, self.pkg, AI_FILE)

    def _append(self, text):
        with self.lock:
            self.buf += text.encode()

    def read(self, offset):
        with self.lock:
            size = len(self.buf)
            reset = offset < 0 or offset > size
            if reset:
                offset = 0
            data = self.buf[offset:size].decode("utf-8", "replace")
        return {"size": size, "start": 0, "offset": size, "data": data,
                "reset": reset, "running": self.running}

    def start(self, prompt, resume, label):
        with self.lock:
            if self.running:
                return False
            self.running = True
        threading.Thread(target=self._run, args=(prompt, resume, label),
                         daemon=True).start()
        return True

    def _run(self, prompt, resume, label):
        timer = None
        try:
            lead = "\n" if self.buf else ""
            self._append(f"{lead}{AI_BOLD}❯ {label}{AI_RESET}\n\n")
            cmd = [CLAUDE_BIN]
            if resume and self.session_id:
                cmd += ["--resume", self.session_id]
            cmd += ["-p", prompt, "--output-format", "stream-json",
                    "--verbose", "--allowedTools", "Read,Grep,Glob",
                    "--max-turns", "16"]
            proc = subprocess.Popen(
                cmd, cwd=self.workspace, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                text=True, errors="replace")
            timer = threading.Timer(600, proc.kill)  # a hung run dies here
            timer.start()
            first = True
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                t = msg.get("type")
                if t in ("system", "result"):
                    self.session_id = msg.get("session_id") or self.session_id
                    if t == "result":
                        secs = round((msg.get("duration_ms") or 0) / 1000)
                        self._append(f"\n{AI_DIM}─ answered in {secs}s"
                                     f" · ask a follow-up below"
                                     f"{AI_RESET}\n")
                elif t == "assistant":
                    for block in (msg.get("message") or {}).get("content", []):
                        if block.get("type") == "text":
                            text = block.get("text", "").strip()
                            if text:
                                self._append(("" if first else "\n")
                                             + text + "\n")
                                first = False
                        elif block.get("type") == "tool_use":
                            arg = block.get("input") or {}
                            hint = (arg.get("file_path") or arg.get("command")
                                    or arg.get("pattern") or arg.get("path")
                                    or "")
                            hint = " ".join(str(hint).split())[:100]
                            name = block.get("name", "tool")
                            self._append(f"{AI_DIM}  → {name} {hint}"
                                         f"{AI_RESET}\n")
            rc = proc.wait()
            if rc != 0:
                self._append(f"{AI_DIM}claude exited with rc {rc}"
                             f"{AI_RESET}\n")
        except Exception as exc:
            self._append(f"{AI_DIM}analysis failed: {exc}{AI_RESET}\n")
        finally:
            if timer is not None:
                timer.cancel()
            self.running = False
            try:
                with open(self._path(), "w") as f:
                    json.dump({"text": self.buf.decode("utf-8", "replace"),
                               "session_id": self.session_id}, f)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}


def query_int(q, key, default):
    try:
        return int(q.get(key, [default])[0])
    except (ValueError, TypeError):
        return default


class Handler(BaseHTTPRequestHandler):
    registry = None  # set in main()

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

    def _monitor(self, q):
        ws = q.get("ws", [None])[0]
        if not ws:
            return None
        return self.registry.monitor(ws, q.get("build", [None])[0])

    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = unquote(url.path)
        if path == "/api/stop":
            self._send(200, json.dumps({"ok": True}))
            # a handler thread may signal the serve_forever loop to end
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path == "/api/register":
            mon = self._monitor(q)
            if mon is None:
                return self._send(400, json.dumps({"error": "not a directory"}))
            return self._send(200, json.dumps(
                {"ok": True, "workspace": mon.workspace}))
        if path == "/api/favorite":
            ws = q.get("ws", [None])[0]
            if not ws:
                return self._send(400, json.dumps({"error": "no workspace"}))
            fav = q.get("fav", ["1"])[0] not in ("0", "false")
            self.registry.set_favorite(
                os.path.realpath(os.path.expanduser(ws)), fav)
            return self._send(200, json.dumps({"ok": True}))
        if path in ("/api/builds/delete", "/api/builds/prune"):
            return self._manage_builds(path, q)
        if path.startswith("/api/analyze/"):
            if not CLAUDE_BIN:
                return self._send(400, json.dumps(
                    {"error": "the claude CLI is not installed"}))
            mon = self._monitor(q)
            if mon is None:
                return self._send(400, json.dumps({"error": "no workspace"}))
            pkg = path[len("/api/analyze/"):]
            a = mon.analysis(pkg, q.get("build", [None])[0])
            if a is None:
                return self._send(400, json.dumps({"error": "bad request"}))
            question = (q.get("q", [None])[0] or "").strip()
            if question and a.session_id:
                started = a.start(question, True, question)
            elif a.buf and not question:
                started = False  # an answer exists: just open it
            else:
                prompt = mon.ai_prompt(pkg, a.build_dir)
                if question:  # a question, but no session to resume
                    prompt += f"\n\nThe user asks: {question}"
                started = a.start(
                    prompt, False,
                    question or f"why did {pkg} fail to build?")
            return self._send(200, json.dumps(
                {"ok": True, "started": started}))
        self._send(404, json.dumps({"error": "not found"}))

    def _manage_builds(self, path, q):
        ws = q.get("ws", [None])[0]
        if not ws:
            return self._send(400, json.dumps({"error": "no workspace"}))
        ws = os.path.realpath(os.path.expanduser(ws))
        log_dir = os.path.realpath(os.path.join(ws, self.registry.log_base))
        if not os.path.isdir(log_dir):
            return self._send(400, json.dumps({"error": "no log directory"}))
        live = self.registry.monitor(ws)
        active_build = None
        if live is not None:
            try:
                with live.lock:
                    st = json.loads(live.state_json)
                if st.get("active"):
                    active_build = st.get("build_id")
            except ValueError:
                pass

        def remove(build):
            target = os.path.realpath(os.path.join(log_dir, build))
            if not target.startswith(log_dir + os.sep):
                return 0
            size = 0
            for dp, _dn, fns in os.walk(target):
                for fn in fns:
                    try:
                        size += os.stat(os.path.join(dp, fn)).st_size
                    except OSError:
                        pass
            shutil.rmtree(target, ignore_errors=True)
            self.registry.drop_pinned(ws, build)
            return size

        if path == "/api/builds/delete":
            build = q.get("build", [None])[0]
            if not build or not re.fullmatch(r"build_[\w.-]+", build):
                return self._send(400, json.dumps({"error": "bad build id"}))
            if build == active_build:
                return self._send(400, json.dumps(
                    {"error": "the build runs now"}))
            freed = remove(build)
            result = {"ok": True, "deleted": 1, "freed": freed}
        else:
            keep = max(1, query_int(q, "keep", 3))
            try:
                names = sorted((d for d in os.listdir(log_dir)
                                if d.startswith("build_")), reverse=True)
            except OSError:
                names = []
            victims = [n for n in names[keep:] if n != active_build]
            freed = sum(remove(n) for n in victims)
            result = {"ok": True, "deleted": len(victims), "freed": freed}
        self.registry.stats_cache.pop(ws, None)
        if live is not None:
            live._builds_cache = None
        return self._send(200, json.dumps(result))

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = unquote(url.path)

        if path == "/api/ping":
            return self._send(200, json.dumps(
                {"app": "colcon-dashboard", "pid": os.getpid()}))
        if path == "/api/workspaces":
            return self._send(200, json.dumps(self.registry.overview()))
        if path == "/api/discover":
            found = [{"path": p, **self.registry.stats(p)}
                     for p in discover_workspaces()]
            found.sort(key=lambda w: -(w.get("builds") or 0))  # by use
            return self._send(200, json.dumps({"workspaces": found}))

        if path.startswith("/api/"):
            mon = self._monitor(q)
            if mon is None:
                return self._send(200, json.dumps(
                    {"error": "no workspace selected", "nows": True}))
            mon.last_request = time.time()
            if path == "/api/state":
                with mon.lock:
                    return self._send(200, mon.state_json)
            if path == "/api/graph":
                with mon.lock:
                    return self._send(200, mon.graph_json)
            if path == "/api/builds":
                return self._send(200, json.dumps(mon.list_builds()))
            if path == "/api/buildlog":
                ev = mon.events
                if ev is None:
                    return self._send(200, json.dumps(
                        {"size": 0, "start": 0, "offset": 0, "data": "",
                         "reset": False}))
                return self._send(200, json.dumps(ev.buildlog.read(
                    query_int(q, "offset", -1),
                    limit=query_int(q, "limit", 0) or None,
                    align=bool(query_int(q, "align", 0)))))
            if path.startswith("/api/analysis/"):
                if not CLAUDE_BIN:
                    return self._send(200, json.dumps({"ai": False}))
                a = mon.analysis(path[len("/api/analysis/"):],
                                 q.get("build", [None])[0])
                if a is None:
                    return self._send(400, json.dumps({"error": "bad request"}))
                return self._send(200, json.dumps(
                    a.read(query_int(q, "offset", -1))))
            if path.startswith("/api/log/"):
                pkg = path[len("/api/log/"):]
                which = q.get("file", ["combined"])[0]
                build = q.get("build", [None])[0]
                result = mon.read_log(
                    pkg, which, query_int(q, "offset", -1), build,
                    limit=query_int(q, "limit", 0) or None,
                    align=bool(query_int(q, "align", 0)))
                if result is None:
                    return self._send(400, json.dumps({"error": "bad request"}))
                return self._send(200, json.dumps(result))
            return self._send(404, json.dumps({"error": "not found"}))

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
# One server per machine
# ---------------------------------------------------------------------------

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

    def monitor(self, ws, build=None):
        try:
            ws = os.path.realpath(os.path.expanduser(ws))
        except (OSError, ValueError):
            return None
        if not os.path.isdir(ws):
            return None
        if build and not re.fullmatch(r"build_[\w.-]+", build):
            return None
        key = (ws, build)
        with self.lock:
            mon = self.monitors.get(key)
            if mon is None:
                mon = BuildMonitor(ws, self.log_base, pin_build=build)
                self.monitors[key] = mon
                threading.Thread(target=mon.run, daemon=True).start()
        self.touch(ws)
        return mon

    def drop_pinned(self, ws, build):
        with self.lock:
            mon = self.monitors.pop((ws, build), None)
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


if __name__ == "__main__":
    main()
