"""Parsing of the logs colcon writes under log/<build>/.

Everything that knows colcon's log format lives here: the events.log
tailer (the ground truth for job states), the combined build log it
synthesizes, and the build-id naming convention.
"""

import ast
import os
import re
import threading
from datetime import datetime

EVENT_RE = re.compile(rb"^\[\s*([0-9.]+)\] \(([^)]*)\) (\w+): (.*)$")
RC_RE = re.compile(rb"'rc': (?:'([^']+)'|(-?\d+))")
PROGRESS_RE = re.compile(rb"'progress': '([^']*)'")
DEP_KEY_RES = (re.compile(rb"'([^']+)': '/"),      # dict repr  {'name': '/path'}
               re.compile(rb"\('([^']+)', '/"))    # legacy     [('name', '/path')]
PCT_RE = re.compile(rb"\[\s*(\d{1,3})%\]")


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
