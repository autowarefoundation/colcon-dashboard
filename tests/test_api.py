"""web.py + registry.py: the HTTP API against a real server on a random port.

The server's persisted paths (recents, cache) are redirected into a temp
directory, so the test never touches the user's real state or a running
dashboard.
"""

import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

from colcon_dashboard import __version__
from colcon_dashboard import registry as registry_mod
from colcon_dashboard.config import CONFIG, Config
from colcon_dashboard.monitor import BuildMonitor
from colcon_dashboard.registry import Registry
from colcon_dashboard.web import Handler
from tests.helpers import ended, event_line, make_build, queued, started

# pybuild blocks network during deb builds by exporting
# http_proxy=http://127.0.0.1:9/, and urllib proxies even loopback
# requests; these must reach the test server directly.
urllib.request.install_opener(
    urllib.request.build_opener(urllib.request.ProxyHandler({})))

BUILD_ID = "build_2026-08-09_10-00-00"


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.ws = os.path.join(cls.tmp.name, "ws")
        bdir = make_build(cls.ws, BUILD_ID, [
            queued(0.1, "a"),
            queued(0.1, "b", deps=["a"]),
            started(0.2, "a"),
            event_line(0.4, "a", "StdoutLine", "{'line': b'hello api\\n'}"),
            ended(1.0, "a"),
            event_line(2.0, "-", "EventReactorShutdown"),
        ])
        os.makedirs(os.path.join(bdir, "a"))
        with open(os.path.join(bdir, "a", "stdout_stderr.log"), "w") as f:
            f.write("pkg log line\n")

        registry_mod.CACHE_DIR = os.path.join(cls.tmp.name, "cache")
        registry_mod.SERVER_FILE = os.path.join(registry_mod.CACHE_DIR, "server.json")
        registry_mod.REGISTRY_FILE = os.path.join(registry_mod.CACHE_DIR, "workspaces.json")

        Handler.registry = Registry()
        ThreadingHTTPServer.daemon_threads = True
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=5) as r:
                return r.status, r.read(), r.headers.get("Content-Type", "")
        except urllib.error.HTTPError as e:
            return e.code, e.read(), ""

    def request(self, path, method="GET", headers=None):
        req = urllib.request.Request(self.base + path, data=b"" if method == "POST" else None,
                                     method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_idle_pinned_monitor_stops(self):
        reg = Handler.registry
        mon = reg.monitor(self.ws, BUILD_ID)
        mon.last_request -= reg.PINNED_IDLE + 1
        fresh = reg.monitor(self.ws, BUILD_ID)
        self.assertTrue(mon.stopped)
        self.assertIsNot(fresh, mon)
        self.assertFalse(fresh.stopped)

    def test_cross_site_post_is_refused(self):
        host = self.base.split("//", 1)[1]
        evil = {"Origin": "https://evil.example"}
        self.assertEqual(self.request("/api/favorite?ws=/nope", "POST", evil), 403)
        self.assertEqual(self.request("/api/favorite?ws=/nope", "POST",
                                      {"Sec-Fetch-Site": "cross-site"}), 403)
        # the dashboard page itself, and clients without Origin, pass
        self.assertEqual(self.request("/api/favorite?ws=/nope", "POST",
                                      {"Origin": "http://" + host}), 200)
        self.assertEqual(self.request("/api/favorite?ws=/nope", "POST"), 200)

    def test_foreign_host_header_is_refused(self):
        # DNS rebinding: a foreign name that resolves to 127.0.0.1
        port = self.server.server_address[1]
        self.assertEqual(self.request("/api/ping", headers={"Host": f"evil.example:{port}"}), 403)
        for host in (f"localhost:{port}", f"127.0.0.1:{port}", f"[::1]:{port}"):
            self.assertEqual(self.request("/api/ping", headers={"Host": host}), 200, host)

    def post(self, path):
        req = urllib.request.Request(self.base + path, data=b"", method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def state(self, timeout=8.0):
        """Poll /api/state until the monitor thread's first scan lands."""
        wsq = urllib.parse.quote(self.ws, safe="")
        deadline = time.time() + timeout
        while time.time() < deadline:
            _, body, _ = self.get("/api/state?ws=" + wsq)
            s = json.loads(body)
            if s.get("build_id"):
                return s
            time.sleep(0.1)
        self.fail("monitor never produced a state")

    def wsq(self):
        return urllib.parse.quote(self.ws, safe="")

    def test_installable_app_files(self):
        st, body, ctype = self.get("/manifest.webmanifest")
        self.assertEqual(st, 200)
        self.assertTrue(ctype.startswith("application/manifest+json"), ctype)
        manifest = json.loads(body)
        self.assertEqual(manifest["start_url"], "/last")
        self.assertEqual(manifest["display"], "standalone")
        sizes = set()
        for icon in manifest["icons"]:
            st, _, ctype = self.get("/" + icon["src"])
            self.assertEqual(st, 200, icon["src"])
            self.assertTrue(ctype.startswith(icon["type"]), icon["src"])
            sizes.add(icon["sizes"])
        # Chrome installs an app only with icons of at least these sizes
        self.assertTrue({"192x192", "512x512"} <= sizes)
        # a service worker controls only the paths below its own path
        st, _, ctype = self.get("/sw.js")
        self.assertEqual(st, 200)
        self.assertTrue(ctype.startswith("text/javascript"), ctype)
        self.assertEqual(self.get("/offline.html")[0], 200)

    def test_last_opens_the_last_viewed_workspace(self):
        self.get("/api/state?ws=" + self.wsq())  # viewing it puts it first
        with urllib.request.urlopen(self.base + "/last", timeout=5) as r:
            self.assertEqual(r.geturl(), self.base + "/?ws=" + self.wsq())
        reg = Handler.registry
        saved = reg.recents
        self.addCleanup(setattr, reg, "recents", saved)
        reg.recents = [{"path": "/gone", "last_used": 1}]  # no workspace left
        with urllib.request.urlopen(self.base + "/last", timeout=5) as r:
            self.assertEqual(r.geturl(), self.base + "/")

    def test_a_page_error_reaches_the_log(self):
        import contextlib
        import io
        buf = io.StringIO()
        req = urllib.request.Request(self.base + "/api/client-error", method="POST",
                                     data=b"failed to load app.js | http://x/ | UA")
        with contextlib.redirect_stderr(buf):
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual(r.status, 200)
        self.assertIn("page error: failed to load app.js", buf.getvalue())

    def test_ping(self):
        st, body, _ = self.get("/api/ping")
        self.assertEqual(st, 200)
        ping = json.loads(body)
        self.assertEqual(ping["app"], "colcon-dashboard")
        self.assertEqual(ping["version"], __version__)

    def test_config_endpoint(self):
        st, body, _ = self.get("/api/config")
        self.assertEqual(st, 200)
        d = json.loads(body)
        self.assertEqual(d["version"], __version__)
        self.assertFalse(d["config"]["exists"])  # tests isolate the config
        self.assertIn("auto_prune_keep", d["config"])
        self.assertEqual(d["config"]["extra_roots"], [])

    def test_workspaces_has_no_update_note_by_default(self):
        _, body, _ = self.get("/api/workspaces")
        self.assertNotIn("update", json.loads(body))

    def test_delete_accepts_test_runs_but_not_live_ones(self):
        test_dir = os.path.join(self.ws, "log", "test_2026-08-09_11-00-00")
        os.makedirs(test_dir, exist_ok=True)
        events = os.path.join(test_dir, "events.log")
        with open(events, "w") as f:
            f.write("x")
        url = ("/api/builds/delete?ws=" + self.wsq()
               + "&build=test_2026-08-09_11-00-00")
        st, r = self.post(url)  # a fresh events.log means the run is live
        self.assertEqual(st, 400)
        self.assertTrue(os.path.exists(test_dir))
        old = time.time() - 3600
        os.utime(events, (old, old))
        st, r = self.post(url)
        self.assertEqual(st, 200)
        self.assertTrue(r["ok"])
        self.assertFalse(os.path.exists(test_dir))

    def test_static_index_and_traversal_guard(self):
        st, body, ctype = self.get("/")
        self.assertEqual(st, 200)
        self.assertIn(b"Colcon Dashboard", body)
        self.assertIn("text/html", ctype)
        st, _, _ = self.get("/..%2fpyproject.toml")
        self.assertEqual(st, 404)

    def test_no_workspace_fallback(self):
        _, body, _ = self.get("/api/state")
        self.assertTrue(json.loads(body).get("nows"))

    def test_state_and_graph(self):
        s = self.state()
        self.assertEqual(s["build_id"], BUILD_ID)
        self.assertEqual(s["packages"]["a"]["s"], "done")
        _, body, _ = self.get("/api/graph?ws=" + self.wsq())
        g = json.loads(body)
        self.assertEqual(g["packages"]["b"]["deps"], ["a"])

    def test_buildlog_and_package_log(self):
        self.state()
        _, body, _ = self.get("/api/buildlog?ws=" + self.wsq())
        self.assertIn("hello api", json.loads(body)["data"])
        _, body, _ = self.get("/api/log/a?ws=" + self.wsq())
        self.assertIn("pkg log line", json.loads(body)["data"])
        self.assertNotIn("missing", json.loads(body))
        # a file the build never wrote: the page shows a note, not a blank pane
        _, body, _ = self.get("/api/log/a?file=streams&ws=" + self.wsq())
        self.assertTrue(json.loads(body)["missing"])

    def test_builds_listing(self):
        self.state()
        _, body, _ = self.get("/api/builds?ws=" + self.wsq())
        b = json.loads(body)
        self.assertEqual(b["builds"][0]["id"], BUILD_ID)

    def test_workspaces_and_favorite(self):
        self.state()  # registers the workspace
        st, r = self.post("/api/favorite?ws=" + self.wsq() + "&fav=1")
        self.assertEqual(st, 200)
        _, body, _ = self.get("/api/workspaces")
        entry = next(w for w in json.loads(body)["workspaces"]
                     if w["path"] == self.ws)
        self.assertTrue(entry["fav"])

    def test_register(self):
        st, r = self.post("/api/register?ws=" + self.wsq())
        self.assertEqual(st, 200)
        self.assertEqual(r["workspace"], self.ws)

    def test_delete_rejects_bad_build_id(self):
        st, r = self.post("/api/builds/delete?ws=" + self.wsq()
                          + "&build=../../etc")
        self.assertEqual(st, 400)

    def use_tmp_config(self):
        saved = (CONFIG.path, CONFIG.exists, CONFIG.extra_roots)
        CONFIG.path = os.path.join(self.tmp.name, "cfg", "config.ini")
        self.addCleanup(lambda: (setattr(CONFIG, "path", saved[0]),
                                 setattr(CONFIG, "exists", saved[1]),
                                 setattr(CONFIG, "extra_roots", saved[2])))
        return CONFIG.path

    def test_scan_roots_are_saved_in_config_ini(self):
        path = self.use_tmp_config()
        root = os.path.join(self.tmp.name, "roots")
        os.makedirs(root, exist_ok=True)
        q = urllib.parse.quote(root)
        # the same root twice keeps one entry
        st, body = self.post("/api/scan-roots/set?path=%s&path=%s" % (q, q))
        self.assertEqual(st, 200)
        self.assertEqual(body["roots"], [root])
        d = json.loads(self.get("/api/scan-roots")[1])
        self.assertEqual(d["roots"], [root])
        self.assertEqual(d["config_path"], path)
        self.assertEqual(Config(path=path).extra_roots, [root])
        st, body = self.post("/api/scan-roots/set")
        self.assertEqual(body["roots"], [])
        self.assertEqual(Config(path=path).extra_roots, [])

    def test_scan_root_must_be_a_directory(self):
        self.use_tmp_config()
        missing = urllib.parse.quote(os.path.join(self.tmp.name, "nope"))
        st, _ = self.post("/api/scan-roots/set?path=" + missing)
        self.assertEqual(st, 400)
        st, _ = self.post("/api/scan-roots/set?path=" +
                          urllib.parse.quote(self.tmp.name + ",x"))
        self.assertEqual(st, 400)

    def test_unknown_api_is_404(self):
        st, _, _ = self.get("/api/nonsense?ws=" + self.wsq())
        self.assertEqual(st, 404)


class WorkspaceStats(unittest.TestCase):
    def test_last_outcome_comes_from_the_cached_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = os.path.join(tmp, "ws")
            old = make_build(ws, "build_2026-01-01_10-00-00", [queued(0.1, "a")])
            new = make_build(ws, BUILD_ID, [queued(0.1, "a")])
            reg = Registry()
            self.assertIsNone(reg.stats(ws)["last_outcome"])  # not cached yet
            for bdir, outcome in ((old, "passed"), (new, "failed")):
                with open(os.path.join(bdir, BuildMonitor.OUTCOME_FILE), "w") as f:
                    json.dump({"v": BuildMonitor.OUTCOME_V, "outcome": outcome}, f)
            reg.stats_cache.clear()
            self.assertEqual(reg.stats(ws)["last_outcome"], "failed")


class DiscoverAll(unittest.TestCase):
    def test_extra_roots_are_scanned_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = os.path.join(tmp, "group", "ws")
            make_build(ws, BUILD_ID, [queued(0.1, "a")])
            # the same root twice must not list the workspace twice
            found = registry_mod.discover_all([tmp, tmp])
            self.assertEqual(found.count(ws), 1)
            self.assertIn(ws, registry_mod.discover_workspaces(tmp))


if __name__ == "__main__":
    unittest.main()
