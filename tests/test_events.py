"""events.py: the events.log parser and the synthesized build log."""

import os
import tempfile
import unittest

from colcon_dashboard.events import (
    BuildLogBuffer, EventLog, parse_build_id_time, payload_line,
)
from tests.helpers import (
    ended, event_line, queued, started, stderr_line, stdout_line,
)


class ParseBuildIdTime(unittest.TestCase):
    def test_valid(self):
        self.assertIsNotNone(parse_build_id_time("build_2026-08-09_09-56-51"))

    def test_embedded(self):
        self.assertIsNotNone(parse_build_id_time("x_2026-08-09_09-56-51_y"))

    def test_invalid(self):
        self.assertIsNone(parse_build_id_time("build_nonsense"))
        self.assertIsNone(parse_build_id_time("build_2026-13-99_09-56-51"))


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
