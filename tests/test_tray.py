"""tray.py: the icon pixmaps and the dbusmenu layout. Needs PyGObject
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


if __name__ == "__main__":
    unittest.main()
