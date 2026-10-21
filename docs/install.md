---
icon: lucide/download
description: >-
  Install Colcon Dashboard with pipx, the Ubuntu PPA, or pip. One command
  installs the systemd user service that keeps the dashboard running.
---

# Install

The server needs Python 3.8 or newer and nothing else. It has zero dependencies.

=== "Ubuntu PPA"

    On Ubuntu, install the apt package:

    ```bash
    sudo add-apt-repository ppa:xmfcx/colcon-dashboard
    sudo apt install python3-colcon-dashboard
    colcon-dashboard --install-service
    ```

    The package upgrades with the usual system updates (`sudo apt upgrade`).

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

The service starts the server at login and restarts it on failure. Open <http://127.0.0.1:8642/> and pick your workspace. That is the whole setup.

To use the dashboard in its own window instead of a browser, install the [desktop app](desktop-app.md).

After an upgrade, run `colcon-dashboard --restart-service`. The running server stays on the old version until a restart.

Without the service, `colcon-dashboard` starts the server in the terminal. It runs in the foreground until you press Ctrl+C.

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

1. Remove the service first. If you remove the package first, the service file stays and fails at every login. For a pipx or pip install, also remove the applications menu entry.

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
