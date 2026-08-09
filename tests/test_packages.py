"""packages.py: workspace scanning, package.xml parsing, colcon namespace."""

import os
import tempfile
import unittest

from colcon_dashboard.packages import PackageIndex, parse_namespace


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
