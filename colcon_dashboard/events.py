"""Parsing of the logs colcon writes under log/<build>/.

Everything that knows colcon's log format lives here: the events.log
tailer (the ground truth for job states), the combined build log it
synthesizes, and the build-id naming convention.
"""

import ast
import os
import re
import threading
from datetime import datetime, timezone

EVENT_RE = re.compile(rb"^\[\s*([0-9.]+)\] \(([^)]*)\) (\w+): (.*)$")
RC_RE = re.compile(rb"'rc': (?:'([^']+)'|(-?\d+))")
PROGRESS_RE = re.compile(rb"'progress': '([^']*)'")
DEP_KEY_RES = (re.compile(rb"'([^']+)': '/"),      # dict repr  {'name': '/path'}
               re.compile(rb"\('([^']+)', '/"))    # legacy     [('name', '/path')]
PCT_RE = re.compile(rb"\[\s*(\d{1,3})%\]")
# only the command of a Command event: its payload also holds the whole
# environment, which can be large
CMD_RE = re.compile(rb"'cmd': (\[.*?\]), 'cwd'")
RETURNCODE_RE = re.compile(rb"'returncode': (-?\d+)")
# compiler and CMake warnings
WARNING_RE = re.compile(rb"warning:|CMake Warning")

# the log directories colcon writes per run: build_<stamp>, test_<stamp>
BUILD_DIR_RE = re.compile(r"(?:build|test)_[\w.-]+")


def parse_build_id_time(build_id, utc=False):
    """build_2026-08-09_09-56-51 -> epoch seconds, or None. The name holds
    the local time of the machine that ran colcon: this machine's time
    zone by default, UTC with utc=True."""
    m = re.search(r"(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})", build_id)
    if not m:
        return None
    try:
        dt = datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S")
        if utc:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, OverflowError, OSError):  # build_9999-12-31_...
        return None


# The seconds from the time in a run name to the start that a log
# gives. logger_all.log counts wall-clock time from when Python loads the
# logging module, about 0.1 s before colcon names the run. events.log
# counts from the first event, after colcon reads the workspace (up to
# 13 s on a 500-package workspace). It counts monotonic time, which
# stops while the computer sleeps.
LOGGER_DELAY = (-60.0, 60.0)
EVENTS_DELAY = (-5.0, 300.0)

# the time at the start of each logger_all.log record: the seconds since
# Python loaded the logging module. From Python 3.13, colcon subtracts
# that load time in nanoseconds from the record time in seconds. The
# negative result holds the load time itself.
LOGGER_TIME_RE = re.compile(rb"^\[(-?\d+\.\d+)s\] ")

# the logs that give the start of a run, the most exact first
START_LOGS = (("logger_all.log", LOGGER_TIME_RE, LOGGER_DELAY),
              ("events.log", EVENT_RE, EVENTS_DELAY))


def run_start(build_id, start, delay):
    """When a run started, in epoch seconds, or None.

    colcon names a run with the local time of the machine that runs it.
    A container usually runs on UTC (the Docker default), so on a host in
    another time zone the name of a container run is hours off. start is
    the real start from a log (file_start), or None, and delay the range
    of start minus the name time for that log. When the name read as
    local time does not fit start, but read as UTC it does, the run came
    from a UTC machine."""
    local = parse_build_id_time(build_id)
    if local is None or start is None:
        return local
    lo, hi = delay
    if lo <= start - local <= hi:
        return local
    utc = parse_build_id_time(build_id, utc=True)
    if lo <= start - utc <= hi:
        return utc
    return local  # a copied or touched file: its time tells nothing


def last_time(path, line_re):
    """The time in the last line of a log that matches line_re, from the
    last 4 MiB of the file, or None."""
    try:
        with open(path, "rb") as f:
            size = f.seek(0, os.SEEK_END)
            # the last line can be long, for example a Command event with
            # the whole environment: read more when the end holds no match
            for chunk in (4096, 256 * 1024, 4 * 1024 * 1024):
                f.seek(max(0, size - chunk))
                lines = f.read().split(b"\n")
                if size > chunk:
                    lines = lines[1:]  # the first line can start mid-line
                for line in reversed(lines):
                    m = line_re.match(line)
                    if m:
                        return float(m.group(1))
                if size <= chunk:
                    break
    except OSError:
        pass
    return None


def last_event_time(path):
    """The time of the last event in an events.log, or None."""
    return last_time(path, EVENT_RE)


def _mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return None


def file_start(build_dir, mtimes=None):
    """When colcon started a run: the time of the last write to a log of
    the run minus the time of its last line in that log. Returns (start,
    delay) from the first log of START_LOGS that gives a time, or
    (None, None)."""
    for i, (name, line_re, delay) in enumerate(START_LOGS):
        path = os.path.join(build_dir, name)
        mtime = mtimes[i] if mtimes else _mtime(path)
        t = last_time(path, line_re) if mtime else None
        if t is None:
            continue
        # Python 3.13 and newer: about -1.8e18, the start (LOGGER_TIME_RE).
        # A small negative time is a wall clock that went back in the run.
        if t < -1e9:
            return -t / (1 - 1e-9) / 1e9, delay
        return mtime - t, delay
    return None, None


_starts = {}  # run folder -> (mtimes of START_LOGS, start)


def run_start_time(build_dir):
    """run_start for a run folder, cached until its logs change."""
    mtimes = tuple(_mtime(os.path.join(build_dir, log[0])) for log in START_LOGS)
    hit = _starts.get(build_dir)
    if hit and hit[0] == mtimes:
        return hit[1]
    start = run_start(os.path.basename(build_dir), *file_start(build_dir, mtimes))
    if len(_starts) > 4096:  # pruned runs leave their entries behind
        _starts.clear()
    _starts[build_dir] = (mtimes, start)
    return start


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
                "stderr_lines": 0, "test_failed": False, "warnings": 0,
                "cmd": None, "fail_cmd": None,
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
            if WARNING_RE.search(payload):
                job["warnings"] += 1
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
        elif event == b"Command":
            cm = CMD_RE.search(payload)
            if cm:
                try:
                    self._job(name)["cmd"] = " ".join(
                        str(a) for a in ast.literal_eval(cm.group(1).decode("utf-8", "replace")))
                except (ValueError, SyntaxError):
                    pass
        elif event == b"CommandEnded":
            rm = RETURNCODE_RE.search(payload)
            job = self._job(name)
            if rm and int(rm.group(1)) != 0 and job["cmd"]:
                job["fail_cmd"] = job["cmd"]  # the step that failed
        elif event == b"TestFailure":
            # colcon test keeps the job's rc at 0 when tests fail and sends
            # this event instead
            self._job(name)["test_failed"] = True
            self.buildlog.append(f"[{t:9.3f}s] Tests failed in {name}")
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
