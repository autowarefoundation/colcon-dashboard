"""monitor.py: outcome caching and the job-state machine in scan_once."""

import json
import os
import tempfile
import time
import unittest

from colcon_dashboard.config import CONFIG
from colcon_dashboard.monitor import (
    BuildMonitor, prune_builds, remove_build_dir,
)
from tests.helpers import (
    ended, event_line, make_build, queued, started, stderr_line,
    stdout_line,
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

    def test_durations_recorded(self):
        _, info = self.outcome([
            queued(0.1, "a"), queued(0.1, "b"),
            started(0.2, "a"), ended(1.0, "a"),
            started(1.1, "b"), ended(3.0, "b"),
            started(3.1, "c"), ended(4.0, "c", rc=2),  # failures: no duration
            SHUTDOWN,
        ])
        self.assertEqual(info["pkg_durations"], {"a": 0.8, "b": 1.9})
        self.assertEqual(info["duration"], 99.0)  # the shutdown timestamp

    def test_old_cache_format_is_recomputed(self):
        bdir = make_build(self.ws, BUILD_ID,
                          [queued(0.1, "a"), started(0.2, "a"),
                           ended(1.0, "a"), SHUTDOWN])
        with open(os.path.join(bdir, self.mon.OUTCOME_FILE), "w") as f:
            json.dump({"outcome": "passed", "done": 1, "total": 1}, f)
        self.assertIsNone(self.mon._read_outcome(bdir))

    def test_stdout_echoing_event_names_cannot_poison_durations(self):
        _, info = self.outcome([
            queued(0.1, "a"), started(50.0, "a"),
            stdout_line(100.0, "a", "replaying JobStarted from a log\n"),
            ended(250.0, "a"),
            SHUTDOWN,
        ])
        self.assertEqual(info["pkg_durations"], {"a": 200.0})


class PruneHelpers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log_dir = os.path.join(self.tmp.name, "log")
        for name in ("build_2026-08-01_10-00-00", "build_2026-08-02_10-00-00",
                     "build_2026-08-03_10-00-00", "test_2026-08-01_12-00-00",
                     "test_2026-08-02_12-00-00"):
            d = os.path.join(self.log_dir, name)
            os.makedirs(d)
            with open(os.path.join(d, "events.log"), "w") as f:
                f.write("x" * 100)

    def names(self):
        return sorted(os.listdir(self.log_dir))

    def test_keeps_newest_of_each_kind(self):
        deleted, freed = prune_builds(self.log_dir, 1)
        self.assertEqual(self.names(), ["build_2026-08-03_10-00-00",
                                        "test_2026-08-02_12-00-00"])
        self.assertEqual(len(deleted), 3)
        self.assertEqual(freed, 300)

    def test_protected_runs_survive(self):
        deleted, _ = prune_builds(self.log_dir, 1,
                                  protect={"build_2026-08-01_10-00-00"})
        self.assertIn("build_2026-08-01_10-00-00", self.names())
        self.assertNotIn("build_2026-08-02_10-00-00", self.names())
        self.assertNotIn("build_2026-08-01_10-00-00", deleted)

    def test_remove_guards_traversal(self):
        outside = os.path.join(self.tmp.name, "precious")
        os.makedirs(outside)
        self.assertEqual(remove_build_dir(self.log_dir, "../precious"), 0)
        self.assertTrue(os.path.isdir(outside))


class PrevRunInfo(unittest.TestCase):
    OLD_ID = "build_2026-08-09_09-00-00"

    def test_graph_carries_previous_durations(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        make_build(tmp.name, self.OLD_ID,
                   [queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a"),
                    SHUTDOWN], mtime=time.time() - 3600)
        make_build(tmp.name, BUILD_ID,
                   [queued(0.1, "a"), started(0.2, "a")], mtime=time.time())
        mon = BuildMonitor(tmp.name)
        mon.scan_once()
        deadline = time.time() + 5  # the prev outcome loads off-thread
        while mon.prev_info is None and time.time() < deadline:
            time.sleep(0.05)
        mon.scan_once()  # the next scan publishes the loaded info
        graph = json.loads(mon.graph_json)
        self.assertEqual(graph["prev"]["id"], self.OLD_ID)
        self.assertEqual(graph["prev"]["durations"], {"a": 0.8})
        self.assertEqual(graph["prev"]["duration"], 99.0)

    def test_first_run_has_no_prev(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        make_build(tmp.name, BUILD_ID,
                   [queued(0.1, "a"), started(0.2, "a")], mtime=time.time())
        mon = BuildMonitor(tmp.name)
        mon.scan_once()
        self.assertIsNone(json.loads(mon.graph_json)["prev"])


class ListBuildsKinds(unittest.TestCase):
    TEST_ID = "test_2026-08-09_11-00-00"

    def test_test_runs_listed_and_sorted_by_time(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        make_build(tmp.name, BUILD_ID,
                   [queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a"),
                    SHUTDOWN], mtime=time.time() - 3600)
        make_build(tmp.name, self.TEST_ID,
                   [queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a", rc=1),
                    SHUTDOWN], mtime=time.time() - 1800)
        mon = BuildMonitor(tmp.name)
        deadline = time.time() + 8
        while time.time() < deadline:
            result = mon.list_builds()
            if all(b.get("outcome") for b in result["builds"]):
                break
            time.sleep(0.1)
        ids = [b["id"] for b in result["builds"]]
        self.assertEqual(ids, [self.TEST_ID, BUILD_ID])  # newest first
        self.assertEqual(result["builds"][0]["outcome"], "failed")
        self.assertEqual(result["builds"][1]["outcome"], "passed")
        for b in result["builds"]:  # durations yes, the bulky map no
            self.assertIn("duration", b)
            self.assertNotIn("pkg_durations", b)
            self.assertNotIn("v", b)

    def test_pinned_monitor_claims_no_latest(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        make_build(tmp.name, BUILD_ID,
                   [queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a"),
                    SHUTDOWN], mtime=time.time() - 3600)
        mon = BuildMonitor(tmp.name, pin_build=BUILD_ID)
        mon.scan_once()
        self.assertIsNone(mon.list_builds()["latest"])


class AutoPrune(unittest.TestCase):
    def test_finished_build_prunes_old_runs(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        old = time.time() - 3600
        make_build(tmp.name, "build_2026-08-09_08-00-00",
                   [queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a"),
                    SHUTDOWN], mtime=old)
        make_build(tmp.name, "build_2026-08-09_09-00-00",
                   [queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a"),
                    SHUTDOWN], mtime=old)
        bdir = make_build(tmp.name, BUILD_ID,
                          [queued(0.1, "a"), started(0.2, "a")],
                          mtime=time.time())
        CONFIG.auto_prune_keep = 2
        self.addCleanup(setattr, CONFIG, "auto_prune_keep", None)
        mon = BuildMonitor(tmp.name)
        mon.scan_once()
        self.assertTrue(mon.active_flag)
        with open(os.path.join(bdir, "events.log"), "ab") as f:
            f.write(ended(1.0, "a") + SHUTDOWN)
        mon.scan_once()  # the build just finished: the prune fires
        log_dir = os.path.join(tmp.name, "log")
        deadline = time.time() + 5
        while time.time() < deadline:
            if "build_2026-08-09_08-00-00" not in os.listdir(log_dir):
                break
            time.sleep(0.05)
        self.assertEqual(sorted(os.listdir(log_dir)),
                         ["build_2026-08-09_09-00-00", BUILD_ID])

    def test_already_finished_build_prunes_on_first_scan(self):
        # a service restart must not exempt the last build from pruning
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        old = time.time() - 3600
        make_build(tmp.name, "build_2026-08-09_08-00-00",
                   [queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a"),
                    SHUTDOWN], mtime=old)
        make_build(tmp.name, BUILD_ID,
                   [queued(0.1, "a"), started(0.2, "a"), ended(1.0, "a"),
                    SHUTDOWN], mtime=old)
        CONFIG.auto_prune_keep = 1
        self.addCleanup(setattr, CONFIG, "auto_prune_keep", None)
        pruned = []
        mon = BuildMonitor(tmp.name)
        mon.on_prune = pruned.extend
        mon.scan_once()
        log_dir = os.path.join(tmp.name, "log")
        deadline = time.time() + 5
        while time.time() < deadline:
            if "build_2026-08-09_08-00-00" not in os.listdir(log_dir):
                break
            time.sleep(0.05)
        self.assertEqual(os.listdir(log_dir), [BUILD_ID])
        self.assertEqual(pruned, ["build_2026-08-09_08-00-00"])


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
