"""monitor.py: outcome caching and the job-state machine in scan_once."""

import json
import os
import tempfile
import time
import unittest

from colcon_dashboard.monitor import BuildMonitor
from tests.helpers import (
    ended, event_line, make_build, queued, started, stderr_line,
)

BUILD_ID = "build_2026-08-09_10-00-00"
SHUTDOWN = event_line(99.0, "-", "EventReactorShutdown")


class ComputeOutcome(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.mon = BuildMonitor(self.ws)

    def outcome(self, events, mtime=None):
        bdir = make_build(self.ws, BUILD_ID, events, mtime=mtime)
        return bdir, self.mon._compute_outcome(bdir)

    def test_passed(self):
        _, info = self.outcome([
            queued(0.1, "a"), queued(0.1, "b"),
            started(0.2, "a"), ended(1.0, "a"),
            started(1.1, "b"), ended(2.0, "b"),
            SHUTDOWN,
        ])
        self.assertEqual(info["outcome"], "passed")
        self.assertEqual((info["done"], info["total"]), (2, 2))

    def test_failed(self):
        _, info = self.outcome([
            queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a", rc=2),
            SHUTDOWN,
        ])
        self.assertEqual(info["outcome"], "failed")
        self.assertEqual(info["failed"], 1)

    def test_sigint_aborted(self):
        _, info = self.outcome([
            queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a", rc="SIGINT"),
            SHUTDOWN,
        ])
        self.assertEqual(info["outcome"], "aborted")

    def test_incomplete_run_aborted(self):
        _, info = self.outcome(
            [queued(0.1, "a"), queued(0.1, "b"),
             started(0.2, "a"), ended(1.0, "a"), SHUTDOWN])
        self.assertEqual(info["outcome"], "aborted")

    def test_skipped_jobs_still_count_as_complete(self):
        _, info = self.outcome([
            queued(0.1, "a"), queued(0.1, "b"),
            started(0.2, "a"), ended(1.0, "a"),
            event_line(1.1, "b", "JobSkipped"),
            SHUTDOWN,
        ])
        self.assertEqual(info["outcome"], "passed")
        self.assertEqual(info["skipped"], 1)

    def test_still_running_returns_none_and_caches_nothing(self):
        bdir, info = self.outcome(
            [queued(0.1, "a"), started(0.2, "a")], mtime=time.time())
        self.assertIsNone(info)
        self.assertFalse(
            os.path.exists(os.path.join(bdir, self.mon.OUTCOME_FILE)))

    def test_stale_without_shutdown_is_aborted(self):
        _, info = self.outcome(
            [queued(0.1, "a"), started(0.2, "a")], mtime=time.time() - 600)
        self.assertEqual(info["outcome"], "aborted")

    def test_outcome_is_cached_and_reread(self):
        bdir, info = self.outcome([queued(0.1, "a"), started(0.2, "a"),
                                   ended(1.0, "a"), SHUTDOWN])
        self.assertEqual(self.mon._read_outcome(bdir), info)


class ScanOnce(unittest.TestCase):
    """One synthetic build exercising every job state at once."""

    EVENTS = [
        queued(0.1, "a"),
        queued(0.1, "b", deps=["a"]),
        queued(0.1, "c", deps=["a", "b"]),   # recursive set; direct dep is b
        queued(0.1, "d", deps=["a"]),
        queued(0.1, "e"),
        queued(0.1, "g"),
        queued(0.1, "h", deps=["g"]),
        started(0.2, "a"), ended(1.0, "a"),
        started(1.1, "b"),
        stderr_line(1.2, "b", "warning: w\n"),
        event_line(1.3, "e", "JobSkipped"),
        started(0.3, "g"), ended(0.9, "g", rc=2),
    ]

    def scan(self, mtime):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ws = self.tmp.name
        make_build(ws, BUILD_ID, self.EVENTS, mtime=mtime)
        mon = BuildMonitor(ws)
        mon.scan_once()
        return mon, json.loads(mon.state_json), json.loads(mon.graph_json)

    def test_live_states(self):
        mon, state, graph = self.scan(mtime=time.time())
        self.assertTrue(state["active"])
        s = {name: p["s"] for name, p in state["packages"].items()}
        self.assertEqual(s, {
            "a": "done",
            "b": "building",
            "c": "waiting",   # b still builds
            "d": "ready",     # a is done
            "e": "skipped",
            "g": "failed",
            "h": "blocked",   # its dependency failed
        })
        self.assertEqual(state["packages"]["g"]["rc"], 2)
        self.assertEqual(state["packages"]["b"]["err"], 1)
        self.assertEqual(state["counts"], {
            "done": 1, "building": 1, "waiting": 1, "ready": 1,
            "skipped": 1, "failed": 1, "blocked": 1,
        })
        self.assertEqual(state["total"], 7)
        # graph edges are the transitive reduction of colcon's recursive sets
        self.assertEqual(graph["packages"]["c"]["deps"], ["b"])
        self.assertEqual(graph["packages"]["b"]["deps"], ["a"])
        self.assertTrue(graph["packages"]["c"]["in_build"])

    def test_dead_build_states(self):
        mon, state, _ = self.scan(mtime=time.time() - 600)
        self.assertFalse(state["active"])
        s = {name: p["s"] for name, p in state["packages"].items()}
        # the run is over: started-not-ended is aborted, pending is skipped
        self.assertEqual(s["b"], "aborted")
        self.assertEqual(s["c"], "skipped")
        self.assertEqual(s["d"], "skipped")
        self.assertEqual(s["h"], "blocked")

    def test_timestamps_anchored_to_build_id(self):
        mon, state, _ = self.scan(mtime=time.time())
        epoch0 = state["build_started"]
        a = state["packages"]["a"]
        self.assertAlmostEqual(a["t0"], epoch0 + 0.2, places=1)
        self.assertAlmostEqual(a["t1"], epoch0 + 1.0, places=1)


class ReadLog(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ws = self.tmp.name
        bdir = make_build(ws, BUILD_ID,
                          [queued(0.1, "a"), started(0.2, "a")],
                          mtime=time.time())
        os.makedirs(os.path.join(bdir, "a"))
        with open(os.path.join(bdir, "a", "stdout_stderr.log"), "w") as f:
            f.write("first\nsecond\n")
        self.mon = BuildMonitor(ws)
        self.mon.scan_once()

    def test_tail_then_continue(self):
        r = self.mon.read_log("a", "combined", -1)
        self.assertTrue(r["reset"])
        self.assertEqual(r["data"], "first\nsecond\n")
        r2 = self.mon.read_log("a", "combined", r["offset"])
        self.assertEqual(r2["data"], "")

    def test_align_skips_partial_line(self):
        r = self.mon.read_log("a", "combined", 2, align=True)
        self.assertEqual(r["data"], "second\n")

    def test_rejects_bad_input(self):
        self.assertIsNone(self.mon.read_log("../a", "combined", -1))
        self.assertIsNone(self.mon.read_log("a", "nosuchfile", -1))
        self.assertIsNone(self.mon.read_log("", "combined", -1))

    def test_missing_log_is_empty_not_error(self):
        r = self.mon.read_log("nope", "combined", -1)
        self.assertEqual((r["size"], r["data"]), (0, ""))


if __name__ == "__main__":
    unittest.main()
