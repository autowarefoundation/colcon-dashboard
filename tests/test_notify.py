"""Desktop notifications from the server (registry.py, notify.py), and
the browser choice for the links they open (browser.py)."""

import os
import tempfile
import unittest
from unittest import mock

from colcon_dashboard import browser, notify
from colcon_dashboard import registry as registry_mod
from colcon_dashboard.registry import Registry
import tests.helpers  # noqa: F401  (it points CONFIG at a test path)


class NotifyMode(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name in ("CACHE_DIR", "REGISTRY_FILE"):
            self.addCleanup(setattr, registry_mod, name, getattr(registry_mod, name))
        registry_mod.CACHE_DIR = tmp.name
        registry_mod.REGISTRY_FILE = os.path.join(tmp.name, "workspaces.json")

    def test_no_choice_yet(self):
        self.assertIsNone(Registry().notify_mode)

    def test_mode_persists(self):
        self.assertTrue(Registry().set_notify_mode("sound"))
        reg = Registry()
        self.assertEqual(reg.notify_mode, "sound")
        self.assertTrue(reg.notifying())
        self.assertFalse(reg.set_notify_mode("loud"))
        self.assertEqual(reg.notify_mode, "sound")

    def test_build_events_become_notifications(self):
        reg = Registry()
        reg.set_notify_mode("on")
        reg.base_url = "http://localhost:8642/"
        sent = []
        with mock.patch.object(notify, "available", return_value=True), \
                mock.patch.object(notify, "send", lambda *a, **k: sent.append((a, k))):
            reg._build_event("/ws/robot", "failed", {"name": "planner"})
            reg._build_event("/ws/robot", "end", {"counts": {"done": 3}, "total": 3,
                                                  "elapsed": 75})
            reg._build_event("/ws/robot", "end", {"counts": {"done": 1, "aborted": 2},
                                                  "total": 3, "elapsed": 5})
        self.assertEqual([a for a, _ in sent], [
            ("✗ planner failed", "the first failure in robot"),
            ("✓ robot: build complete", "3 packages in 1m 15s"),
            ("◌ robot: build stopped", "1/3 done, 2 aborted"),
        ])
        self.assertTrue(sent[0][1]["urgent"])
        self.assertIsNotNone(sent[0][1]["on_click"])

    def test_off_sends_nothing(self):
        reg = Registry()
        reg.set_notify_mode("off")
        with mock.patch.object(notify, "available", return_value=True), \
                mock.patch.object(notify, "send") as send:
            reg._build_event("/ws/robot", "failed", {"name": "planner"})
        send.assert_not_called()


class NotifyCommand(unittest.TestCase):
    def test_notify_send_line(self):
        with mock.patch("shutil.which", lambda name: "/usr/bin/" + name):
            cmd = notify.command("title", "-body", action=True)
        self.assertEqual(cmd[0], "notify-send")
        self.assertIn("default=Open", cmd)
        # a body that starts with a dash is not an option
        self.assertEqual(cmd[-3:], ["--", "title", "-body"])

    def test_gdbus_quotes_its_strings(self):
        which = {"gdbus": "/usr/bin/gdbus"}.get
        with mock.patch("shutil.which", which):
            cmd = notify.command('say "hi"', "body")
        self.assertEqual(cmd[0], "gdbus")
        self.assertIn('"say \\"hi\\""', cmd)


URL = "http://localhost:8642/"
WS_URL = URL + "?ws=%2Fws"
CHROME = ["/usr/bin/google-chrome-stable"]
APP = ["/opt/google/chrome/google-chrome", "--profile-directory=Default", "--app-id=abc"]


class BrowserPlan(unittest.TestCase):
    def test_installed_app_first(self):
        self.assertEqual(browser.plan(URL, "auto", ("chromium", CHROME), APP), APP)
        self.assertEqual(browser.plan(WS_URL, "auto", ("chromium", CHROME), APP),
                         APP + ["--app-launch-url-for-shortcuts-menu-item=" + WS_URL])

    def test_app_window_without_the_app(self):
        self.assertEqual(browser.plan(URL, "auto", ("chromium", CHROME), []),
                         CHROME + ["--app=" + URL])

    def test_firefox_gets_a_window(self):
        argv = ["/snap/bin/firefox"]
        self.assertEqual(browser.plan(URL, "auto", ("firefox", argv), APP),
                         argv + ["--new-window", URL])

    def test_unknown_and_default_use_webbrowser(self):
        self.assertIsNone(browser.plan(URL, "auto", ("other", []), APP))
        self.assertIsNone(browser.plan(URL, "default", ("chromium", CHROME), APP))

    def test_kind_of(self):
        self.assertEqual(browser.kind_of("google-chrome.desktop"), "chromium")
        self.assertEqual(browser.kind_of("firefox_firefox.desktop"), "firefox")
        self.assertEqual(browser.kind_of("org.chromium.Chromium.desktop"), "chromium")
        self.assertEqual(browser.kind_of("x.desktop", ["env", "/snap/bin/brave"]), "chromium")
        self.assertEqual(browser.kind_of("epiphany.desktop"), "other")

    def test_installed_app_from_chrome_entry(self):
        with tempfile.TemporaryDirectory() as home:
            apps = os.path.join(home, "applications")
            os.makedirs(apps)
            with open(os.path.join(apps, "chrome-abc-Default.desktop"), "w") as f:
                f.write("[Desktop Entry]\nName=Colcon Dashboard\n"
                        "Exec=/opt/google/chrome/google-chrome --profile-directory=Default"
                        " --app-id=abc %U\n")
            with open(os.path.join(apps, "other.desktop"), "w") as f:
                f.write("[Desktop Entry]\nName=Colcon Dashboard\nExec=colcon-dashboard --app\n")
            with mock.patch.dict(os.environ, {"XDG_DATA_HOME": home}):
                self.assertEqual(browser.installed_app(), APP)


if __name__ == "__main__":
    unittest.main()
