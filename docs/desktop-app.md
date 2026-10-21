---
icon: lucide/app-window
description: >-
  Open Colcon Dashboard from the applications menu, in its own window. The
  app starts the server when none runs, and it controls the server.
---

# Desktop app

The desktop app shows the dashboard in its own window, with an entry in the applications menu. You do not have to open a browser or remember the port.

When you open the app and no server runs, the app starts one. The header bar shows the server state, and its menu restarts or stops the server. The menu also turns on the systemd user service, which starts the server at login.

## Install

The app uses GTK 4, libadwaita, and WebKitGTK 6.0. Ubuntu 22.04 and newer have them.

=== "Ubuntu PPA"

    The apt package recommends the app libraries, so `apt` installs them with the package. The package also adds Colcon Dashboard to the applications menu.

    ```bash
    sudo apt install python3-colcon-dashboard
    ```

=== "pipx or pip"

    1. Install the app libraries:

        ```bash
        sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-webkit-6.0
        ```

    2. Add Colcon Dashboard to the applications menu:

        ```bash
        colcon-dashboard --install-desktop
        ```

    The libraries come from apt, and a pipx environment cannot see them. The app then runs under the system Python (`/usr/bin/python3`). The server commands still run under the Python of your install.

## Open the app

Open Colcon Dashboard from the applications menu. From a terminal, open the app on a workspace:

```bash
colcon-dashboard --app ~/autoware
```

If the app already runs, the command opens the workspace in the open window.

## The window

The header bar holds these controls:

- The server state: running, working, or stopped. Hover over it to see the address and what runs the server (the service or a background process).
- The reload button.
- The menu: reload, open the page in the browser, fullscreen, restart or stop the server, start the server at login, add the app to the applications menu, the keyboard shortcuts, and the About window.

The header bar takes the light or dark theme of the page. Desktop notifications from the bell button show as system notifications. Links to the documentation, GitHub, and your editor open in their usual apps.

The app keeps the window size, the zoom level, and the last page that you viewed. It keeps the page settings (theme, notifications, layout) apart from your browser.

| Key | Action |
|---|---|
| ++ctrl+r++ or ++f5++ | Reload the page |
| ++f11++ | Fullscreen |
| ++ctrl+plus++ / ++ctrl+minus++ / ++ctrl+0++ | Zoom in, zoom out, reset the zoom |
| ++ctrl+shift+i++ or ++f12++ | The web inspector |
| ++ctrl+q++ | Close the app |

## The server

If you close the window, the server keeps running. Other browser pages and the CLI still use it.

If the app starts the server and the service is not installed, the server runs as a background process. Its output goes to `~/.cache/colcon-dashboard/server.log`.

When the server stops, the window shows "The dashboard server is not running". Click **Start the Server**, or turn on **Start the server at login** to install the service.

## Remove the app

1. For a pipx or pip install, remove the menu entry:

    ```bash
    colcon-dashboard --uninstall-desktop
    ```

2. To remove the page settings of the app too, delete its data directory:

    ```bash
    rm -r ~/.local/share/colcon-dashboard
    ```
