"""config.py: the ini file must never break the server."""

import os
import tempfile
import unittest

from colcon_dashboard.config import (Config, TEMPLATE, save_extra_roots,
                                     write_template)


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
        self.assertEqual(cfg.extra_roots, [])
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

    def test_extra_roots_split_and_expand(self):
        cfg = self.load("[discover]\n"
                        "extra_roots = /mnt/data, ~/ros,\n"
                        "  /srv/ws\n")
        self.assertEqual(cfg.extra_roots, [
            "/mnt/data", os.path.expanduser("~/ros"), "/srv/ws"])

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


class TemplateFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "colcon-dashboard",
                                 "config.ini")

    def test_template_applies_no_values(self):
        # the template only documents; a server reading it uses defaults
        self.assertEqual(write_template(self.path), self.path)
        cfg = Config(path=self.path)
        self.assertTrue(cfg.exists)
        self.assertIsNone(cfg.host)
        self.assertIsNone(cfg.port)
        self.assertIsNone(cfg.log_base)
        self.assertFalse(cfg.check_updates)
        self.assertIsNone(cfg.auto_prune_keep)
        self.assertIsNone(cfg.claude_bin)
        self.assertIsNone(cfg.editor_url)
        self.assertEqual(cfg.extra_roots, [])

    def test_template_documents_every_key(self):
        for key in ("host", "port", "log_base", "check_updates",
                    "auto_prune_keep", "claude_bin", "editor_url",
                    "extra_roots"):
            self.assertIn(f"#{key} = ", TEMPLATE)

    def test_never_overwrites(self):
        os.makedirs(os.path.dirname(self.path))
        with open(self.path, "w") as f:
            f.write("[server]\nport = 9000\n")
        self.assertIsNone(write_template(self.path))
        self.assertEqual(Config(path=self.path).port, 9000)

    def test_unwritable_path_returns_none(self):
        # a file where the directory should be blocks even root
        blocker = os.path.join(self.tmp.name, "blocker")
        with open(blocker, "w") as f:
            f.write("")
        self.assertIsNone(write_template(
            os.path.join(blocker, "sub", "config.ini")))


class SaveExtraRoots(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "config.ini")

    def save(self, text, roots):
        if text is not None:
            with open(self.path, "w") as f:
                f.write(text)
        self.assertEqual(save_extra_roots(roots, self.path), self.path)
        with open(self.path) as f:
            return f.read()

    def test_replaces_the_line_and_keeps_the_rest(self):
        text = ("# top\n[server]\nport = 9000\n\n[discover]\n"
                "# a note\nextra_roots = /old,\n    /older\n\n[ui]\n"
                "editor_url = x\n")
        out = self.save(text, ["/a", "/b"])
        self.assertEqual(out, text.replace(
            "extra_roots = /old,\n    /older\n", "extra_roots = /a, /b\n"))
        cfg = Config(path=self.path)
        self.assertEqual(cfg.extra_roots, ["/a", "/b"])
        self.assertEqual(cfg.port, 9000)

    def test_uncomments_below_the_template_example(self):
        out = self.save(TEMPLATE, ["/a"])
        self.assertIn("#extra_roots = /mnt/data, ~/ros\nextra_roots = /a\n",
                      out)
        self.assertEqual(Config(path=self.path).extra_roots, ["/a"])

    def test_missing_file_starts_from_the_template(self):
        out = self.save(None, ["/a"])
        self.assertTrue(out.startswith(TEMPLATE.splitlines()[0]))
        self.assertEqual(Config(path=self.path).extra_roots, ["/a"])

    def test_adds_the_section(self):
        out = self.save("[server]\nport = 9000", ["/a"])
        self.assertEqual(out, "[server]\nport = 9000\n\n[discover]\n"
                              "extra_roots = /a\n")

    def test_empty_list_unsets(self):
        self.save("[discover]\nextra_roots = /a\n", [])
        self.assertEqual(Config(path=self.path).extra_roots, [])


if __name__ == "__main__":
    unittest.main()
