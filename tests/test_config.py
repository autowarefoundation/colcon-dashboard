"""config.py: the ini file must never break the server."""

import os
import tempfile
import unittest

from colcon_dashboard.config import Config


class ConfigFile(unittest.TestCase):
    def load(self, text):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        path = os.path.join(self.tmp.name, "config.ini")
        with open(path, "w") as f:
            f.write(text)
        return Config(path=path)

    def test_missing_file(self):
        cfg = Config(path="/nonexistent/colcon-dashboard.ini")
        self.assertFalse(cfg.exists)
        self.assertIsNone(cfg.host)
        self.assertIsNone(cfg.port)
        self.assertIsNone(cfg.log_base)
        self.assertIsNone(cfg.auto_prune_keep)
        self.assertIsNone(cfg.claude_bin)
        self.assertIsNone(cfg.editor_url)
        self.assertFalse(cfg.check_updates)

    def test_values_and_inline_comments(self):
        cfg = self.load(
            "[server]\n"
            "host = 0.0.0.0\n"
            "port = 9000   ; the docs show inline comments\n"
            "log_base = logs\n"
            "check_updates = true\n"
            "[builds]\n"
            "auto_prune_keep = 10\n"
            "[ai]\n"
            "claude_bin = /opt/claude\n"
            "[ui]\n"
            "editor_url = vscode://file{path}:{line}\n")
        self.assertTrue(cfg.exists)
        self.assertEqual(cfg.host, "0.0.0.0")
        self.assertEqual(cfg.port, 9000)
        self.assertEqual(cfg.log_base, "logs")
        self.assertTrue(cfg.check_updates)
        self.assertEqual(cfg.auto_prune_keep, 10)
        self.assertEqual(cfg.claude_bin, "/opt/claude")
        self.assertEqual(cfg.editor_url, "vscode://file{path}:{line}")

    def test_bad_values_resolve_to_none(self):
        cfg = self.load(
            "[server]\n"
            "port = banana\n"
            "check_updates = maybe\n"
            "[builds]\n"
            "auto_prune_keep = -1\n")
        self.assertTrue(cfg.exists)
        self.assertIsNone(cfg.port)
        self.assertFalse(cfg.check_updates)
        self.assertEqual(cfg.auto_prune_keep, -1)  # -1 means disabled

    def test_empty_value_is_none(self):
        cfg = self.load("[server]\nhost =\n")
        self.assertIsNone(cfg.host)

    def test_broken_file_is_tolerated(self):
        cfg = self.load("this is not an ini file [[[")
        self.assertFalse(cfg.exists)
        self.assertIsNone(cfg.host)

    def test_partially_broken_file_applies_nothing(self):
        # half-applied values with exists=False would deny their own use
        cfg = self.load("[server]\nhost = 10.0.0.5\nport = 9999\n"
                        "this line is broken\n")
        self.assertFalse(cfg.exists)
        self.assertIsNone(cfg.host)
        self.assertIsNone(cfg.port)


if __name__ == "__main__":
    unittest.main()
