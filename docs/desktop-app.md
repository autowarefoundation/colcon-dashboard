---
icon: lucide/app-window
description: >-
  Install the dashboard as an app with its own window, open it from the
  applications menu, and watch the server from the tray icon.
---

# Desktop app

The dashboard is a web page, and your browser can install it as an app. The app has its own window, a menu entry, and a dock icon, and it runs at full browser speed. The server keeps running in the background as a systemd user service, so the app opens at once.

## Install the dashboard as an app

Chrome, Chromium, Edge, and Brave can install the dashboard:

1. Open <http://localhost:8642/>.
2. Click the install icon at the right end of the address bar. You can also open the browser menu and choose **Cast, save, and share** > **Install page as app**.
3. Click **Install**.

The browser adds Colcon Dashboard to the applications menu. If the app already shows a window, a second launch brings that window to the front.

Use the address `localhost:8642` for the install. The browser ties the app and its saved page settings to one exact address, and `127.0.0.1:8642` counts as a different one. Browsers also install apps only from `localhost` or from `https` addresses. To install the app for a dashboard on another machine, open it through an [SSH tunnel](remote.md#use-an-ssh-tunnel).

## Firefox and other browsers

The page works fully in a Firefox tab. Only the separate app window depends on the Firefox version and the install type:

- Firefox 150 and newer on Linux have web apps (Taskbar Tabs) behind the `browser.taskbarTabs.enabled` setting in `about:config`.
- The Snap and Flatpak builds of Firefox do not have Taskbar Tabs yet. Ubuntu installs the Snap build by default.
- The third-party PWAsForFirefox extension installs the dashboard as an app on Linux today.

## The applications menu entry

The apt package adds Colcon Dashboard to the applications menu. For a pipx or pip install, add it yourself:

```bash
colcon-dashboard --install-desktop
```

The entry runs `colcon-dashboard --app`. You can also run it in a terminal, with an optional workspace:

```bash
colcon-dashboard --app ~/autoware
```

The command starts the server if none runs. Then it opens the dashboard in the default browser of your desktop:

- Chrome, Chromium, Edge, or Brave: the installed app, else an app window without tabs.
- Firefox: a new window.
- Any other browser: a new tab.

To choose the browser yourself, set `browser` in the [configuration file](configuration.md#browser).

If you installed the app in Chrome, the applications menu shows two Colcon Dashboard entries. Both open the same app.

## The tray icon

The tray icon is optional. To turn it on, open the settings (the gear button) and select **show the tray icon**. The icon then also starts at every login.

- Click the icon to open the dashboard.
- Right-click the icon for the menu: the server state, the builds of the open workspaces, and start, restart, or stop the server.
- **Quit the Tray Icon** closes only the icon. The server keeps running.

The icon turns gray when the server stops. Hover over it to see the build progress.

The tray icon needs PyGObject. The apt package recommends it. For a pipx install, install it with apt:

```bash
sudo apt install python3-gi gir1.2-gdkpixbuf-2.0
```

The tray also needs a tray host. KDE, waybar, and swaybar have one. On Ubuntu, the AppIndicator extension (on by default) is the host. A plain GNOME desktop (for example on Fedora) needs the AppIndicator extension.

## The server

The settings panel (the gear button) controls the server:

- **start the server when you log in** turns the systemd user service on or off.
- **Restart the server** restarts it, for example after a change to `config.ini`.
- **Stop the server…** stops it until the next login.

When the server does not answer, the page shows how to start it again, and it opens the dashboard by itself when the server answers.

## Desktop notifications

If the page runs on the same machine as the server, the server shows the build notifications on your desktop. They arrive also when no dashboard is open. A click on a notification opens the dashboard. The bell button and the settings choose them, as before.

On another machine, through an SSH tunnel, the browser shows the notifications while a dashboard page is open.

## Upgrade from the WebKit window

Version 0.10 and older had a separate window that used WebKitGTK. That window is gone, and the browser app replaces it. For a pipx or pip install, run these commands once after the upgrade:

```bash
colcon-dashboard --install-desktop     # the entry now opens the browser
colcon-dashboard --restart-service
```

To free the disk space of the old window, delete its data directory:

```bash
rm -r ~/.local/share/colcon-dashboard
```
