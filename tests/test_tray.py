"""tray.py: the icon pixmaps, the dbusmenu layout, and the tray menu. Needs PyGObject
and GdkPixbuf, so it skips where they are missing (the deb build)."""

import os
import unittest

try:
    import gi
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GLib
    from colcon_dashboard import tray
except (ImportError, ValueError):
    tray = None

LOGO = os.path.join(os.path.dirname(__file__), os.pardir, "colcon_dashboard", "static",
                    "logo-dark.svg")


@unittest.skipIf(tray is None, "needs PyGObject and GdkPixbuf")
class Pixmaps(unittest.TestCase):
    def test_every_size_in_argb(self):
        icons = tray.pixmaps(LOGO)
        if not icons:
            self.skipTest("no SVG loader for GdkPixbuf")
        self.assertEqual([(w, h) for w, h, _ in icons], [(s, s) for s in tray.SIZES])
        for w, h, data in icons:
            self.assertEqual(len(data), w * h * 4)

    def test_gray_has_no_color(self):
        icons = tray.pixmaps(LOGO, gray=True)
        if not icons:
            self.skipTest("no SVG loader for GdkPixbuf")
        _, _, data = icons[-1]
        for i in range(0, len(data), 4):  # A, R, G, B
            if data[i] > 200:
                self.assertTrue(abs(data[i + 1] - data[i + 2]) <= 1
                                and abs(data[i + 2] - data[i + 3]) <= 1)


@unittest.skipIf(tray is None, "needs PyGObject and GdkPixbuf")
class Menu(unittest.TestCase):
    def make(self, items):
        t = tray.Tray.__new__(tray.Tray)  # the layout needs no bus
        t.items = items
        return t

    def test_layout(self):
        t = self.make([{"label": "Show"}, None,
                       {"label": "Start at login", "checked": True, "enabled": False}])
        root, props, children = t.layout()
        self.assertEqual(root, 0)
        self.assertEqual(props["children-display"].unpack(), "submenu")
        kids = [c.unpack() for c in children]
        self.assertEqual([k[0] for k in kids], [1, 2, 3])
        self.assertEqual(kids[0][1]["label"], "Show")
        self.assertEqual(kids[1][1]["type"], "separator")
        self.assertEqual(kids[2][1]["toggle-state"], 1)
        self.assertFalse(kids[2][1]["enabled"])
        # the whole reply must pack as the GetLayout signature
        GLib.Variant("(u(ia{sv}av))", (1, t.layout()))

    def test_click_runs_only_enabled_items(self):
        ran = []
        t = self.make([{"label": "a", "action": lambda: ran.append("a")},
                       {"label": "b", "enabled": False, "action": lambda: ran.append("b")}])
        t.click(1, "clicked")
        t.click(2, "clicked")
        t.click(1, "hovered")
        ctx = GLib.MainContext.default()
        while ctx.pending():
            ctx.iteration(False)
        self.assertEqual(ran, ["a"])


class FakeTray:
    def set_state(self, tip, gray):
        self.tip, self.gray = tip, gray

    def set_menu(self, items):
        self.items = items


@unittest.skipIf(tray is None, "needs PyGObject and GdkPixbuf")
class AppMenu(unittest.TestCase):
    def make(self, alive, builds, busy=None):
        from colcon_dashboard import desktop
        app = tray.TrayApp.__new__(tray.TrayApp)  # no bus, no poll
        app.desktop, app.tray = desktop, FakeTray()
        app.alive, app.builds, app.busy = alive, builds, busy
        app.update()
        return app.tray

    def labels(self, t):
        return {it["label"]: it.get("enabled", True) for it in t.items if it}

    def test_running_server_with_a_build(self):
        t = self.make(True, [
            {"path": "/ws/robot", "active": True, "done": 3, "total": 10, "failed": 0},
            {"path": "/ws/old", "active": False, "done": 5, "total": 5, "failed": 0},
            {"path": "/ws/new", "active": False, "done": 0, "total": 0, "failed": 0}])
        self.assertEqual(t.tip, "robot: 3/10")
        self.assertFalse(t.gray)
        labels = self.labels(t)
        self.assertIn("    robot: building 3/10", labels)
        self.assertIn("    old: complete", labels)
        self.assertNotIn("    new: complete", labels)  # no build seen there
        self.assertFalse(labels["Start the Server"])
        self.assertTrue(labels["Stop the Server"])

    def test_stopped_server_is_gray(self):
        t = self.make(False, [])
        self.assertTrue(t.gray)
        self.assertEqual(t.tip, "The server does not run.")
        labels = self.labels(t)
        self.assertTrue(labels["Start the Server"])
        self.assertFalse(labels["Restart the Server"])
        self.assertTrue(labels["Open Dashboard"])  # it starts the server first

    def test_busy_disables_the_actions(self):
        labels = self.labels(self.make(True, [], busy="restarting"))
        self.assertIn("Server: restarting", labels)
        self.assertFalse(labels["Stop the Server"])
        self.assertTrue(labels["Quit the Tray Icon"])


if __name__ == "__main__":
    unittest.main()
