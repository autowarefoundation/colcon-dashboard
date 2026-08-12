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

from colcon_dashboard import registry as registry_mod
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

    def test_ping(self):
        st, body, _ = self.get("/api/ping")
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body)["app"], "colcon-dashboard")

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

    def test_unknown_api_is_404(self):
        st, _, _ = self.get("/api/nonsense?ws=" + self.wsq())
        self.assertEqual(st, 404)


if __name__ == "__main__":
    unittest.main()
