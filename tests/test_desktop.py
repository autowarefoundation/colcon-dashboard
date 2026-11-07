"""desktop.py: the launchers and the menu entry, without PyGObject."""

import configparser
import os
import sys
import tempfile
import unittest
from unittest import mock

from colcon_dashboard import desktop


class Entry(unittest.TestCase):
    def test_exec_points_at_the_command(self):
        text = desktop.desktop_entry("/home/u/.local/bin/colcon-dashboard")
        entry = configparser.ConfigParser(interpolation=None)
        entry.optionxform = str
        entry.read_string(text)
        e = entry["Desktop Entry"]
        self.assertEqual(e["Exec"], "/home/u/.local/bin/colcon-dashboard --app")
        self.assertEqual(e["Icon"], desktop.APP_ID)
        # the entry opens a browser window: no window of its own to wait for
        self.assertNotIn("StartupWMClass", e)
        self.assertEqual(e["StartupNotify"], "false")

    def test_packaged_entry_runs_the_path_command(self):
        with open(os.path.join(desktop.DATA_DIR, desktop.APP_ID + ".desktop")) as f:
            self.assertIn("\nExec=colcon-dashboard --app\n", f.read())

    def test_install_and_uninstall(self):
        with tempfile.TemporaryDirectory() as home, \
                mock.patch.dict(os.environ, {"XDG_DATA_HOME": home}), \
                mock.patch.object(desktop.shutil, "which", return_value=None), \
                mock.patch("builtins.print"):
            desktop.install_desktop()
            self.assertTrue(os.path.exists(os.path.join(
                home, "applications", desktop.APP_ID + ".desktop")))
            self.assertTrue(os.path.exists(os.path.join(
                home, "icons/hicolor/scalable/apps", desktop.APP_ID + ".svg")))
            desktop.uninstall_desktop()
            self.assertFalse(os.path.exists(desktop.entry_path()))
            self.assertFalse(os.path.exists(desktop.icon_path()))


class OpenApp(unittest.TestCase):
    def test_starts_the_server_when_none_answers(self):
        info = {"host": "127.0.0.1", "port": 8642, "pid": 1}
        alive = iter([False])
        with mock.patch.object(desktop, "read_server", return_value=info), \
                mock.patch.object(desktop, "probe_server", lambda i: next(alive, True)), \
                mock.patch.object(desktop, "start_server", return_value=(True, "")) as start, \
                mock.patch.object(desktop, "register_workspace") as register, \
                mock.patch.object(desktop.browser, "open_dashboard") as opened, \
                mock.patch("builtins.print"):
            desktop.open_app("/ws")
        start.assert_called_once()
        register.assert_called_once_with(info, "/ws")
        opened.assert_called_once_with("http://localhost:8642/?ws=%2Fws")

    def test_no_workspace_opens_the_last_one(self):
        info = {"host": "127.0.0.1", "port": 8642, "pid": 1}
        with mock.patch.object(desktop, "read_server", return_value=info), \
                mock.patch.object(desktop, "probe_server", return_value=True), \
                mock.patch.object(desktop.browser, "open_dashboard") as opened, \
                mock.patch("builtins.print"):
            desktop.open_app()
        opened.assert_called_once_with("http://localhost:8642/last")

    def test_a_failed_start_stops(self):
        with mock.patch.object(desktop, "read_server", return_value=None), \
                mock.patch.object(desktop, "probe_server", return_value=False), \
                mock.patch.object(desktop, "start_server", return_value=(False, "no")), \
                mock.patch.object(desktop.browser, "open_dashboard") as opened:
            with self.assertRaises(SystemExit):
                desktop.open_app()
        opened.assert_not_called()


class Pythons(unittest.TestCase):
    def test_server_commands_use_the_install_python(self):
        with mock.patch.dict(os.environ, {desktop.PYTHON_ENV: "/venv/bin/python"}):
            self.assertEqual(desktop.cli_cmd("--stop")[:3],
                             ["/venv/bin/python", "-m", "colcon_dashboard"])
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(desktop.PYTHON_ENV, None)
            self.assertEqual(desktop.cli_cmd()[0], sys.executable)

    def test_child_env_drops_the_shim(self):
        env = {"PYTHONPATH": os.pathsep.join([desktop.SHIM_DIR, "/opt/ros/lib"]),
               desktop.PYTHON_ENV: "/venv/bin/python"}
        with mock.patch.dict(os.environ, env):
            child = desktop.child_env()
        self.assertEqual(child["PYTHONPATH"], "/opt/ros/lib")
        self.assertNotIn(desktop.PYTHON_ENV, child)

    def test_a_venv_is_not_the_system_python(self):
        # a venv Python links to the system binary: only the prefix differs
        with mock.patch.object(sys, "prefix", "/venv"), \
                mock.patch.object(sys, "base_prefix", "/usr"), \
                mock.patch.object(sys, "executable", desktop.SYSTEM_PYTHON):
            self.assertTrue(desktop.not_system_python())

    def test_shim_holds_only_the_package(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(desktop, "SHIM_DIR", d):
            path = desktop.shim_path()
            self.assertEqual(os.listdir(path), ["colcon_dashboard"])
            self.assertEqual(os.path.realpath(os.path.join(path, "colcon_dashboard")),
                             desktop.PKG_DIR)
            desktop.shim_path()  # a second call keeps the link
            self.assertEqual(os.listdir(path), ["colcon_dashboard"])


if __name__ == "__main__":
    unittest.main()
