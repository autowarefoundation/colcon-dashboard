"""The HTTP layer: the API endpoints and the static single-page UI."""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .ai import CLAUDE_BIN
from .config import CONFIG
from .events import BUILD_DIR_RE
from .monitor import prune_builds, remove_build_dir
from .registry import discover_workspaces, update_status

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

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
        monitored = None
        if live is not None:
            try:
                with live.lock:
                    st = json.loads(live.state_json)
                monitored = st.get("build_id")
                if st.get("active"):
                    active_build = monitored
            except ValueError:
                pass

        if path == "/api/builds/delete":
            build = q.get("build", [None])[0]
            if not build or not BUILD_DIR_RE.fullmatch(build):
                return self._send(400, json.dumps({"error": "bad build id"}))
            if build == active_build:
                return self._send(400, json.dumps(
                    {"error": "the build runs now"}))
            if build != monitored:
                # a live `colcon test` run has no monitor following it;
                # the monitored build already passed the real active check
                try:
                    mtime = os.path.getmtime(
                        os.path.join(log_dir, build, "events.log"))
                    if time.time() - mtime < 15.0:
                        return self._send(400, json.dumps(
                            {"error": "the run is still active"}))
                except OSError:
                    pass
            freed = remove_build_dir(log_dir, build)
            self.registry.drop_pinned(ws, build)
            result = {"ok": True, "deleted": 1, "freed": freed}
        else:
            keep = max(1, query_int(q, "keep", 3))
            protect = {active_build} if active_build else set()
            deleted, freed = prune_builds(log_dir, keep, protect)
            for name in deleted:
                self.registry.drop_pinned(ws, name)
            result = {"ok": True, "deleted": len(deleted), "freed": freed}
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
                {"app": "colcon-dashboard", "pid": os.getpid(),
                 "version": __version__}))
        if path == "/api/config":
            return self._send(200, json.dumps({
                "version": __version__,
                "editor_url": CONFIG.editor_url,
                "log_base": self.registry.log_base,
                "config": {
                    "path": CONFIG.path,
                    "exists": CONFIG.exists,
                    "host": CONFIG.host,
                    "port": CONFIG.port,
                    "log_base": CONFIG.log_base,
                    "auto_prune_keep": CONFIG.auto_prune_keep,
                    "check_updates": CONFIG.check_updates,
                    "claude_bin": CONFIG.claude_bin,
                    "editor_url": CONFIG.editor_url,
                },
            }))
        if path == "/api/workspaces":
            overview = self.registry.overview()
            update = update_status()
            if update:
                overview["update"] = update
            return self._send(200, json.dumps(overview))
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
