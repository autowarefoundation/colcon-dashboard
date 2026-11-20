"""events.py: the events.log parser and the synthesized build log."""

import os
import tempfile
import unittest

from colcon_dashboard.events import (
    BuildLogBuffer, EventLog, last_event_time, parse_build_id_time,
    EVENTS_DELAY, LOGGER_DELAY, file_start, payload_line, run_start,
    run_start_time,
)
from tests.helpers import (
    command, command_ended, ended, event_line, logger_line, make_build, queued,
    started, stderr_line, stdout_line, time_zone, write_logger_all,
)


class ParseBuildIdTime(unittest.TestCase):
    def test_valid(self):
        self.assertIsNotNone(parse_build_id_time("build_2026-08-09_09-56-51"))

    def test_embedded(self):
        self.assertIsNotNone(parse_build_id_time("x_2026-08-09_09-56-51_y"))

    def test_invalid(self):
        self.assertIsNone(parse_build_id_time("build_nonsense"))
        self.assertIsNone(parse_build_id_time("build_2026-13-99_09-56-51"))

    def test_a_time_out_of_range(self):
        # east of UTC, Python also looks at the next day: year 10000
        with time_zone("XYZ-3"):
            self.assertIsNone(parse_build_id_time("build_9999-12-31_23-59-59"))
            with tempfile.TemporaryDirectory() as ws:
                bdir = make_build(ws, "build_9999-12-31_23-59-59", [])
                self.assertIsNone(run_start_time(bdir))


class RunStart(unittest.TestCase):
    """A host 3 h east of UTC, and runs from a container on UTC."""

    NAME = "build_2026-08-09_10-00-00"

    def setUp(self):
        tz = time_zone("XYZ-3")
        tz.__enter__()
        self.addCleanup(tz.__exit__, None, None, None)
        self.local = parse_build_id_time(self.NAME)
        self.utc = parse_build_id_time(self.NAME, utc=True)

    def test_the_utc_reading_is_3_hours_later(self):
        self.assertEqual(self.utc - self.local, 3 * 3600)

    def test_a_host_run_keeps_the_local_reading(self):
        # logger_all.log starts its clock before colcon names the run,
        # events.log after colcon reads the workspace
        self.assertEqual(run_start(self.NAME, self.local - 0.1, LOGGER_DELAY),
                         self.local)
        self.assertEqual(run_start(self.NAME, self.local + 12.0, EVENTS_DELAY),
                         self.local)

    def test_a_container_run_gets_the_utc_reading(self):
        self.assertEqual(run_start(self.NAME, self.utc - 0.1, LOGGER_DELAY), self.utc)
        self.assertEqual(run_start(self.NAME, self.utc + 12.0, EVENTS_DELAY), self.utc)

    def test_a_copied_file_keeps_the_local_reading(self):
        # the copy gave the log a new time that fits no reading
        self.assertEqual(run_start(self.NAME, self.local + 7200, EVENTS_DELAY),
                         self.local)
        # a copy 3 h after the run: logger_all.log fits the UTC reading
        # only within its own, narrow range
        self.assertEqual(run_start(self.NAME, self.utc + 120, LOGGER_DELAY),
                         self.local)

    def test_without_a_start(self):
        self.assertEqual(run_start(self.NAME, None, None), self.local)
        self.assertIsNone(run_start("build_nonsense", self.utc, EVENTS_DELAY))

    def build(self, ws, events=(), mtime=None):
        return make_build(ws, self.NAME, list(events), mtime=mtime)

    def test_run_start_time_reads_events_log(self):
        with tempfile.TemporaryDirectory() as ws:
            bdir = self.build(ws, [
                event_line(0.0, "-", "TimerEvent"),
                event_line(60.0, "-", "EventReactorShutdown"),
            ], mtime=self.utc + 61)
            self.assertEqual(run_start_time(bdir), self.utc)
            # a run without logs: the local reading of its name
            os.makedirs(os.path.join(ws, "log", "test_2026-08-09_11-00-00"))
            self.assertEqual(
                run_start_time(os.path.join(ws, "log", "test_2026-08-09_11-00-00")),
                parse_build_id_time("test_2026-08-09_11-00-00"))

    def test_logger_all_log_comes_first(self):
        # the computer slept for 50 minutes in a container build. The
        # events.log clock stopped, the logger_all.log clock did not.
        end = self.utc + 3600
        with tempfile.TemporaryDirectory() as ws:
            bdir = self.build(ws, [event_line(600.0, "-", "EventReactorShutdown")],
                              mtime=end)
            self.assertEqual(file_start(bdir), (self.utc + 3000, EVENTS_DELAY))
            write_logger_all(bdir, [
                logger_line(0.1, "DEBUG:colcon:Command line arguments: x"),
                # the last record has more than one line
                logger_line(3599.9, "ERROR:colcon:Duplicate package names:"),
                b"- a:\n  - src/a\n",
            ], mtime=end)
            self.assertAlmostEqual(file_start(bdir)[0], self.utc + 0.1, places=3)
            self.assertEqual(run_start_time(bdir), self.utc)

    def test_a_run_with_logger_all_log_only(self):
        # colcon stopped before the first event
        with tempfile.TemporaryDirectory() as ws:
            bdir = os.path.join(ws, "log", self.NAME)
            os.makedirs(bdir)
            write_logger_all(bdir, [logger_line(0.4, "ERROR:colcon:x")],
                             mtime=self.utc + 0.5)
            self.assertEqual(run_start_time(bdir), self.utc)

    def test_python_3_13_logger_times(self):
        # From Python 3.13, colcon writes record.created minus
        # logging._startTime in nanoseconds: the start, negated
        load_ns = int((self.utc + 0.1) * 1e9)
        stamp = (load_ns + 3600 * 10**9) / 1e9 - load_ns  # 1 h later
        with tempfile.TemporaryDirectory() as ws:
            bdir = self.build(ws, [event_line(60.0, "-", "EventReactorShutdown")],
                              mtime=self.local + 7200)
            # a copy gave the files new times: the stamp needs none
            write_logger_all(bdir, ["[{:.3f}s] DEBUG:colcon:x\n".format(stamp).encode()],
                             mtime=self.local + 7200)
            self.assertAlmostEqual(file_start(bdir)[0], self.utc + 0.1, places=3)
            self.assertEqual(run_start_time(bdir), self.utc)


    def test_a_clock_that_went_back(self):
        # Python 3.12: the wall clock went back 3.1 s during the run, so
        # the last record came 3 s before the start of the logging clock
        start = self.utc + 0.1
        with tempfile.TemporaryDirectory() as ws:
            bdir = os.path.join(ws, "log", self.NAME)
            os.makedirs(bdir)
            write_logger_all(bdir, [logger_line(-3.0, "DEBUG:colcon:x")],
                             mtime=start - 3.0)
            self.assertAlmostEqual(file_start(bdir)[0], start, places=3)
            self.assertEqual(run_start_time(bdir), self.utc)


class LastEventTime(unittest.TestCase):
    def path(self, *events):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return os.path.join(make_build(tmp.name, "build_x", events), "events.log")

    def test_the_last_line(self):
        self.assertEqual(last_event_time(self.path(
            started(1.0, "a"), ended(2.5, "a"))), 2.5)

    def test_a_last_line_longer_than_4_kib(self):
        # a Command event carries the whole environment
        env = "{'env': '" + "x" * 10000 + "'}"
        self.assertEqual(last_event_time(self.path(
            started(1.0, "a"), event_line(2.5, "a", "Command", env))), 2.5)

    def test_no_events(self):
        self.assertIsNone(last_event_time(self.path(b"not an event\n")))
        self.assertIsNone(last_event_time("/nonexistent/events.log"))


class PayloadLine(unittest.TestCase):
    def test_single_quoted(self):
        self.assertEqual(
            payload_line(b"{'line': b'hello world\\n'}"), "hello world")

    def test_double_quoted(self):
        self.assertEqual(
            payload_line(b'{\'line\': b"it\'s fine\\n"}'), "it's fine")

    def test_missing(self):
        self.assertIsNone(payload_line(b"{'progress': 'cmake'}"))


class EventLogParsing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "events.log")

    def feed(self, chunks):
        with open(self.path, "ab") as f:
            f.write(b"".join(chunks))
        ev = getattr(self, "ev", None)
        if ev is None:
            ev = self.ev = EventLog(self.path)
        ev.poll()
        return ev

    def test_failed_command_and_warnings(self):
        ev = self.feed([
            queued(0.1, "a"), started(0.2, "a"),
            command(0.3, "a", ["/usr/bin/cmake", "/ws/src/a"]), command_ended(0.4, "a"),
            stderr_line(0.5, "a", "a.cpp:3:1: warning: unused x\n"),
            stdout_line(0.6, "a", "CMake Warning at CMakeLists.txt:4\n"),
            command(0.7, "a", ["/usr/bin/cmake", "--build", "/ws/build/a"]),
            command_ended(0.9, "a", 2), ended(1.0, "a", rc=2),
        ])
        job = ev.jobs["a"]
        self.assertEqual(job["fail_cmd"], "/usr/bin/cmake --build /ws/build/a")
        self.assertEqual(job["warnings"], 2)

    def test_job_lifecycle_and_buildlog(self):
        ev = self.feed([
            event_line(0.1, "-", "TimerEvent"),
            queued(0.2, "a"),
            queued(0.2, "b", deps=["a"]),
            started(0.3, "a"),
            stdout_line(0.4, "a", "compiling [ 42%] now\n"),
            stderr_line(0.5, "a", "warning: x\n"),
            ended(1.0, "a", rc=0),
            started(1.1, "b"),
            ended(2.0, "b", rc=1),
        ])
        a, b = ev.jobs["a"], ev.jobs["b"]
        self.assertEqual(a["rc"], 0)
        self.assertEqual(a["pct"], 42)
        self.assertEqual(a["stderr_lines"], 1)
        self.assertEqual(b["deps"], {"a"})
        self.assertEqual(b["rc"], 1)
        self.assertEqual(ev.last_t, 2.0)
        self.assertFalse(ev.shutdown)
        log = ev.buildlog.read(-1)["data"]
        self.assertIn("Starting >>> a", log)
        self.assertIn("compiling [ 42%] now", log)
        self.assertIn("Finished <<< a", log)
        self.assertIn("Failed   <<< b", log)
        self.assertIn("(exit code 1)", log)

    def test_legacy_tuple_deps(self):
        ev = self.feed([event_line(
            0.1, "c", "JobQueued",
            "{'identifier': 'c', 'dependencies': [('a', '/x/a'), ('b', '/x/b')]}")])
        self.assertEqual(ev.jobs["c"]["deps"], {"a", "b"})

    def test_sigint_and_skip_and_shutdown(self):
        ev = self.feed([
            queued(0.1, "a"),
            queued(0.1, "b"),
            started(0.2, "a"),
            ended(0.9, "a", rc="SIGINT"),
            event_line(1.0, "b", "JobSkipped"),
            event_line(1.1, "u", "JobUnselected"),
            event_line(1.2, "-", "EventReactorShutdown"),
        ])
        self.assertEqual(ev.jobs["a"]["rc"], "SIGINT")
        self.assertTrue(ev.jobs["b"]["skipped"])
        self.assertIn("u", ev.unselected)
        self.assertTrue(ev.shutdown)
        self.assertIn("Aborted  <<< a", ev.buildlog.read(-1)["data"])

    def test_progress_phase(self):
        ev = self.feed([
            queued(0.1, "a"),
            event_line(0.2, "a", "JobProgress",
                       "{'identifier': 'a', 'progress': 'cmake'}"),
        ])
        self.assertEqual(ev.jobs["a"]["phase"], "cmake")

    def test_partial_line_not_parsed_until_complete(self):
        ev = self.feed([queued(0.1, "a")])
        with open(self.path, "ab") as f:
            f.write(b"[0.500000] (a) JobStar")  # no newline yet
        ev.poll()
        self.assertIsNone(ev.jobs["a"]["started"])
        with open(self.path, "ab") as f:
            f.write(b"ted: {'identifier': 'a'}\n")
        ev.poll()
        self.assertEqual(ev.jobs["a"]["started"], 0.5)

    def test_truncated_file_resets(self):
        ev = self.feed([queued(0.1, "a"), started(0.2, "a")])
        self.assertIsNotNone(ev.jobs["a"]["started"])
        with open(self.path, "wb") as f:  # a new, shorter log: new build
            f.write(queued(0.1, "z"))
        ev.poll()
        self.assertNotIn("a", ev.jobs)
        self.assertIn("z", ev.jobs)


class BuildLogBufferApi(unittest.TestCase):
    def test_tail_and_continue(self):
        buf = BuildLogBuffer()
        buf.append("one")
        buf.append("two")
        r = buf.read(-1)
        self.assertTrue(r["reset"])
        self.assertEqual(r["data"], "one\ntwo\n")
        r2 = buf.read(r["offset"])
        self.assertEqual(r2["data"], "")
        buf.append("three")
        r3 = buf.read(r["offset"])
        self.assertEqual(r3["data"], "three\n")
        self.assertFalse(r3["reset"])

    def test_align_starts_on_line_boundary(self):
        buf = BuildLogBuffer()
        buf.append("alpha")
        buf.append("beta")
        r = buf.read(2, align=True)  # mid-"alpha"
        self.assertEqual(r["data"], "beta\n")

    def test_trim_advances_base_and_resets_stale_readers(self):
        buf = BuildLogBuffer()
        buf.MAX = 64
        buf.TRIM = 32
        for i in range(20):
            buf.append("line-%03d" % i)
        r = buf.read(0)
        self.assertTrue(r["reset"])  # offset 0 fell below the trimmed base
        self.assertTrue(r["data"].startswith("line-"))
        self.assertNotIn("line-000", r["data"])


if __name__ == "__main__":
    unittest.main()
