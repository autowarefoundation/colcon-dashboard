"""Transient read-only agent executed by the dashboard over SSH.

This module is sent over stdin and executed from memory on the remote host. It
must use only the Python standard library and must not import the dashboard.
"""

import json
import os
import sys
import time


ROOT = None
PREV_CPU = {}
LOG_FILES = {"stdout_stderr.log", "stdout.log", "stderr.log",
             "command.log", "streams.log"}
PRUNE = {"build", "install", "log", "node_modules", "__pycache__"}


def _inside(path):
    path = os.path.realpath(path)
    if ROOT is None or not (path == ROOT or path.startswith(ROOT + os.sep)):
        raise ValueError("path escapes the workspace")
    return path


def _path(rel):
    if not isinstance(rel, str) or os.path.isabs(rel):
        raise ValueError("expected a relative path")
    return _inside(os.path.join(ROOT, rel))


def _entry(rel):
    try:
        path = _path(rel)
        st = os.stat(path)
    except (OSError, ValueError):
        return None
    return {"path": rel, "size": st.st_size, "mtime": st.st_mtime}


def _run_names(log_base):
    path = _path(log_base)
    try:
        return sorted(n for n in os.listdir(path)
                      if n.startswith(("build_", "test_"))
                      and os.path.isdir(os.path.join(path, n)))
    except OSError:
        return []


def _latest(log_base, link):
    path = os.path.join(_path(log_base), link)
    if not os.path.isdir(path):
        return None
    return os.path.basename(os.path.realpath(path))


def _run_manifest(log_base, names, all_files):
    entries = []
    added = set()
    for name in names:
        run = os.path.join(log_base, name)
        root = _path(run)
        for fixed in ("events.log", "logger_all.log"):
            item = _entry(os.path.join(run, fixed))
            if item:
                item["content"] = True
                entries.append(item)
                added.add(item["path"])
        for dirpath, _dirs, files in os.walk(root):
            for filename in files:
                if not all_files and filename not in LOG_FILES:
                    continue
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, ROOT)
                if rel in added:
                    continue
                item = _entry(rel)
                if item:
                    item["content"] = False
                    entries.append(item)
                    added.add(rel)
    return entries


def _package_manifest(base_paths):
    entries = []
    seen = set()
    for base in base_paths or ["."]:
        if not isinstance(base, str):
            continue
        if os.path.isabs(base):
            real = os.path.realpath(base)
            if real == ROOT or real.startswith(ROOT + os.sep):
                root = real
            else:
                # A path from a container mount can end in the same relative
                # base path. Fall back to that tail, like the local scanner.
                tail = base.lstrip(os.sep).split(os.sep)
                root = ROOT
                for i in range(len(tail)):
                    candidate = os.path.join(ROOT, *tail[i:])
                    if os.path.isdir(candidate):
                        root = candidate
                        break
        else:
            root = _inside(os.path.join(ROOT, base))
        if not os.path.isdir(root):
            continue
        for dirpath, dirs, files in os.walk(root):
            rel = os.path.relpath(dirpath, ROOT)
            depth = 0 if rel == "." else rel.count(os.sep) + 1
            if depth > 14:
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs
                       if not d.startswith(".") and d not in PRUNE]
            if "COLCON_IGNORE" in files:
                dirs[:] = []
                continue
            if "package.xml" in files:
                item = _entry(os.path.join(rel, "package.xml"))
                if item and item["path"] not in seen:
                    item["content"] = True
                    entries.append(item)
                    seen.add(item["path"])
                dirs[:] = []
    return entries


def _test_manifest(build_base):
    if not isinstance(build_base, str):
        return []
    if os.path.isabs(build_base):
        real = os.path.realpath(build_base)
        if not (real == ROOT or real.startswith(ROOT + os.sep)):
            return []
        root = real
    else:
        root = _path(build_base)
    entries = []
    if not os.path.isdir(root):
        return entries
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in {"CMakeFiles", "cmake"}]
        in_results = "test_results" in dirpath.split(os.sep)
        for filename in files:
            if filename == "pytest.xml" or (in_results and filename.endswith(".xml")):
                rel = os.path.relpath(os.path.join(dirpath, filename), ROOT)
                item = _entry(rel)
                if item:
                    item["content"] = True
                    entries.append(item)
    return entries


def _system():
    global PREV_CPU
    info = {}
    try:
        rows = []
        with open("/proc/stat") as f:
            for line in f:
                if not line.startswith("cpu"):
                    break
                parts = line.split()
                vals = [int(x) for x in parts[1:11]]
                rows.append((parts[0], sum(vals), vals[3] + vals[4]))
        old, PREV_CPU = PREV_CPU, {n: (t, i) for n, t, i in rows}
        cores = []
        for name, total, idle in rows:
            prev = old.get(name)
            if not prev or total <= prev[0]:
                continue
            pct = round(100 * (1 - (idle - prev[1]) / (total - prev[0])), 1)
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
                key, _, value = line.partition(":")
                if key in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
                    mem[key] = int(value.strip().split()[0])
        if mem.get("MemTotal"):
            info["mem_total"] = mem["MemTotal"]
            info["mem_used"] = mem["MemTotal"] - mem.get("MemAvailable", 0)
        if mem.get("SwapTotal"):
            info["swap_total"] = mem["SwapTotal"]
            info["swap_used"] = mem["SwapTotal"] - mem.get("SwapFree", 0)
    except (OSError, ValueError):
        pass
    return info or None


def dispatch(request):
    global ROOT
    op = request.get("op")
    if op == "init":
        root = os.path.realpath(os.path.expanduser(request.get("root", "")))
        if not os.path.isdir(root):
            raise ValueError("workspace is not a directory: " + root)
        ROOT = root
        return {"root": ROOT, "python": list(sys.version_info[:3])}, None
    if ROOT is None:
        raise ValueError("agent is not initialized")
    if op == "manifest":
        log_base = request.get("log_base", "log")
        names = _run_names(log_base)
        latest = [_latest(log_base, n) for n in ("latest_build", "latest_test")]
        current = [n for n in latest if n in names]
        if not current and names:
            current = [names[-1]]
        selected = names if request.get("history") else current
        return {
            "runs": names,
            "latest_build": latest[0],
            "latest_test": latest[1],
            "files": _run_manifest(log_base, selected, request.get("history", False)),
        }, None
    if op == "packages":
        return {"files": _package_manifest(request.get("base_paths"))}, None
    if op == "tests":
        return {"files": _test_manifest(request.get("build_base", "build"))}, None
    if op == "read":
        path = _path(request.get("path", ""))
        offset = max(0, int(request.get("offset", 0)))
        limit = min(max(0, int(request.get("limit", 512 * 1024))), 32 * 1024 * 1024)
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(offset)
                data = f.read(limit)
        except OSError:
            return {"missing": True, "size": 0, "offset": 0}, None
        return {"size": size, "offset": offset + len(data)}, data
    if op == "system":
        return _system(), None
    if op == "ping":
        return {"time": time.time()}, None
    raise ValueError("unknown operation: " + str(op))


def main():
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    while True:
        line = inp.readline()
        if not line:
            return
        request_id = None
        try:
            request = json.loads(line.decode("utf-8"))
            request_id = request.get("id")
            result, data = dispatch(request)
            response = {"id": request_id, "ok": True, "result": result,
                        "data_length": len(data) if data else 0}
        except Exception as exc:
            data = None
            response = {"id": request_id, "ok": False,
                        "error": "%s: %s" % (type(exc).__name__, exc),
                        "data_length": 0}
        out.write(json.dumps(response, separators=(",", ":")).encode() + b"\n")
        if data:
            out.write(data)
        out.flush()


main()
