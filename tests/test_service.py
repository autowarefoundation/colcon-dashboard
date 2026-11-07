"""service.py: start at login, and the tray's autostart entry."""

import os
import tempfile
import unittest
from unittest import mock

from colcon_dashboard import service


class FakeSystemd:
    """systemctl --user is-enabled/enable/disable/mask, in memory."""

    def __init__(self, state="disabled", global_enable=False):
        self.state = state
        self.global_enable = global_enable  # the deb package's enable
        self.calls = []

    def run(self, *args, quiet=False):
        self.calls.append(args)
        verb = args[0]
        if verb == "enable":
            self.state = "enabled"
        elif verb == "disable":
            self.state = "enabled" if self.global_enable else "disabled"
        elif verb == "mask":
            self.state = "masked"
        elif verb == "unmask":
            self.state = "enabled" if self.global_enable else "disabled"
        return 0

    def out(self, *args):
        return self.state if args[0] == "is-enabled" else "loaded"


class SetLogin(unittest.TestCase):
    def patch(self, fake, user_unit=False):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        unit = os.path.join(tmp.name, service.SERVICE)
        if user_unit:
            open(unit, "w").close()
        for target, value in (("systemctl", fake.run), ("systemctl_out", fake.out),
                              ("user_systemd_works", lambda: True),
                              ("unit_path", lambda: unit)):
            p = mock.patch.object(service, target, value)
            p.start()
            self.addCleanup(p.stop)

    def test_on_and_off(self):
        fake = FakeSystemd()
        self.patch(fake, user_unit=True)
        self.assertTrue(service.set_login(True)[0])
        self.assertEqual(fake.state, "enabled")
        self.assertTrue(service.set_login(False)[0])
        self.assertEqual(fake.state, "disabled")

    def test_off_masks_the_package_enable(self):
        fake = FakeSystemd("enabled", global_enable=True)
        self.patch(fake)
        ok, _ = service.set_login(False)
        self.assertTrue(ok)
        self.assertEqual(fake.state, "masked")
        self.assertTrue(service.set_login(True)[0])  # unmask, then enable
        self.assertIn(("unmask", service.SERVICE), fake.calls)
        self.assertEqual(fake.state, "enabled")

    def test_package_enable_with_a_user_unit_cannot_mask(self):
        fake = FakeSystemd("enabled", global_enable=True)
        self.patch(fake, user_unit=True)
        ok, msg = service.set_login(False)
        self.assertFalse(ok)
        self.assertIn("--uninstall-service", msg)

    def test_no_systemd(self):
        with mock.patch.object(service, "user_systemd_works", lambda: False):
            self.assertFalse(service.set_login(True)[0])


class TrayAutostart(unittest.TestCase):
    def test_write_and_remove(self):
        with tempfile.TemporaryDirectory() as cfg, \
                mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": cfg}), \
                mock.patch.object(service, "tray_supported", lambda: True), \
                mock.patch.object(service, "start_tray") as start:
            self.assertTrue(service.set_tray_autostart(True)[0])
            start.assert_called_once()
            with open(service.autostart_path()) as f:
                entry = f.read()
            self.assertIn("-m colcon_dashboard --tray", entry)
            self.assertTrue(service.tray_autostart())
            self.assertTrue(service.set_tray_autostart(False)[0])
            self.assertFalse(service.tray_autostart())

    def test_no_pygobject(self):
        with mock.patch.object(service, "tray_supported", lambda: False):
            ok, msg = service.set_tray_autostart(True)
        self.assertFalse(ok)
        self.assertIn("python3-gi", msg)


if __name__ == "__main__":
    unittest.main()
