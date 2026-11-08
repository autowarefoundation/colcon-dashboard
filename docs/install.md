---
icon: lucide/download
description: >-
  Install Colcon Dashboard from the Ubuntu PPA, with pipx, or with pip. A
  systemd user service keeps the dashboard running from every login.
---

# Install

The dashboard is one small Python program. It needs Python 3.8 or newer and nothing else. It works with every ROS 2 distribution and with any other workspace that colcon builds.

Pick one way to install it. The Ubuntu PPA is the easiest on Ubuntu, and pipx works on every Linux distribution.

=== "Ubuntu PPA"

    On Ubuntu, install the apt package:

    ```bash
    sudo add-apt-repository ppa:xmfcx/colcon-dashboard
    sudo apt install python3-colcon-dashboard
    colcon-dashboard --start-service
    ```

    The package enables the systemd user service for every user, so the server starts at each login. The last command starts it now. The package upgrades with the usual system updates (`sudo apt upgrade`).

=== "pipx"

    On any distribution, pipx does the same job:

    ```bash
    pipx install colcon-dashboard
    colcon-dashboard --install-service
    ```

    If pipx is not installed, install it first. On Ubuntu:

    ```bash
    sudo apt install pipx
    pipx ensurepath
    ```

    Then open a new terminal, so that `~/.local/bin` is on your `PATH`.

    To upgrade to the newest release:

    ```bash
    pipx upgrade colcon-dashboard
    ```

=== "pip"

    Plain pip works in a virtual environment with Python 3.8 or newer:

    ```bash
    python3 -m venv ~/.venvs/colcon-dashboard
    ~/.venvs/colcon-dashboard/bin/pip install colcon-dashboard
    ~/.venvs/colcon-dashboard/bin/colcon-dashboard --install-service
    ```

    On Ubuntu 23.04 and newer (ROS 2 Jazzy and later), the system pip refuses `pip install` outside a virtual environment, with the error `externally-managed-environment`. Use the PPA or pipx there.

    The service runs the Python of the environment that installed it. If you move or delete that environment, run `--install-service` again from the new one.

    To upgrade to the newest release:

    ```bash
    pip install --upgrade colcon-dashboard
    ```

=== "From a checkout"

    Replace the package name with the path to the repository:

    ```bash
    git clone https://github.com/autowarefoundation/colcon-dashboard
    pipx install ./colcon-dashboard
    colcon-dashboard --install-service
    ```

    To upgrade, pull and reinstall:

    ```bash
    git -C colcon-dashboard pull
    pipx install --force ./colcon-dashboard
    ```

The service starts the server at login and restarts it on failure.

## Make sure that it works

Open <http://localhost:8642/>. The page shows the workspace picker. Pick your workspace, and continue with the [quick start](quick-start.md).

To use the dashboard in its own window, [install it as an app](desktop-app.md) from the browser.

After an upgrade, run `colcon-dashboard --restart-service`. The running server keeps the old version until it restarts.

Without the service, `colcon-dashboard` starts the server in the terminal. It runs in the foreground until you press ++ctrl+c++.

## Service commands

The CLI manages the systemd user service:

```bash
colcon-dashboard --install-service      # install and start
colcon-dashboard --uninstall-service    # stop, disable, and remove
colcon-dashboard --start-service
colcon-dashboard --stop-service
colcon-dashboard --restart-service      # e.g. after a config.ini change
colcon-dashboard --service-status
```

`--install-service` needs systemd user services. Most containers, and WSL without systemd, do not have them. There, run the server in a terminal, or in the background with `nohup colcon-dashboard >/dev/null 2>&1 &`.

## Uninstall

1. For a pipx or pip install, remove the service first. If you remove the package first, the service file stays and fails at every login. Also remove the applications menu entry. The apt package removes its own service.

    ```bash
    colcon-dashboard --uninstall-service
    colcon-dashboard --uninstall-desktop   # pipx or pip
    ```

2. Remove the package:

    ```bash
    sudo apt remove python3-colcon-dashboard   # PPA
    pipx uninstall colcon-dashboard            # pipx
    ```

3. To remove your settings and the list of recent workspaces too, delete these directories:

    ```bash
    rm -r ~/.config/colcon-dashboard ~/.cache/colcon-dashboard ~/.local/share/colcon-dashboard
    ```

The dashboard never changes your sources or your build results. Into the build log directories it writes only a small `.colcon-dashboard.json` file per run, and `claude-analysis.json` files for the AI failure analyses that you start. These files go away with the logs.
