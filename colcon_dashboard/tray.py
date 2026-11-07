"""The tray icon (colcon-dashboard --tray), over D-Bus.

The tray is a thin client of the server: it shows whether the server
runs and which builds run, opens the dashboard in the browser, and
starts, restarts, and stops the server. It owns nothing: "Quit" closes
only the icon, and the server keeps running.

AppIndicator needs GTK 3, and the tray needs no window at all. So this
module speaks the two protocols that every tray host reads (the Ubuntu
AppIndicator extension, KDE, waybar, swaybar):

    org.kde.StatusNotifierItem   the icon, its tooltip, and the clicks
    com.canonical.dbusmenu       the menu that a right click opens

with Gio alone. The icon goes as pixmaps, not as an icon name, so it
needs no installed icon theme, and a stopped server shows it in gray.
The tray is "available" only while a StatusNotifierWatcher runs: a
plain GNOME without the AppIndicator extension has none.
"""

import json
import os
import sys
import threading
import urllib.request

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf, Gio, GLib  # noqa: E402

ITEM_PATH = "/StatusNotifierItem"
MENU_PATH = "/MenuBar"
WATCHER = "org.kde.StatusNotifierWatcher"

ITEM_XML = """
<node><interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="WindowId" type="i" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/>
  <property name="OverlayIconName" type="s" access="read"/>
  <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionIconName" type="s" access="read"/>
  <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionMovieName" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
  <signal name="NewTitle"/>
  <signal name="NewIcon"/>
  <signal name="NewAttentionIcon"/>
  <signal name="NewOverlayIcon"/>
  <signal name="NewToolTip"/>
  <signal name="NewStatus"><arg name="status" type="s"/></signal>
</interface></node>
"""

MENU_XML = """
<node><interface name="com.canonical.dbusmenu">
  <property name="Version" type="u" access="read"/>
  <property name="TextDirection" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconThemePath" type="as" access="read"/>
  <method name="GetLayout">
    <arg type="i" name="parentId" direction="in"/>
    <arg type="i" name="recursionDepth" direction="in"/>
    <arg type="as" name="propertyNames" direction="in"/>
    <arg type="u" name="revision" direction="out"/>
    <arg type="(ia{sv}av)" name="layout" direction="out"/>
  </method>
  <method name="GetGroupProperties">
    <arg type="ai" name="ids" direction="in"/>
    <arg type="as" name="propertyNames" direction="in"/>
    <arg type="a(ia{sv})" name="properties" direction="out"/>
  </method>
  <method name="GetProperty">
    <arg type="i" name="id" direction="in"/>
    <arg type="s" name="name" direction="in"/>
    <arg type="v" name="value" direction="out"/>
  </method>
  <method name="Event">
    <arg type="i" name="id" direction="in"/>
    <arg type="s" name="eventId" direction="in"/>
    <arg type="v" name="data" direction="in"/>
    <arg type="u" name="timestamp" direction="in"/>
  </method>
  <method name="EventGroup">
    <arg type="a(isvu)" name="events" direction="in"/>
    <arg type="ai" name="idErrors" direction="out"/>
  </method>
  <method name="AboutToShow">
    <arg type="i" name="id" direction="in"/>
    <arg type="b" name="needUpdate" direction="out"/>
  </method>
  <method name="AboutToShowGroup">
    <arg type="ai" name="ids" direction="in"/>
    <arg type="ai" name="updatesNeeded" direction="out"/>
    <arg type="ai" name="idErrors" direction="out"/>
  </method>
  <signal name="ItemsPropertiesUpdated">
    <arg type="a(ia{sv})" name="updatedProps"/>
    <arg type="a(ias)" name="removedProps"/>
  </signal>
  <signal name="LayoutUpdated">
    <arg type="u" name="revision"/>
    <arg type="i" name="parent"/>
  </signal>
  <signal name="ItemActivationRequested">
    <arg type="i" name="id"/>
    <arg type="u" name="timestamp"/>
  </signal>
</interface></node>
"""

SIZES = (16, 22, 24, 32, 48, 64)


def pixmaps(svg, gray=False):
    """The icon as a(iiay): ARGB32 in network byte order, per size."""
    out = []
    for size in SIZES:
        try:
            pb = GdkPixbuf.Pixbuf.new_from_file_at_size(svg, size, size)
        except GLib.Error:
            return []
        if not pb.get_has_alpha():
            pb = pb.add_alpha(False, 0, 0, 0)
        if gray:
            dim = pb.copy()
            pb.saturate_and_pixelate(dim, 0.0, False)
            pb = dim
        w, h, stride = pb.get_width(), pb.get_height(), pb.get_rowstride()
        data = pb.get_pixels()
        rgba = b"".join(data[y * stride:y * stride + w * 4] for y in range(h))
        argb = bytearray(len(rgba))
        argb[0::4] = rgba[3::4]
        argb[1::4] = rgba[0::4]
        argb[2::4] = rgba[1::4]
        argb[3::4] = rgba[2::4]
        out.append((w, h, bytes(argb)))
    return out


class Tray:
    """One tray icon. menu: a list of items, each None (a separator) or a
    dict with label, and optionally enabled, checked (a checkmark item),
    and action (called on a click). on_activate runs on a left click.
    on_available(bool) runs when a tray host comes or goes."""

    def __init__(self, conn, app_id, svg, on_activate, on_available):
        self.conn = conn
        self.app_id = app_id
        self.svg = svg
        self.on_activate = on_activate
        self.on_available = on_available
        self.available = False
        self.title = "Colcon Dashboard"
        self.tip = ""
        self.gray = False
        self.icons = {False: pixmaps(svg), True: pixmaps(svg, gray=True)}
        self.items = []
        self.revision = 1
        item = Gio.DBusNodeInfo.new_for_xml(ITEM_XML).interfaces[0]
        menu = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
        self.ids = [
            conn.register_object(ITEM_PATH, item, self.item_call, self.item_prop, None),
            conn.register_object(MENU_PATH, menu, self.menu_call, self.menu_prop, None),
        ]
        self.name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self.own = Gio.bus_own_name_on_connection(
            conn, self.name, Gio.BusNameOwnerFlags.NONE, None, None)
        self.watch = Gio.bus_watch_name_on_connection(
            conn, WATCHER, Gio.BusNameWatcherFlags.NONE, self.watcher_up, self.watcher_down)

    # -- the host ---------------------------------------------------------

    def watcher_up(self, conn, _name, _owner):
        def done(conn, result):
            try:
                conn.call_finish(result)
                ok = True
            except GLib.Error:
                ok = False
            self.set_available(ok)
        conn.call(WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem",
                  GLib.Variant("(s)", (self.name,)), None, Gio.DBusCallFlags.NONE, -1,
                  None, done)

    def watcher_down(self, _conn, _name):
        self.set_available(False)

    def set_available(self, ok):
        if ok != self.available:
            self.available = ok
            self.on_available(ok)

    def close(self):
        Gio.bus_unwatch_name(self.watch)
        Gio.bus_unown_name(self.own)
        for i in self.ids:
            self.conn.unregister_object(i)

    # -- updates from the app ---------------------------------------------

    def set_state(self, tip, gray):
        if tip != self.tip:
            self.tip = tip
            self.emit(ITEM_PATH, "org.kde.StatusNotifierItem", "NewToolTip")
        if gray != self.gray:
            self.gray = gray
            self.emit(ITEM_PATH, "org.kde.StatusNotifierItem", "NewIcon")

    def set_menu(self, items):
        def key(its):  # the callbacks are new each time: compare what shows
            return [it and (it["label"], it.get("enabled", True), it.get("checked"))
                    for it in its]
        if key(items) == key(self.items):
            self.items = items
            return
        self.items = items
        self.revision += 1
        self.emit(MENU_PATH, "com.canonical.dbusmenu", "LayoutUpdated",
                  GLib.Variant("(ui)", (self.revision, 0)))

    def emit(self, path, iface, signal, args=None):
        try:
            self.conn.emit_signal(None, path, iface, signal, args)
        except GLib.Error:
            pass

    # -- org.kde.StatusNotifierItem ---------------------------------------

    def item_prop(self, _conn, _sender, _path, _iface, name):
        icon = self.icons[self.gray]
        values = {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", self.app_id),
            "Title": GLib.Variant("s", self.title),
            "Status": GLib.Variant("s", "Active"),
            "WindowId": GLib.Variant("i", 0),
            "IconName": GLib.Variant("s", ""),
            "IconPixmap": GLib.Variant("a(iiay)", icon),
            "OverlayIconName": GLib.Variant("s", ""),
            "OverlayIconPixmap": GLib.Variant("a(iiay)", []),
            "AttentionIconName": GLib.Variant("s", ""),
            "AttentionIconPixmap": GLib.Variant("a(iiay)", []),
            "AttentionMovieName": GLib.Variant("s", ""),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", ("", [], self.title, self.tip)),
            "ItemIsMenu": GLib.Variant("b", False),
            "Menu": GLib.Variant("o", MENU_PATH),
        }
        return values.get(name)

    def item_call(self, _conn, _sender, _path, _iface, method, _params, invocation):
        if method in ("Activate", "SecondaryActivate"):
            GLib.idle_add(lambda: self.on_activate() and False)
        invocation.return_value(None)

    # -- com.canonical.dbusmenu -------------------------------------------

    def menu_prop(self, _conn, _sender, _path, _iface, name):
        return {
            "Version": GLib.Variant("u", 3),
            "TextDirection": GLib.Variant("s", "ltr"),
            "Status": GLib.Variant("s", "normal"),
            "IconThemePath": GLib.Variant("as", []),
        }.get(name)

    def props(self, i):
        """The dbusmenu properties of item i (1-based; 0 is the root)."""
        if i == 0:
            return {"children-display": GLib.Variant("s", "submenu")}
        item = self.items[i - 1]
        if item is None:
            return {"type": GLib.Variant("s", "separator")}
        p = {"label": GLib.Variant("s", item["label"]),
             "enabled": GLib.Variant("b", item.get("enabled", True))}
        if "checked" in item:
            p["toggle-type"] = GLib.Variant("s", "checkmark")
            p["toggle-state"] = GLib.Variant("i", 1 if item["checked"] else 0)
        return p

    def layout(self):
        children = [GLib.Variant("(ia{sv}av)", (i, self.props(i), []))
                    for i in range(1, len(self.items) + 1)]
        return (0, self.props(0), children)

    def menu_call(self, _conn, _sender, _path, _iface, method, params, invocation):
        valid = range(0, len(self.items) + 1)
        if method == "GetLayout":
            invocation.return_value(GLib.Variant("(u(ia{sv}av))", (self.revision, self.layout())))
        elif method == "GetGroupProperties":
            ids = params.unpack()[0] or list(valid)
            invocation.return_value(GLib.Variant(
                "(a(ia{sv}))", ([(i, self.props(i)) for i in ids if i in valid],)))
        elif method == "GetProperty":
            i, name = params.unpack()
            value = self.props(i).get(name) if i in valid else None
            invocation.return_value(GLib.Variant("(v)", (value or GLib.Variant("s", ""),)))
        elif method == "Event":
            i, event = params.unpack()[:2]
            self.click(i, event)
            invocation.return_value(None)
        elif method == "EventGroup":
            for i, event, _data, _t in params.unpack()[0]:
                self.click(i, event)
            invocation.return_value(GLib.Variant("(ai)", ([],)))
        elif method == "AboutToShow":
            invocation.return_value(GLib.Variant("(b)", (False,)))
        elif method == "AboutToShowGroup":
            invocation.return_value(GLib.Variant("(aiai)", ([], [])))
        else:
            invocation.return_value(None)

    def click(self, i, event):
        if event != "clicked" or not 1 <= i <= len(self.items):
            return
        item = self.items[i - 1]
        if item and item.get("enabled", True) and item.get("action"):
            GLib.idle_add(lambda: item["action"]() and False)


# -- the tray app ----------------------------------------------------------------

POLL_SECONDS = 3
BUS_NAME = "io.github.autowarefoundation.ColconDashboard.Tray"
# loopback requests must not go through an http_proxy from the environment
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class TrayApp:
    """The icon, its menu, and a poll of the server every few seconds."""

    def __init__(self, conn, loop):
        from . import desktop  # standard library only, like the server modules
        self.desktop = desktop
        self.loop = loop
        self.alive = False
        self.busy = None  # "starting", "stopping", "restarting", or None
        self.builds = []
        logo = os.path.join(desktop.PKG_DIR, "static", "logo-dark.svg")  # panels are mostly dark
        self.tray = Tray(conn, desktop.APP_ID, logo, self.open, self.on_available)
        self.update()
        self.poll()
        GLib.timeout_add_seconds(POLL_SECONDS, self.poll)

    # -- the server -------------------------------------------------------

    def poll(self):
        threading.Thread(target=self._fetch, daemon=True).start()
        return True  # keep the timer

    def _fetch(self):
        from .cli import api_url, read_server
        info = read_server()
        alive, builds = False, []
        if info and "port" in info:
            try:
                with OPENER.open(api_url(info, "/api/live"), timeout=2) as r:
                    builds = json.load(r).get("workspaces", [])
                alive = True
            except (OSError, ValueError):
                pass
        GLib.idle_add(self._fetched, alive, builds)

    def _fetched(self, alive, builds):
        self.alive, self.builds = alive, builds
        self.update()
        return False

    def run_job(self, verb, work):
        """Run a slow server command off the main loop."""
        if self.busy:
            return
        self.busy = verb
        self.update()

        def target():
            ok, msg = work()
            GLib.idle_add(done, ok, msg)

        def done(ok, msg):
            self.busy = None
            if not ok and msg:
                self.notify_failure(msg)
            self.poll()
            return False
        threading.Thread(target=target, daemon=True).start()

    def notify_failure(self, msg):
        from . import notify
        if not notify.send("Colcon Dashboard", msg, urgent=True):
            print(msg, file=sys.stderr)

    # -- the actions ------------------------------------------------------

    def open(self, workspace=None):
        def work():
            from .cli import read_server, server_url
            if not self.alive:
                ok, msg = self.desktop.start_server()
                if not ok:
                    return ok, msg
            from . import browser
            browser.open_dashboard(server_url(read_server(), workspace))
            return True, ""
        if self.alive:
            work()
        else:
            self.run_job("starting", work)

    def on_available(self, ok):
        if ok:
            self.update()
        else:
            print("no tray host answers: the icon shows when one starts (on GNOME,"
                  " the AppIndicator extension)", file=sys.stderr)

    def update(self):
        state = self.busy or ("running" if self.alive else "stopped")
        running = [b for b in self.builds if b.get("active")]
        if not self.alive:
            tip = "The server does not run."
        elif running:
            tip = ", ".join(f"{os.path.basename(b['path'])}: {b['done']}/{b['total']}"
                            for b in running)
        else:
            tip = "No build runs."
        self.tray.set_state(tip, gray=not self.alive and not self.busy)
        idle = self.busy is None
        items = [{"label": "Open Dashboard", "enabled": idle, "action": self.open},
                 None,
                 {"label": f"Server: {state}", "enabled": False}]
        for b in self.builds[:6]:
            name = os.path.basename(b["path"]) or b["path"]
            if b.get("active"):
                what = f"building {b['done']}/{b['total']}"
            elif b.get("failed"):
                what = f"{b['failed']} failed"
            elif b.get("total") and b.get("done") == b.get("total"):
                what = "complete"
            else:
                continue  # no build seen there yet
            items.append({"label": f"    {name}: {what}", "enabled": idle,
                          "action": lambda p=b["path"]: self.open(p)})
        d = self.desktop
        items += [None,
                  {"label": "Start the Server", "enabled": idle and not self.alive,
                   "action": lambda: self.run_job("starting", d.start_server)},
                  {"label": "Restart the Server", "enabled": idle and self.alive,
                   "action": lambda: self.run_job("restarting", d.restart_server)},
                  {"label": "Stop the Server", "enabled": idle and self.alive,
                   "action": lambda: self.run_job("stopping", d.stop_server)},
                  None,
                  {"label": "Quit the Tray Icon", "action": self.quit}]
        self.tray.set_menu(items)

    def quit(self):
        self.tray.close()
        self.loop.quit()


def run():
    try:
        conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as exc:
        raise SystemExit(f"no D-Bus session bus: {exc.message}")
    # one tray per session: a second one exits at once
    reply = conn.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
                           "org.freedesktop.DBus", "RequestName",
                           GLib.Variant("(su)", (BUS_NAME, 4)),  # 4: do not queue
                           GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, None)
    if reply.unpack()[0] not in (1, 4):  # 1: the owner now, 4: the owner before
        print("the tray icon runs already")
        return 0
    loop = GLib.MainLoop()
    TrayApp(conn, loop)
    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(run())
