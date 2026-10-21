---
icon: lucide/server
description: >-
  Watch a build on another machine: an SSH tunnel, VS Code Remote-SSH, a
  service that keeps running after you log out, and editor links over SSH.
---

# Remote machine

The dashboard runs on the machine that builds. You can open its page from another machine.

## Use an SSH tunnel

An SSH tunnel is the safe way. The server keeps its default bind address, `127.0.0.1`, so nobody else on the network reaches it.

1. On your own machine, open the tunnel:

    ```bash
    ssh -L 8642:127.0.0.1:8642 build-machine
    ```

2. Open <http://127.0.0.1:8642/> in your browser.

The page then counts as `localhost` for your browser, so desktop notifications work too. Browsers allow notifications only on `localhost` and on `https` addresses.

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
