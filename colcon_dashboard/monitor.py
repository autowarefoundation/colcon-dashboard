"""BuildMonitor: one background scanner per (workspace, pinned build).

Follows log/latest_build, replays events.log into job states, reduces the
dependency graph, samples system pressure, and serves log chunks.
"""

import json
import os
import re
import threading
import time

from .ai import AIAnalysis, CLAUDE_BIN
from .events import EventLog, RC_RE, parse_build_id_time
from .packages import PackageIndex, parse_namespace

LOG_FILES = {
    "combined": "stdout_stderr.log",
    "stdout": "stdout.log",
    "stderr": "stderr.log",
    "command": "command.log",
    "streams": "streams.log",
}


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
