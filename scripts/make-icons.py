#!/usr/bin/env python3
"""Render the PNG app icons in colcon_dashboard/static/ from logo.svg.

The web app manifest needs PNG icons: Linux desktops use them for the
menu entry and the dock when a browser installs the dashboard as an app.
The PNG files go into git, so the server and the frontend keep no build
step. Run this script again after a change to logo.svg. It needs
Inkscape (sudo apt install inkscape).

    icon-192.png, icon-512.png   the logo on a transparent background
    icon-maskable-512.png        the logo inside the 80% safe zone, on
                                 a solid background: a desktop can crop
                                 it to a circle or a rounded square
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      os.pardir, "colcon_dashboard", "static")
BACKGROUND = "#f2f6fb"  # style.css: --page (light)
MASKABLE_SCALE = 0.80   # the logo's share of the maskable icon's width


def logo_inner(src):
    """The logo's markup, as a nested <svg> that a wrapper can place."""
    text = re.sub(r"<\?xml[^>]*\?>", "", src).strip()
    return re.sub(r'\s(width|height)="[^"]*"', "", text, count=2)


def render(svg_text, out, size):
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as f:
        f.write(svg_text)
        path = f.name
    try:
        subprocess.run(["inkscape", path, "--export-type=png",
                        f"--export-filename={out}", f"--export-width={size}",
                        f"--export-height={size}"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        os.unlink(path)
    print(f"wrote {os.path.relpath(out)}")


def main():
    if not shutil.which("inkscape"):
        sys.exit("this script needs Inkscape: sudo apt install inkscape")
    with open(os.path.join(STATIC, "logo.svg")) as f:
        logo = f.read()
    for size in (192, 512):
        render(logo, os.path.join(STATIC, f"icon-{size}.png"), size)
    inner = logo_inner(logo)
    side = 100 * MASKABLE_SCALE
    at = (100 - side) / 2
    nested = inner.replace(
        "<svg ", f'<svg x="{at:g}" y="{at:g}" width="{side:g}" height="{side:g}" ', 1)
    maskable = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
                f'<rect width="100" height="100" fill="{BACKGROUND}"/>{nested}</svg>')
    render(maskable, os.path.join(STATIC, "icon-maskable-512.png"), 512)


if __name__ == "__main__":
    main()
