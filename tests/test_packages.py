"""packages.py: workspace scanning, package.xml parsing, colcon namespace."""

import os
import tempfile
import unittest

from colcon_dashboard.packages import (
    PackageIndex, arg_options, junit_report, parse_namespace, read_test_results,
    summarize_args,
)


def write_pkg(root, rel, name, deps=(), build_type=None, extra=""):
    d = os.path.join(root, rel)
    os.makedirs(d, exist_ok=True)
    dep_xml = "".join("<depend>{}</depend>".format(x) for x in deps)
    bt = ("<export><build_type>{}</build_type></export>".format(build_type)
          if build_type else "")
    with open(os.path.join(d, "package.xml"), "w") as f:
        f.write("<package><name>{}</name>{}{}{}</package>"
                .format(name, dep_xml, bt, extra))


class Scan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name

    def test_deps_filtered_to_known_packages(self):
        write_pkg(self.ws, "src/a", "a")
        write_pkg(self.ws, "src/b", "b", deps=["a", "rclcpp", "b"])
        idx = PackageIndex(self.ws)
        idx.scan(["."])
        self.assertEqual(set(idx.packages), {"a", "b"})
        # external deps and self-deps are dropped
        self.assertEqual(idx.packages["b"]["deps"], {"a"})
        self.assertEqual(idx.packages["a"]["path"], os.path.join("src", "a"))

    def test_build_type_default_and_explicit(self):
        write_pkg(self.ws, "src/a", "a")
        write_pkg(self.ws, "src/b", "b", build_type="ament_python")
        idx = PackageIndex(self.ws)
        idx.scan(["."])
        self.assertEqual(idx.packages["a"]["build_type"], "ament_cmake")
        self.assertEqual(idx.packages["b"]["build_type"], "ament_python")

    def test_colcon_ignore_and_pruned_dirs(self):
        write_pkg(self.ws, "src/a", "a")
        write_pkg(self.ws, "src/ignored/b", "b")
        open(os.path.join(self.ws, "src", "ignored", "COLCON_IGNORE"), "w").close()
        write_pkg(self.ws, "build/c", "c")  # build/ is pruned
        idx = PackageIndex(self.ws)
        idx.scan(["."])
        self.assertEqual(set(idx.packages), {"a"})

    def test_packages_do_not_nest(self):
        write_pkg(self.ws, "src/a", "a")
        write_pkg(self.ws, "src/a/vendor/inner", "inner")
        idx = PackageIndex(self.ws)
        idx.scan(["."])
        self.assertEqual(set(idx.packages), {"a"})

    def test_malformed_xml_skipped(self):
        d = os.path.join(self.ws, "src", "bad")
        os.makedirs(d)
        with open(os.path.join(d, "package.xml"), "w") as f:
            f.write("<package><name>bad</name>")  # unclosed
        write_pkg(self.ws, "src/a", "a")
        idx = PackageIndex(self.ws)
        idx.scan(["."])
        self.assertEqual(set(idx.packages), {"a"})

    def test_dep_closure_with_cycle(self):
        write_pkg(self.ws, "src/a", "a", deps=["b"])
        write_pkg(self.ws, "src/b", "b", deps=["c", "a"])  # cycle a<->b
        write_pkg(self.ws, "src/c", "c")
        idx = PackageIndex(self.ws)
        idx.scan(["."])
        self.assertEqual(idx.dep_closure("a"), {"b", "c", "a"})

    def test_container_base_paths_map_into_the_workspace(self):
        # colcon ran in a container that mounts this workspace at /ws
        write_pkg(self.ws, "src/core/a", "a")
        write_pkg(self.ws, "src/extra/b", "b")
        write_pkg(self.ws, "tools/c", "c")
        for base_paths, found in (
                (["/ws/src"], {"a", "b"}),
                (["/ws/src/core"], {"a"}),
                (["src/core", "/ws/tools"], {"a", "c"}),
                (["/no/such/dir"], {"a", "b", "c"}),  # no match: everything
                (["missing"], set()),  # a relative path does not fall back
        ):
            with self.subTest(base_paths=base_paths):
                idx = PackageIndex(self.ws)
                idx.scan(base_paths)
                self.assertEqual(set(idx.packages), found)


class Namespace(unittest.TestCase):
    def test_fields(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "logger_all.log")
            with open(path, "w") as f:
                f.write("[0.1] DEBUG:colcon:Command line arguments: x\n"
                        "[0.2] DEBUG:colcon:Parsed command line arguments: "
                        "Namespace(base_paths=['src'], build_base='build', "
                        "parallel_workers=8, symlink_install=True, "
                        "packages_select=None)\n")
            ns = parse_namespace(path)
        self.assertEqual(ns["base_paths"], ["src"])
        self.assertEqual(ns["parallel_workers"], 8)
        self.assertIs(ns["symlink_install"], True)
        self.assertIsNone(ns["packages_select"])

    def test_missing_file(self):
        self.assertIsNone(parse_namespace("/nonexistent/logger_all.log"))

    def test_no_namespace_line(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "logger_all.log")
            with open(path, "w") as f:
                f.write("just logs\n")
            self.assertIsNone(parse_namespace(path))


if __name__ == "__main__":
    unittest.main()


class SummarizeArgs(unittest.TestCase):
    def test_only_options_that_differ_from_the_defaults(self):
        ns = {"verb_name": "build", "packages_up_to": ["foo", "bar"], "symlink_install": True,
              "merge_install": False, "mixin": ["release"], "cmake_args": None,
              "parallel_workers": 12}
        self.assertEqual(summarize_args(ns),
                         "--packages-up-to foo bar --mixin release --symlink-install")

    def test_nothing_to_show(self):
        self.assertEqual(summarize_args(None), "")
        self.assertEqual(summarize_args({"verb_name": "build"}), "")

    def test_one_word_list_per_option(self):
        ns = {"symlink_install": True, "cmake_args": ["-DCMAKE_BUILD_TYPE=Release"],
              "packages_select": ["a b"]}
        self.assertEqual(arg_options(ns), [
            ["--packages-select", "a b"], ["--symlink-install"],
            ["--cmake-args", "-DCMAKE_BUILD_TYPE=Release"]])
        self.assertEqual(arg_options(None), [])


JUNIT = """<?xml version="1.0"?>
<testsuite name="s" tests="3">
  <testcase classname="a.Suite" name="ok"/>
  <testcase classname="a.Suite" name="bad"><failure message="expected 1, got 2">trace</failure></testcase>
  <testcase classname="a.Suite" name="later"><skipped/></testcase>
</testsuite>"""


TIMED = """<testsuite>
  <testcase classname="t" name="ok" time="0.1"/>
  <testcase classname="t" name="slow_bad" time="12.0"><failure message="assert 1 == 2">line 1 of the trace
line 2 of the trace</failure><system-out>printed by the test</system-out></testcase>
  <testcase classname="t" name="broken" time="0.5"><error message="setup failed"/></testcase>
</testsuite>"""


class TestResults(unittest.TestCase):
    def test_counts_and_failing_cases(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "test_results", "a"))
            with open(os.path.join(tmp, "test_results", "a", "gtest.xml"), "w") as f:
                f.write(JUNIT)
            with open(os.path.join(tmp, "pytest.xml"), "w") as f:
                f.write('<testsuites><testsuite><testcase name="t1"/></testsuite></testsuites>')
            r = read_test_results([os.path.join(tmp, "test_results"), os.path.join(tmp, "pytest.xml")])
        self.assertEqual((r["t"], r["f"], r["e"], r["s"]), (4, 1, 0, 1))
        self.assertEqual(r["fail"], [{"n": "a.Suite.bad", "m": "expected 1, got 2"}])

    def test_no_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(read_test_results([os.path.join(tmp, "nope")]))
            self.assertIsNone(junit_report([os.path.join(tmp, "nope")]))

    def test_test_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pytest.xml")
            with open(path, "w") as f:
                f.write(TIMED)
            r = read_test_results([path])
        self.assertEqual(r["d"], 12.6)

    def test_infinite_time_counts_as_zero(self):
        # json.dumps writes Infinity, and the browser cannot parse it
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pytest.xml")
            with open(path, "w") as f:
                f.write('<testsuite><testcase name="a" time="inf"/>'
                        '<testcase name="b" time="1e999"/>'
                        '<testcase name="c" time="nan"/></testsuite>')
            r = read_test_results([path])
        self.assertEqual(r["d"], 0)

    def test_report_has_every_failure_in_full_and_the_slowest_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "build", "a", "pytest.xml")
            os.makedirs(os.path.dirname(path))
            with open(path, "w") as f:
                f.write(TIMED)
            text = junit_report([path], base=tmp)
        lines = text.splitlines()
        self.assertEqual(lines[0], "3 tests: 1 passed, 1 failed, 1 errors. Test time 12.60 s.")
        self.assertEqual(lines[2], "  build/a/pytest.xml")
        # the whole failure text and the captured output, not only line 1
        self.assertIn("FAILED  t.slow_bad  (12.00 s)", lines)
        self.assertIn("line 2 of the trace", lines)
        self.assertIn("Captured output:", lines)
        self.assertIn("printed by the test", lines)
        self.assertIn("ERROR  t.broken  (0.50 s)", lines)
        table = lines[lines.index("All tests (3), the slowest first") + 1:]
        self.assertEqual([ln.split()[-1] for ln in table],
                         ["t.slow_bad", "t.broken", "t.ok"])
        self.assertIn("FAILED", table[0])

