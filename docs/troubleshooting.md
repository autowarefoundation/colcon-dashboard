---
icon: lucide/life-buoy
description: >-
  Fixes for common problems: no build shows, a workspace is missing from the
  picker, the page is offline, notifications or the AI analysis do not work.
---

# Troubleshooting

## The page says "No build yet"

The page shows "no colcon build logs found under …/log" when the workspace has no build logs.

- If the workspace was never built, run `colcon build` in it. The page shows the build as soon as colcon writes its first log.
- If colcon writes its logs to another directory (`--log-base`, or the `COLCON_LOG_PATH` variable), the dashboard does not find them. It reads the same log directory in every workspace: `log`, or the `log_base` value in `config.ini`. Set `log_base` to the directory that your builds use, relative to the workspace.

## A workspace is missing from the picker

The picker scans your home directory and the [scan roots](configuration.md#extra-scan-roots). The scan goes four directory levels down. It skips hidden directories and symbolic links.

- Paste the path of the workspace into the box of the picker, and press Enter.
- Or add the parent directory of the workspace as a scan root: click "Scan roots…" in the picker.

## The page says "OFFLINE"

The server does not answer.

- If you use the service, start it with `colcon-dashboard --start-service`.
- Without the service, run `colcon-dashboard` in a terminal.

Then reload the page.

## I cannot find the address of the server

When port 8642 is taken, the server uses another port. To print the address of the running server, run:

```bash
colcon-dashboard --list
```

## The service does not start, or an upgrade does not show

Read the log of the service:

```bash
journalctl --user -u colcon-dashboard
```

The running server keeps its version until a restart. After an upgrade, run `colcon-dashboard --restart-service`. If you installed the dashboard again from another place (apt, pipx, or a virtual environment), run `colcon-dashboard --install-service` again, so that the service runs the new install.

## The bell shows a warning

If the page runs on the same machine as the server, the server shows the notifications through `notify-send` (the `libnotify-bin` package) or `gdbus`. Click **test** next to the notification choice in the settings to send one. If none arrives, make sure that `notify-send test` shows a notification in a terminal.

On another machine, the browser shows the notifications, and it can block them. Hold the mouse over the bell to read the reason.

- Browsers allow notifications only on `localhost` and on `https` addresses. A LAN address such as `http://192.168.1.10:8642/` does not work. Use an [SSH tunnel](remote.md#use-an-ssh-tunnel) and open the page through `localhost`.
- If you denied the permission before, allow notifications for the page in the site settings of your browser.

For notifications without an open page, set a [notification command](configuration.md#build-notifications).

## There is no "ask claude" button

The button shows only when the server finds the `claude` CLI. The server looks in `PATH`, then in `~/.local/bin`. The systemd service has a short `PATH`, so it can miss a `claude` that your shell finds. Set the full path in `config.ini`, and restart the service:

```ini
[ai]
claude_bin = /full/path/to/claude
```

## The server answers "403 unknown Host header"

The server accepts only these addresses: an IP address, `localhost`, and the host name of the machine. This check stops other web sites from reading your logs. If you reach the server through another name, use its IP address, or use an SSH tunnel and `localhost`.
