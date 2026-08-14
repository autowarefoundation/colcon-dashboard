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
| `--port` | `8642` | HTTP port. The default falls back to a free port when taken |
| `--host` | `127.0.0.1` | Bind address. Use `0.0.0.0` to reach the page from another machine |
| `--log-base` | `log` | Log directory, relative to a workspace |
| `--version` | | Print the version |
| `--status` | | Print the build status of the workspace and exit |
| `--list` | | List the known workspaces and their URLs |
| `--prune` | | Delete all but the newest runs of each kind (build, test) |
| `--keep` | `3` | How many runs of each kind `--prune` keeps |
| `--stop` | | Stop the server |
| `--install-service` | | Install and start the systemd user service |
| `--uninstall-service` | | Stop, disable, and remove the service |
| `--start-service` `--stop-service` `--restart-service` | | Control the service |
| `--service-status` | | Show the service and server status |

A command line flag always wins over the [config file](../configuration.md).

!!! warning "The server trusts every caller"

    Expose the port only to a network that you trust. The server serves logs,
    and it deletes them on request, for every caller. When the server binds
    `0.0.0.0`, it prints the real LAN URL next to the loopback one.
