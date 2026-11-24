---
icon: lucide/server
description: >-
  Watch a build on another machine directly over SSH, or reach a dashboard
  that runs there through an SSH tunnel.
---

# Remote machine

Colcon Dashboard can read a remote workspace over SSH without an installation
on the remote machine. It can also run on the build machine and serve its page
through an SSH tunnel.

## Read a workspace over SSH

Pass an SSH workspace URI on the machine where the dashboard is installed:

```bash
colcon-dashboard ssh://build-machine/home/me/ros2_ws --open
```

The same URI works in the workspace picker. Add the SSH user or port when they
are not in `~/.ssh/config`:

```bash
colcon-dashboard ssh://me@build-machine:2222/home/me/ros2_ws --open
```

For a workspace that exists only inside a Docker container on the remote
machine, put the container name before its absolute workspace path:

```bash
colcon-dashboard docker+ssh://build-machine/ros2/home/q/ros2ws --open
```

The local dashboard starts a temporary Python agent through `ssh`, reads build
events and logs by offset, and stops the agent with the SSH connection. It does
not install or write anything on the remote machine.

Requirements:

- `ssh build-machine` must work non-interactively through keys or an SSH agent,
  and the host key must already be trusted. The background service never asks
  for a password or host-key confirmation.
- The remote host, or the selected container, needs Python 3.8 or newer.
- A container target requires permission to run `docker exec` on the remote
  host.

Remote workspaces are read-only. The dashboard shows live state, package logs,
the graph, test results, history, and the remote machine's system meters. Log
deletion, automatic pruning, AI analysis, and editor links are unavailable.
Remote workspaces must be opened by their explicit URI; the picker does not
scan remote hosts.

## Use an SSH tunnel

Use this mode when Colcon Dashboard is installed on the build machine.

An SSH tunnel is the safe way. The server keeps its default bind address, `127.0.0.1`, so nobody else on the network reaches it.

1. On your own machine, open the tunnel:

    ```bash
    ssh -L 8642:127.0.0.1:8642 build-machine
    ```

2. Open <http://localhost:8642/> in your browser.

The page then counts as `localhost` for your browser, so desktop notifications work too, and you can [install the dashboard as an app](desktop-app.md). Browsers allow both only on `localhost` and on `https` addresses. The server compresses its larger answers with gzip, so a slow link carries about a tenth of the data, also the logs.

!!! warning "Use `host = 0.0.0.0` only on a network that you trust"

    The setting `host = 0.0.0.0` in `config.ini` makes the page reachable from your whole network, without a tunnel. The server trusts every caller: anyone on the network can read your logs and delete them. Desktop notifications also stop working, because the address is not `localhost`.

## VS Code Remote-SSH

VS Code forwards the port for you. Run `colcon-dashboard .` in the remote terminal of VS Code. VS Code sees the address in the output and offers to open it. You can also add port 8642 in the Ports panel.

## Keep the service running after you log out

A systemd user service stops when you log out of the machine, and it starts only when you log in. To keep it running, and to start it at boot, turn on lingering for your user once:

```bash
loginctl enable-linger $USER
```

This command also keeps your other user services running.

## Editor links over SSH

The [editor links](configuration.md#editor-links) open files on the machine that runs your editor. With VS Code Remote-SSH, link to the remote machine. Replace `build-machine` with the SSH host name that VS Code uses:

```ini
[ui]
editor_url = vscode://vscode-remote/ssh-remote+build-machine{path}:{line}
```
