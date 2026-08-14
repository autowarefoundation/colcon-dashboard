---
icon: lucide/settings
description: >-
  Configure the Colcon Dashboard server with config.ini: port, bind address,
  update checks, automatic pruning, and editor links for file:line log lines.
---

# Configuration

The server reads `~/.config/colcon-dashboard/config.ini` at startup. The file is optional, and a command line flag always wins over it. This is how service users set the port or the bind address, because the systemd unit passes no flags.

If the file does not exist, the server writes a template with every key commented out. The `--install-service` command does the same. Open the template and uncomment the keys that you need. After a change, run `colcon-dashboard --restart-service`.

```ini
[server]
host = 127.0.0.1        ; use 0.0.0.0 to reach the page from another machine
port = 8642
log_base = log
check_updates = false   ; true: ask PyPI once a day for a newer release

[builds]
auto_prune_keep = -1    ; N >= 1: keep the newest N builds and N test
                        ; runs after each build the server watches
                        ; -1 (the default): never delete anything

[ai]
claude_bin =            ; explicit path to the claude CLI

[ui]
editor_url =            ; e.g. vscode://file{path}:{line} - file:line log
                        ; lines get a link that opens your editor.
```

## Editor links

If you set `editor_url`, each `file:line` position in the logs gets a ↗ link. The link opens your editor at that line. For VS Code:

```ini
[ui]
editor_url = vscode://file{path}:{line}
```

JetBrains IDEs need the project name (`{project}`, the workspace directory name) and count lines from zero (`{line0}`, `{line}` minus one):

```ini
[ui]
editor_url = jetbrains://clion/navigate/reference?project={project}&path={path}:{line0}
```

## Network exposure

When the server binds `0.0.0.0`, it prints the real LAN URL next to the loopback one.

!!! warning "The server trusts every caller"

    Expose the port only to a network that you trust. The server serves logs,
    and it deletes them on request, for every caller.
