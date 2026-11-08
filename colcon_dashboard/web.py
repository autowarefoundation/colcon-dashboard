"""The HTTP layer: the API endpoints and the static single-page UI."""

import ipaddress
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import __version__, notify, service
from .ai import CLAUDE_BIN
from .config import CONFIG, save_extra_roots
from .events import BUILD_DIR_RE
from .monitor import prune_builds, remove_build_dir
from .registry import discover_all, update_status

STARTED = time.time()  # the settings dialog sees a restart by this
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".webmanifest": "application/manifest+json"}


def _local_names():
    names = {"localhost"}
    for name in (socket.gethostname(), socket.getfqdn()):
        if name:
            names.add(name.lower())
    return names


LOCAL_NAMES = _local_names()


def host_allowed(host):
    """Accept a Host header that names this machine: an IP address,
    localhost, or the machine's own name. A DNS rebinding attack points a
    foreign domain name at 127.0.0.1, and its Host header fails here."""
    if not host:
        return True  # HTTP/1.0 clients; browsers always send Host
    name = host.lower()
    if name.startswith("["):  # [::1]:8642
        name = name[1:name.find("]")] if "]" in name else name[1:]
    elif name.count(":") == 1:
        name = name.rsplit(":", 1)[0]
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    return name in LOCAL_NAMES or name.endswith(".localhost")


def same_origin(headers):
    """Refuse a request that a page on another site sent. Browsers send
    Origin with every cross-site POST, also with mode: 'no-cors'. The CLI
    and curl send no Origin and pass."""
    origin = headers.get("Origin")
    if origin is not None:
        return urlparse(origin).netloc.lower() == (headers.get("Host") or "").lower()
    site = headers.get("Sec-Fetch-Site")
    return site in (None, "same-origin", "none")


def query_int(q, key, default):
    try:
        return int(q.get(key, [default])[0])
    except (ValueError, TypeError):
        return default


class Handler(BaseHTTPRequestHandler):
    registry = None  # set in main()
    on_stop = None  # set in main(): ends every listener (IPv4 and IPv6)
    restart_requested = False  # main() starts the server again after the stop

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

    def _trusted(self, post):
        """Answer 403 to a foreign Host header, or to a POST from another
        site: without this, any web page could stop the server, delete
        build logs, or start claude runs."""
        if not host_allowed(self.headers.get("Host")):
            self._send(403, json.dumps({"error": "unknown Host header"}))
            return False
        if post and not same_origin(self.headers):
            self._send(403, json.dumps({"error": "cross-site request"}))
            return False
        return True

    def _monitor(self, q):
        ws = q.get("ws", [None])[0]
        if not ws:
            return None
        return self.registry.monitor(ws, q.get("build", [None])[0])

    def do_POST(self):
        if not self._trusted(post=True):
            return
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = unquote(url.path)
        if path == "/api/stop":
            self._send(200, json.dumps({"ok": True}))
            # a handler thread may signal the serve_forever loop to end
            stop = Handler.on_stop or self.server.shutdown
            threading.Thread(target=stop, daemon=True).start()
            return
        if path == "/api/client-error":
            # a page that failed to start reports why (index.html): the
            # service log (journalctl --user -u colcon-dashboard) shows it
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 4096)
            except ValueError:
                n = 0
            text = self.rfile.read(n).decode("utf-8", "replace") if n else ""
            print(f"page error: {text}", file=sys.stderr, flush=True)
            return self._send(200, json.dumps({"ok": True}))
        if path == "/api/server/restart":
            if service.under_service():
                # systemd ends this process and starts a new one
                self._send(200, json.dumps({"ok": True}))
                threading.Timer(0.2, service.restart_unit).start()
                return
            self._send(200, json.dumps({"ok": True}))
            Handler.restart_requested = True
            stop = Handler.on_stop or self.server.shutdown
            threading.Thread(target=stop, daemon=True).start()
            return
        if path in ("/api/server/login", "/api/server/tray"):
            on = q.get("on", ["1"])[0] not in ("0", "false")
            if path.endswith("/login"):
                ok, msg = service.set_login(on)
            else:
                ok, msg = service.set_tray_autostart(on)
            return self._send(200 if ok else 400, json.dumps(
                {"ok": ok, "message": msg, **self._server_info()}))
        if path == "/api/notify":
            if not self.registry.set_notify_mode(q.get("mode", [""])[0]):
                return self._send(400, json.dumps({"error": "mode: off, on, or sound"}))
            return self._send(200, json.dumps({"ok": True, "mode": self.registry.notify_mode}))
        if path == "/api/notify/test":
            return self._send(200, json.dumps({"ok": self.registry.test_notify()}))
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
        if path == "/api/scan-roots/set":
            return self._set_scan_roots(q)
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

    def _server_info(self):
        """How this server runs, for the settings dialog."""
        systemd = service.user_systemd_works()
        return {
            "pid": os.getpid(),
            "service": service.under_service(),
            "systemd": systemd,
            "login": systemd and service.login_enabled(),
            "tray": {"supported": service.tray_supported(),
                     "autostart": service.tray_autostart()},
        }

    def _set_scan_roots(self, q):
        """Replace the extra_roots list in config.ini with q's paths."""
        roots = []
        for p in q.get("path", []):
            p = p.strip()
            if not p:
                continue
            if any(c in p for c in ",;#\n"):  # the ini syntax needs them
                return self._send(400, json.dumps(
                    {"error": "a path with , ; # or a newline"}))
            p = os.path.abspath(os.path.expanduser(p))
            # a root already in the list may be gone (an unplugged drive)
            if p not in CONFIG.extra_roots and not os.path.isdir(p):
                return self._send(400, json.dumps(
                    {"error": "not a directory: " + p}))
            if p not in roots:
                roots.append(p)
        if save_extra_roots(roots, CONFIG.path) is None:
            return self._send(500, json.dumps(
                {"error": "cannot write " + CONFIG.path}))
        CONFIG.extra_roots = roots
        CONFIG.exists = True
        return self._send(200, json.dumps({"ok": True, "roots": roots}))

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
            if os.path.isdir(os.path.join(log_dir, build)):
                result = {"ok": False, "freed": freed, "error":
                          "some files could not be deleted (owned by another "
                          "user, for example after a sudo or Docker build)"}
            else:
                self.registry.drop_pinned(ws, build)
                result = {"ok": True, "deleted": 1, "freed": freed}
        else:
            keep = max(1, query_int(q, "keep", 3))
            protect = {active_build} if active_build else set()
            failed = []
            deleted, freed = prune_builds(log_dir, keep, protect, failed)
            for name in deleted:
                self.registry.drop_pinned(ws, name)
            result = {"ok": True, "deleted": len(deleted), "freed": freed,
                      "failed": failed}
        self.registry.stats_cache.pop(ws, None)
        if live is not None:
            live._builds_cache = None
        return self._send(200, json.dumps(result))

    def do_GET(self):
        if not self._trusted(post=False):
            return
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = unquote(url.path)

        if path == "/api/ping":
            return self._send(200, json.dumps(
                {"app": "colcon-dashboard", "pid": os.getpid(),
                 "version": __version__, "started": STARTED}))
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
                    "extra_roots": CONFIG.extra_roots,
                    "browser": CONFIG.browser,
                },
                "notify": {"desktop": notify.available(),
                           "mode": self.registry.notify_mode},
            }))
        if path == "/api/server":
            return self._send(200, json.dumps(self._server_info()))
        if path == "/api/live":
            return self._send(200, json.dumps(
                {"version": __version__, "pid": os.getpid(),
                 "workspaces": self.registry.live()}))
        if path == "/api/workspaces":
            overview = self.registry.overview()
            overview["home"] = os.path.expanduser("~")
            update = update_status()
            if update:
                overview["update"] = update
            return self._send(200, json.dumps(overview))
        if path == "/api/scan-roots":
            return self._send(200, json.dumps({
                "home": os.path.expanduser("~"),
                "roots": CONFIG.extra_roots,
                "config_path": CONFIG.path,
            }))
        if path == "/api/discover":
            found = [{"path": p, **self.registry.stats(p)}
                     for p in discover_all(CONFIG.extra_roots)]
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

        if path == "/last":
            # the tray, --app, and the installed app open the workspace that
            # was viewed last, on its newest build; with none, the start page
            ws = self.registry.last_workspace()
            target = "/?ws=" + quote(ws, safe="") if ws else "/"
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return

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
