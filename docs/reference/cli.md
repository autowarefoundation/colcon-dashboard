---
icon: lucide/terminal
description: >-
  Every colcon-dashboard command line flag: server control, build status,
  pruning, and the systemd user service commands.
---

# Command line

| Flag | Default | Meaning |
|---|---|---|
| `workspace` | | Workspace to register and print the page URL for (optional) |
| `--open` | | Open the page in the browser, after the server starts or the workspace registers |
| `--port` | `8642` | HTTP port. The default falls back to a free port when taken, and the server prints that port. A running server keeps its port: the command says so |
| `--host` | `127.0.0.1` | Bind address. Use `0.0.0.0` to reach the page from another machine |
| `--log-base` | `log` | Log directory, relative to a workspace |
| `--version` | | Print the version |
| `--status` | | Print the build status of the workspace and exit |
| `--list` | | List the known workspaces and their URLs |
| `--prune` | | Delete all but the newest runs of each kind (build, test) |
| `--keep` | `3` | How many runs of each kind `--prune` keeps. Works only with `--prune` |
| `--stop` | | Stop the server |
| `--install-service` | | Install and start the systemd user service. It prints the Python that the service runs. It stops with a hint when systemd user services do not work, as in most containers |
| `--uninstall-service` | | Stop, disable, and remove the service |
| `--start-service` `--stop-service` `--restart-service` | | Control the service |
| `--service-status` | | Show the service and server status |
| `--app` | | Open the dashboard in the [installed app](../desktop-app.md), an app window, or a browser window, on the workspace when one is given. It starts the server when none runs |
| `--tray` | | Show the [tray icon](../desktop-app.md#the-tray-icon). It needs PyGObject |
| `--install-desktop` | | Add Colcon Dashboard to the applications menu of this user |
| `--uninstall-desktop` | | Remove it from the applications menu |

A call takes one action at most: `--stop`, `--list`, `--status`, `--prune`, one of the service flags, or one of the desktop flags. `colcon-dashboard --help` groups the flags and shows examples.

A command line flag always wins over the [config file](../configuration.md).

!!! warning "The server trusts every caller"

    Expose the port only to a network that you trust. The server serves logs,
    and it deletes them on request, for every caller. When the server binds
    `0.0.0.0`, it prints the real LAN URL next to the loopback one.
