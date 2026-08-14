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

    To upgrade to the newest release:

    ```bash
    pipx upgrade colcon-dashboard
    ```

=== "pip"

    Plain pip works in any Python 3.8+ environment:

    ```bash
    pip install colcon-dashboard
    colcon-dashboard --install-service
    ```

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

After an upgrade, run `colcon-dashboard --restart-service`. The running server stays on the old version until a restart.

Without the service, `colcon-dashboard` starts the server by hand.

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
