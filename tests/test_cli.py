"""cli.py helpers and the shared naming/version rules."""

import unittest

from colcon_dashboard.cli import display_host, fmt_bytes, fmt_dur, unit_path
from colcon_dashboard.events import BUILD_DIR_RE
from colcon_dashboard.registry import _ver_key


class FmtHelpers(unittest.TestCase):
    def test_fmt_dur(self):
        self.assertEqual(fmt_dur(0), "0:00")
        self.assertEqual(fmt_dur(61), "1:01")
        self.assertEqual(fmt_dur(3661), "1:01:01")

    def test_fmt_bytes(self):
        self.assertEqual(fmt_bytes(0), "0B")
        self.assertEqual(fmt_bytes(1023), "1023B")
        self.assertEqual(fmt_bytes(1536), "1.5K")
        self.assertEqual(fmt_bytes(10 * 1024 * 1024), "10M")


class DisplayHost(unittest.TestCase):
    def test_wildcards_become_loopback(self):
        for host in (None, "", "0.0.0.0", "::"):
            self.assertEqual(display_host(host), "127.0.0.1")

    def test_real_hosts_stay(self):
        self.assertEqual(display_host("192.168.1.7"), "192.168.1.7")


class UnitPath(unittest.TestCase):
    def test_user_unit_location(self):
        self.assertTrue(unit_path().endswith(
            ".config/systemd/user/colcon-dashboard.service"))


class BuildDirNames(unittest.TestCase):
    def test_accepts_build_and_test_runs(self):
        self.assertTrue(BUILD_DIR_RE.fullmatch("build_2026-08-09_10-00-00"))
        self.assertTrue(BUILD_DIR_RE.fullmatch("test_2026-08-09_10-00-00"))

    def test_rejects_everything_else(self):
        for bad in ("latest_build", "build_a/b", "../build_x", "install"):
            self.assertIsNone(BUILD_DIR_RE.fullmatch(bad))


class VersionKey(unittest.TestCase):
    def test_ordering(self):
        self.assertGreater(_ver_key("0.9.0"), _ver_key("0.8.3"))
        self.assertGreater(_ver_key("0.10.0"), _ver_key("0.9.9"))
        self.assertGreater(_ver_key("1.0.0"), _ver_key("0.99.99"))

    def test_junk_is_zero(self):
        self.assertEqual(_ver_key(None), (0, 0, 0))
        self.assertEqual(_ver_key("nonsense"), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
