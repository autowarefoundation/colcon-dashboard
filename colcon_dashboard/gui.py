"""The desktop app window: the dashboard page in WebKitGTK, in a
libadwaita window with the server controls in the header bar.

Run it through desktop.launch() (colcon-dashboard --app), which finds a
Python with PyGObject. It targets Ubuntu 22.04 and newer: GTK 4.6,
libadwaita 1.1, WebKitGTK 6.0. Newer API is used only behind a check.

The window shows the page of the one server per machine. When no server
answers, the app starts one (desktop.start_server) and shows the page
once it answers. The page tells the app its theme through a script
message, so the header bar matches the page.
"""

import json
import os
import sys
import threading
from urllib.parse import quote, urlparse

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("WebKit", "6.0")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk, WebKit  # noqa: E402

from . import __version__, desktop  # noqa: E402
from .cli import register_workspace, read_server  # noqa: E402
from .registry import CACHE_DIR  # noqa: E402

STATE_FILE = os.path.join(CACHE_DIR, "desktop.json")
LOGOS = {"light": os.path.join(desktop.PKG_DIR, "static", "logo.svg"),
         "dark": os.path.join(desktop.PKG_DIR, "static", "logo-dark.svg")}
REPO = "https://github.com/autowarefoundation/colcon-dashboard"

# the page colors behind the header bar (style.css: --page)
CSS = b"""
window.cd-light headerbar { background: #f2f6fb; color: #0a1f3d; box-shadow: inset 0 -1px rgba(10, 31, 61, 0.10); }
window.cd-dark headerbar { background: #06101e; color: #e8f1fb; box-shadow: inset 0 -1px rgba(214, 232, 252, 0.12); }
window.cd-light statuspage { background: #f2f6fb; }
window.cd-dark statuspage { background: #06101e; }
window.cd-light button.suggested-action { background: #1e7fd9; }
window.cd-dark button.suggested-action { background: #3a95ea; }
.cd-pill { padding: 2px 10px; border-radius: 999px; font-size: 0.85em; font-weight: 600; }
.cd-pill.running { color: #06b025; }
.cd-pill.starting { color: #f0a30a; }
.cd-pill.stopped { color: #d3402b; }
"""


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except OSError:
        pass


def in_background(work, done):
    """Run work() on a thread, then done(result) on the GTK thread."""
    def target():
        result = work()
        GLib.idle_add(lambda: done(result) and False)
    threading.Thread(target=target, daemon=True).start()


def open_external(uri):
    try:
        Gio.AppInfo.launch_default_for_uri(uri, None)
    except GLib.Error:
        pass


def logo_paintable(theme="light"):
    try:
        return Gdk.Texture.new_from_filename(LOGOS[theme])
    except (GLib.Error, AttributeError):  # no SVG loader, or GTK < 4.6
        return None


class Window(Adw.ApplicationWindow):
    def __init__(self, app, state):
        super().__init__(application=app, title="Colcon Dashboard")
        self.state = state
        self.base = None          # the server URL, once it answers
        self.status = None        # the last desktop.server_status()
        self.busy = False         # a start, stop, or restart runs
        self.want = None          # the page to open once the server answers
        self.set_default_size(state.get("w", 1400), state.get("h", 900))
        if state.get("max"):
            self.maximize()
        self.set_theme(state.get("theme", "light"))

        self.title = Adw.WindowTitle(title="Colcon Dashboard", subtitle="")
        header = Adw.HeaderBar()
        header.set_title_widget(self.title)
        self.pill = Gtk.Label(label="")
        self.pill.add_css_class("cd-pill")
        header.pack_start(self.pill)
        menu = Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=self.build_menu(),
                              tooltip_text="Menu")
        header.pack_end(menu)
        reload = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Reload (Ctrl+R)",
                            action_name="win.reload")
        header.pack_end(reload)

        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        self.web = self.build_web()
        self.stack.add_named(self.web, "web")
        self.stack.add_named(self.build_waiting(), "starting")
        self.stack.add_named(self.build_down(), "down")
        self.toasts = Adw.ToastOverlay(child=self.stack)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.append(header)
        self.toasts.set_vexpand(True)
        box.append(self.toasts)
        self.set_content(box)
        self.stack.set_visible_child_name("starting")

        self.add_actions()
        self.connect("close-request", self.on_close)
        GLib.timeout_add_seconds(2, self.poll)
        self.poll(first=True)

    # -- building ---------------------------------------------------------

    def build_menu(self):
        menu = Gio.Menu()
        page = Gio.Menu()
        page.append("Reload", "win.reload")
        page.append("Open in Browser", "win.open-browser")
        page.append("Fullscreen", "win.fullscreen")
        menu.append_section(None, page)
        server = Gio.Menu()
        server.append("Restart the Server", "win.restart")
        server.append("Stop the Server", "win.stop")
        server.append("Start the Server at Login", "win.start-at-login")
        menu.append_section("Server", server)
        about = Gio.Menu()
        about.append("Add to the Applications Menu", "win.install-desktop")
        about.append("Keyboard Shortcuts", "win.shortcuts")
        about.append("About Colcon Dashboard", "win.about")
        menu.append_section(None, about)
        return menu

    def build_web(self):
        data = os.path.join(desktop.data_home(), "colcon-dashboard", "webview")
        cache = os.path.join(CACHE_DIR, "webview")
        session = WebKit.NetworkSession.new(data, cache)
        content = WebKit.UserContentManager()
        # the page hides its own logo and name: the header bar shows them
        content.add_script(WebKit.UserScript.new(
            "document.documentElement.classList.add('in-app');",
            WebKit.UserContentInjectedFrames.TOP_FRAME,
            WebKit.UserScriptInjectionTime.START, None, None))
        content.register_script_message_handler("colconTheme", None)
        content.connect("script-message-received::colconTheme", self.on_page_theme)
        web = WebKit.WebView(network_session=session, user_content_manager=content)
        # notifications stay allowed across launches, not only after a prompt
        web.get_context().connect("initialize-notification-permissions", self.on_init_permissions)
        web.set_vexpand(True)
        settings = web.get_settings()
        settings.set_enable_developer_extras(True)
        settings.set_enable_back_forward_navigation_gestures(False)
        web.connect("decide-policy", self.on_policy)
        web.connect("create", self.on_create)
        web.connect("permission-request", self.on_permission)
        web.connect("show-notification", self.on_notification)
        web.connect("notify::title", self.on_title)
        web.connect("load-failed", self.on_load_failed)
        return web

    def status_page(self, title, description):
        page = Adw.StatusPage(title=title, description=description)
        self.paint_logo(page)
        return page

    def paint_logo(self, page):
        logo = logo_paintable(self.state.get("theme", "light"))
        if logo is not None and hasattr(page, "set_paintable"):
            page.set_paintable(logo)
        else:
            page.set_icon_name("applications-engineering-symbolic")

    def build_waiting(self):
        self.waiting = self.status_page("Starting the dashboard server", "")
        spinner = Gtk.Spinner(spinning=True, width_request=32, height_request=32)
        self.waiting.set_child(spinner)
        return self.waiting

    def build_down(self):
        self.down = self.status_page(
            "The dashboard server is not running",
            "The server reads the colcon logs of every workspace on this machine.")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18, halign=Gtk.Align.CENTER)
        start = Gtk.Button(label="Start the Server", action_name="win.start")
        start.add_css_class("suggested-action")
        start.add_css_class("pill")
        box.append(start)
        row = Gtk.Box(spacing=12, halign=Gtk.Align.CENTER)
        row.append(Gtk.Label(label="Start the server at login"))
        self.login_switch = Gtk.Switch(valign=Gtk.Align.CENTER)
        self.switch_handler = self.login_switch.connect("state-set", self.on_login_switch)
        row.append(self.login_switch)
        box.append(row)
        self.down.set_child(box)
        return self.down

    def add_actions(self):
        for name, handler in (("reload", self.act_reload), ("open-browser", self.act_browser),
                              ("fullscreen", self.act_fullscreen), ("start", self.act_start),
                              ("restart", self.act_restart), ("stop", self.act_stop),
                              ("install-desktop", self.act_install_desktop),
                              ("shortcuts", self.act_shortcuts), ("about", self.act_about),
                              ("zoom-in", lambda *a: self.zoom(1.1)),
                              ("zoom-out", lambda *a: self.zoom(1 / 1.1)),
                              ("zoom-reset", lambda *a: self.zoom(None)),
                              ("inspector", lambda *a: self.web.get_inspector().show())):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", handler)
            self.add_action(action)
        self.login_action = Gio.SimpleAction.new_stateful(
            "start-at-login", None, GLib.Variant.new_boolean(desktop.service_installed()))
        self.login_action.connect("activate", lambda a, _p: self.set_login(not a.get_state().get_boolean()))
        self.add_action(self.login_action)
        self.lookup_action("install-desktop").set_enabled(not desktop.desktop_installed())

    # -- the server -------------------------------------------------------

    def poll(self, first=False):
        if not self.busy:
            in_background(desktop.server_status, lambda st: self.on_status(st, first))
        return True

    def on_status(self, st, first=False):
        self.status = st
        if self.busy:
            return
        self.show_pill(st)
        self.login_action.set_state(GLib.Variant.new_boolean(st["service"]))
        self.login_switch.set_sensitive(st["systemd"])
        if self.login_switch.get_active() != st["service"]:
            self.login_switch.handler_block(self.switch_handler)
            self.login_switch.set_active(st["service"])
            self.login_switch.set_state(st["service"])
            self.login_switch.handler_unblock(self.switch_handler)
        if st["alive"]:
            url = st["url"]
            if url != self.base or self.stack.get_visible_child_name() != "web":
                self.base = url
                self.open_page()
        elif first:
            self.start()  # opening the app means: show me the dashboard
        elif self.stack.get_visible_child_name() != "down":
            self.stack.set_visible_child_name("down")

    def show_pill(self, st):
        for cls in ("running", "starting", "stopped"):
            self.pill.remove_css_class(cls)
        if self.busy:
            self.pill.set_label("● working")
            self.pill.add_css_class("starting")
        elif st and st["alive"]:
            self.pill.set_label("● running")
            self.pill.add_css_class("running")
            who = ("the systemd user service" if st["service"]
                   else "a background process")
            self.pill.set_tooltip_text(f"The server answers at {st['url']}, run by {who}"
                                       f" (pid {st['pid']}).")
        else:
            self.pill.set_label("● stopped")
            self.pill.add_css_class("stopped")
            self.pill.set_tooltip_text("No dashboard server answers.")

    def server_job(self, work, waiting_title, done_msg):
        """Run a server command; the window waits, then follows the result."""
        if self.busy:
            return
        self.busy = True
        self.show_pill(self.status)
        self.waiting.set_title(waiting_title)
        self.stack.set_visible_child_name("starting")

        def done(result):
            ok, msg = result
            self.busy = False
            if not ok:
                self.toast(f"{msg or 'The command failed.'}")
            elif done_msg:
                self.toast(done_msg)
            self.base = None  # reload the page once the server answers
            self.poll()
        in_background(work, done)

    def start(self):
        self.server_job(desktop.start_server, "Starting the dashboard server", None)

    def set_login(self, on):
        if self.busy or (self.status and on == self.status["service"]):
            return
        if on:
            self.server_job(lambda: desktop.set_start_at_login(True),
                            "Installing the login service",
                            "The server now starts at login.")
        else:
            self.server_job(lambda: desktop.set_start_at_login(False),
                            "Removing the login service",
                            "The server no longer starts at login. It stopped.")

    # -- the page ---------------------------------------------------------

    def open_workspace(self, workspace):
        """Open a workspace (an absolute path), now or once the server answers."""
        self.want = workspace
        if self.base:
            self.open_page()

    def open_page(self):
        uri = self.base
        if self.want:
            ws = self.want
            self.want = None
            info = read_server()
            threading.Thread(target=register_workspace, args=(info, ws), daemon=True).start()
            uri = f"{self.base}?ws={quote(ws, safe='')}"
        elif self.same_origin(self.state.get("uri") or ""):
            uri = self.state["uri"]  # where the last session left off
        self.web.load_uri(uri)
        self.stack.set_visible_child_name("web")

    def same_origin(self, uri):
        if not self.base:
            return False
        a, b = urlparse(uri), urlparse(self.base)
        return a.scheme == b.scheme and a.netloc == b.netloc

    def on_policy(self, web, decision, kind):
        if kind not in (WebKit.PolicyDecisionType.NAVIGATION_ACTION,
                        WebKit.PolicyDecisionType.NEW_WINDOW_ACTION):
            return False
        uri = decision.get_navigation_action().get_request().get_uri()
        if self.same_origin(uri) or uri.startswith("about:"):
            return False
        decision.ignore()  # docs, GitHub, editor links: the system opens them
        open_external(uri)
        return True

    def on_create(self, web, action):
        uri = action.get_request().get_uri()
        if self.same_origin(uri):
            web.load_uri(uri)
        else:
            open_external(uri)
        return None

    def on_permission(self, web, request):
        if isinstance(request, WebKit.NotificationPermissionRequest):
            request.allow()
            return True
        return False

    def on_init_permissions(self, context):
        info = read_server() or {}
        port = info.get("port", 8642)
        origins = [WebKit.SecurityOrigin.new_for_uri(f"http://{host}:{port}/")
                   for host in ("127.0.0.1", "localhost")]
        context.initialize_notification_permissions(origins, [])

    def on_notification(self, web, notification):
        note = Gio.Notification.new(notification.get_title())
        note.set_body(notification.get_body())
        self.get_application().send_notification("build", note)
        return True

    def on_title(self, web, _pspec):
        title = web.get_title() or ""
        self.title.set_subtitle("" if title == "Colcon Dashboard" else title)
        self.set_title(title or "Colcon Dashboard")

    def on_load_failed(self, web, _event, uri, error):
        self.poll()  # the server went away: the poll shows the right page
        return False

    def on_page_theme(self, _content, value):
        self.set_theme(value.to_string())

    def set_theme(self, mode):
        dark = mode == "dark"
        self.state["theme"] = "dark" if dark else "light"
        Adw.StyleManager.get_default().set_color_scheme(
            Adw.ColorScheme.FORCE_DARK if dark else Adw.ColorScheme.FORCE_LIGHT)
        self.remove_css_class("cd-dark" if not dark else "cd-light")
        self.add_css_class("cd-dark" if dark else "cd-light")
        for page in (getattr(self, "waiting", None), getattr(self, "down", None)):
            if page is not None:
                self.paint_logo(page)

    # -- actions ----------------------------------------------------------

    def act_reload(self, *_):
        if self.stack.get_visible_child_name() == "web":
            self.web.reload()
        else:
            self.poll()

    def act_browser(self, *_):
        uri = self.web.get_uri() if self.base else None
        if uri and self.same_origin(uri):
            open_external(uri)
        else:
            self.toast("The server is not running.")

    def act_fullscreen(self, *_):
        if self.is_fullscreen():
            self.unfullscreen()
        else:
            self.fullscreen()

    def act_start(self, *_):
        self.start()

    def act_restart(self, *_):
        self.server_job(desktop.restart_server, "Restarting the dashboard server",
                        "The server restarted.")

    def act_stop(self, *_):
        self.server_job(desktop.stop_server, "Stopping the dashboard server", None)

    def on_login_switch(self, _switch, on):
        self.set_login(on)
        return True  # the poll sets the state once the service changed

    def act_install_desktop(self, *_):
        def work():
            try:
                desktop.install_desktop()
                return True
            except OSError as exc:
                return str(exc)

        def done(result):
            if result is True:
                self.toast("Colcon Dashboard is now in the applications menu.")
                self.lookup_action("install-desktop").set_enabled(False)
            else:
                self.toast(f"Could not add the menu entry: {result}")
        in_background(work, done)

    def act_shortcuts(self, *_):
        if self.stack.get_visible_child_name() == "web":
            self.web.evaluate_javascript(
                "document.getElementById('helpBtn')?.click()", -1, None, None, None, None, None)

    def act_about(self, *_):
        info = dict(application_name="Colcon Dashboard", version=__version__,
                    developer_name="Mete Fatih Cırıt", website=REPO,
                    issue_url=REPO + "/issues", license_type=Gtk.License.APACHE_2_0,
                    comments="Watch colcon builds live: the dependency graph, the timeline,"
                             " and the log of every package.")
        if hasattr(Adw, "AboutWindow"):  # libadwaita 1.2
            win = Adw.AboutWindow(transient_for=self, application_icon=desktop.APP_ID, **info)
        else:
            win = Gtk.AboutDialog(transient_for=self, modal=True, program_name="Colcon Dashboard",
                                  version=__version__, website=REPO,
                                  license_type=Gtk.License.APACHE_2_0,
                                  authors=["Mete Fatih Cırıt"], comments=info["comments"],
                                  logo=logo_paintable(self.state.get("theme", "light")))
        win.present()

    def zoom(self, factor):
        level = 1.0 if factor is None else self.web.get_zoom_level() * factor
        self.web.set_zoom_level(min(3.0, max(0.3, level)))
        self.state["zoom"] = self.web.get_zoom_level()

    def toast(self, text):
        self.toasts.add_toast(Adw.Toast(title=GLib.markup_escape_text(text), timeout=5))

    def on_close(self, *_):
        w, h = self.get_default_size()
        self.state.update(w=w, h=h, max=self.is_maximized())
        uri = self.web.get_uri()
        if uri and self.same_origin(uri):
            self.state["uri"] = uri
        save_state(self.state)
        return False


class App(Adw.Application):
    def __init__(self):
        super().__init__(application_id=desktop.APP_ID,
                         flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.window = None
        GLib.set_application_name("Colcon Dashboard")

    def do_startup(self):
        Adw.Application.do_startup(self)
        css = Gtk.CssProvider()
        if (Gtk.get_major_version(), Gtk.get_minor_version()) >= (4, 9):
            css.load_from_data(CSS.decode(), -1)  # 4.9 changed the signature
        else:
            css.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        # the icon also before the menu entry is installed: data/ holds it
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(
            desktop.DATA_DIR)
        Gtk.Window.set_default_icon_name(desktop.APP_ID)
        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", lambda *a: self.window.close() if self.window else self.quit())
        self.add_action(quit_action)
        for action, keys in (("app.quit", ["<Ctrl>q"]), ("win.reload", ["<Ctrl>r", "F5"]),
                             ("win.fullscreen", ["F11"]),
                             ("win.zoom-in", ["<Ctrl>plus", "<Ctrl>equal"]),
                             ("win.zoom-out", ["<Ctrl>minus"]), ("win.zoom-reset", ["<Ctrl>0"]),
                             ("win.inspector", ["<Ctrl><Shift>i", "F12"])):
            self.set_accels_for_action(action, keys)

    def do_command_line(self, command_line):
        args = command_line.get_arguments()[1:]
        if self.window is None:
            state = load_state()
            self.window = Window(self, state)
            if state.get("zoom"):
                self.window.web.set_zoom_level(state["zoom"])
        if args:
            self.window.open_workspace(os.path.abspath(
                os.path.join(command_line.get_cwd() or os.getcwd(), args[0])))
        self.window.present()
        return 0

    def do_activate(self):  # a click on a notification
        if self.window:
            self.window.present()


def run(workspace=None):
    argv = [sys.argv[0]] + ([workspace] if workspace else [])
    return App().run(argv)


if __name__ == "__main__":
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else None))
