"""Remote workspace URI, transport, and monitor tests without a real SSH server."""

import json
import os
import sys
import tempfile
import unittest

from colcon_dashboard.cli import resolve_workspace
from colcon_dashboard.registry import Registry
from colcon_dashboard.remote import (
    RemoteBuildMonitor, RemoteWorkspace, SSHAgent, parse_remote_workspace,
)
from tests.helpers import (
    ended, event_line, make_build, queued, started, test_failure,
    write_logger_all, logger_line,
)


class WorkspaceUris(unittest.TestCase):
    def test_ssh_uri_is_canonical(self):
        ws = parse_remote_workspace("ssh://me@Payload:2222/home/q/a%20b/")
        self.assertEqual(ws.scheme, "ssh")
        self.assertEqual(ws.target, "me@payload")
        self.assertEqual(ws.port, 2222)
        self.assertEqual(ws.path, "/home/q/a b")
        self.assertEqual(ws.uri, "ssh://me@payload:2222/home/q/a%20b")

    def test_docker_uri_separates_container_and_path(self):
        ws = parse_remote_workspace(
            "docker+ssh://payload/ros2/home/q/ros2ws")
        self.assertEqual(ws.container, "ros2")
        self.assertEqual(ws.path, "/home/q/ros2ws")
        self.assertEqual(
            ws.uri, "docker+ssh://payload/ros2/home/q/ros2ws")

    def test_ipv6_and_user(self):
        ws = parse_remote_workspace("ssh://q@[2001:db8::1]/ws")
        self.assertEqual(ws.host, "2001:db8::1")
        self.assertEqual(ws.uri, "ssh://q@[2001:db8::1]/ws")

    def test_local_paths_are_not_remote(self):
        self.assertIsNone(parse_remote_workspace("/home/q/ros2ws"))

    def test_cli_accepts_a_remote_uri_without_connecting(self):
        self.assertEqual(
            resolve_workspace("ssh://PAYLOAD/home/q/ros2ws/"),
            "ssh://payload/home/q/ros2ws")

    def test_registry_overview_keeps_remote_metadata(self):
        registry = Registry()
        registry.recents = [{"path": "ssh://payload/home/q/ros2ws",
                             "last_used": 1, "fav": True}]
        entry = registry.overview()["workspaces"][0]
        self.assertTrue(entry["exists"])
        self.assertEqual(entry["remote"]["host"], "payload")
        self.assertEqual(entry["remote"]["path"], "/home/q/ros2ws")

    def test_rejects_ambiguous_or_unsafe_values(self):
        bad = (
            "ssh://user:secret@host/ws",
            "ssh:///ws",
            "ssh://host/ws?x=1",
            "ssh://-oProxyCommand=x/ws",
            "ssh://bad%20user@host/ws",
            "docker+ssh://host/container-only",
            "docker+ssh://host/bad;name/ws",
        )
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_remote_workspace(value)

    def test_remote_command_quotes_container_and_bootstrap(self):
        ws = parse_remote_workspace(
            "docker+ssh://q@payload:2200/ros2/home/q/ros2ws")
        argv = SSHAgent(ws)._argv()
        self.assertEqual(argv[:6], [
            "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"])
        self.assertIn("-p", argv)
        self.assertEqual(argv[-2], "q@payload")
        self.assertIn("docker exec -i ros2 python3 -u -c", argv[-1])


class RemoteMonitor(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = os.path.join(self.tmp.name, "remote-ws")
        self.build_id = "build_2026-11-23_12-00-00"
        self.build = make_build(self.ws, self.build_id, [
            queued(0.1, "demo"), started(0.2, "demo"), ended(1.0, "demo"),
            event_line(1.1, "-", "EventReactorShutdown"),
        ])
        os.makedirs(os.path.join(self.build, "demo"))
        with open(os.path.join(self.build, "demo", "stdout_stderr.log"), "w") as f:
            f.write("first remote line\nsecond remote line\n")
        os.symlink(self.build_id, os.path.join(self.ws, "log", "latest_build"))
        source = os.path.join(self.ws, "src", "demo")
        os.makedirs(source)
        with open(os.path.join(source, "package.xml"), "w") as f:
            f.write("""<package><name>demo</name><version>0.0.0</version>
<description>demo</description><maintainer email="a@b">a</maintainer>
<license>Apache-2.0</license></package>""")
        self.ref = RemoteWorkspace("ssh", "fake-host", self.ws)
        self.monitor = RemoteBuildMonitor(
            self.ref, cache_root=os.path.join(self.tmp.name, "cache"),
            command=[sys.executable, "-u", "-c", SSHAgent.BOOTSTRAP])
        self.addCleanup(self.monitor.mirror.agent.close)

    def test_live_state_graph_and_log_chunks(self):
        self.monitor.scan_once()
        state = json.loads(self.monitor.state_json)
        self.assertEqual(state["workspace"], self.ref.uri)
        self.assertTrue(state["remote"]["connected"])
        self.assertEqual(state["packages"]["demo"]["s"], "done")
        self.assertFalse(state["capabilities"]["delete"])
        graph = json.loads(self.monitor.graph_json)
        self.assertEqual(graph["packages"]["demo"]["path"], "src/demo")

        tail = self.monitor.read_log("demo", "combined", -1)
        self.assertIn("second remote line", tail["data"])
        continued = self.monitor.read_log(
            "demo", "combined", tail["offset"])
        self.assertEqual(continued["data"], "")

    def test_appended_events_are_followed(self):
        self.monitor.scan_once()
        with open(os.path.join(self.build, "events.log"), "ab") as f:
            f.write(queued(2.0, "later"))
        self.monitor.scan_once()
        state = json.loads(self.monitor.state_json)
        self.assertIn("later", state["packages"])

    def test_dropped_agent_reconnects(self):
        self.monitor.scan_once()
        process = self.monitor.mirror.agent.process
        process.kill()
        process.wait()
        self.monitor.mirror.agent.retry_at = 0
        self.monitor.scan_once()
        state = json.loads(self.monitor.state_json)
        self.assertTrue(state["remote"]["connected"])
        self.assertNotEqual(self.monitor.mirror.agent.process.pid, process.pid)

    def test_stopping_monitor_closes_agent(self):
        self.monitor.scan_once()
        process = self.monitor.mirror.agent.process
        self.monitor.stop()
        self.assertTrue(self.monitor.stopped)
        self.assertIsNotNone(process.poll())

    def test_remote_test_results_are_mirrored(self):
        test_id = "test_2026-11-23_13-00-00"
        test_dir = make_build(self.ws, test_id, [
            queued(0.1, "demo"), started(0.2, "demo"),
            test_failure(0.8, "demo"), ended(1.0, "demo"),
            event_line(1.1, "-", "EventReactorShutdown"),
        ])
        write_logger_all(test_dir, [logger_line(
            0.1, "Parsed command line arguments: Namespace(verb_name='test', "
                 "build_base='build', base_paths=['.'], parallel_workers=1)")])
        os.unlink(os.path.join(self.ws, "log", "latest_build"))
        os.symlink(test_id, os.path.join(self.ws, "log", "latest_test"))
        results = os.path.join(self.ws, "build", "demo", "test_results")
        os.makedirs(results)
        with open(os.path.join(results, "result.xml"), "w") as f:
            f.write('<testsuite><testcase classname="x" name="bad" time="1">'
                    '<failure message="no"/></testcase></testsuite>')
        self.monitor.scan_once()
        self.monitor.scan_once()  # namespace from the first pass locates results
        state = json.loads(self.monitor.state_json)
        self.assertEqual(state["verb"], "test")
        self.assertEqual(state["packages"]["demo"]["tr"]["f"], 1)

    def test_remote_monitor_never_prunes(self):
        old = make_build(self.ws, "build_2026-11-22_12-00-00", [])
        self.monitor._auto_prune()
        self.assertTrue(os.path.isdir(old))

    def test_pinned_historical_run_is_loaded(self):
        old_id = "build_2026-11-22_12-00-00"
        make_build(self.ws, old_id, [
            queued(0.1, "old"), started(0.2, "old"), ended(0.5, "old"),
            event_line(0.6, "-", "EventReactorShutdown"),
        ])
        pinned = RemoteBuildMonitor(
            self.ref, pin_build=old_id,
            cache_root=os.path.join(self.tmp.name, "pinned-cache"),
            command=[sys.executable, "-u", "-c", SSHAgent.BOOTSTRAP])
        self.addCleanup(pinned.mirror.agent.close)
        pinned.scan_once()
        state = json.loads(pinned.state_json)
        self.assertEqual(state["build_id"], old_id)
        self.assertEqual(state["packages"]["old"]["s"], "done")


if __name__ == "__main__":
    unittest.main()
