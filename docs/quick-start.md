---
icon: lucide/rocket
description: >-
  Build with colcon as you always do, open the page of your workspace, and
  watch the build live. The dashboard reads the logs colcon already writes.
---

# Quick start

Build as you always do, and open the page of your workspace:

```text
$ colcon build
$ colcon-dashboard . --open
already running: http://localhost:8642/?ws=%2Fhome%2Fuser%2Fws
```

This is the output when the [service](install.md#service-commands) runs the server. `--open` opens the page in your browser. Without it, open the printed address yourself.

If no server runs, the same command starts one in the terminal. It prints its address and runs in the foreground until you press Ctrl+C:

```text
$ colcon-dashboard .
Colcon Dashboard
  url: http://localhost:8642/
  workspace: http://localhost:8642/?ws=%2Fhome%2Fuser%2Fws
  stop: Ctrl+C, or colcon-dashboard --stop
```

The dashboard needs nothing from colcon. It reads the log files that colcon already writes. Any build appears, from any terminal, with any options.

One server runs per machine, on port 8642, and serves every workspace. If another program uses port 8642, the server takes a free port and prints it. To find the address of a running server, run `colcon-dashboard --list`. The `ws` query parameter picks the workspace, so each browser tab can show a different one. A file lock refuses duplicate servers. The server keeps running after the build, so the pages stay available for the next build and for post-mortems.

To open the workspace picker, click the Workspace switcher at the left of the header. The picker shows your starred and recent workspaces, and the workspaces that it finds in your home directory. Type in the box at the top to filter the list, or paste a path and press Enter. To search other directories too, click "Scan roots…" in the picker, or edit the scan roots in the settings.

## The command line

```bash
colcon-dashboard                              # start the server in the foreground, or print its URL
colcon-dashboard . --open                     # open this workspace in the browser
colcon-dashboard ~/projects/autoware          # same, and open this workspace
colcon-dashboard --status                     # print the build status in the terminal
colcon-dashboard --list                       # the known workspaces and their URLs
colcon-dashboard --prune --keep 5             # keep 5 builds and 5 test runs
colcon-dashboard --stop                       # stop the server
colcon-dashboard --install-service            # install the systemd user service
colcon-dashboard --restart-service            # e.g. after a config.ini change
```

The [command line reference](reference/cli.md) lists every flag.

## Builds and test runs

The server follows the newer of `log/latest_build` and `log/latest_test`. If a new build or test run starts in the same workspace, the page switches to it and shows a notice. For a test run, the page also shows the test results of each package, from the JUnit files that `colcon test` writes. Every run also appears in the build picker, with its own counts.

## Open the dashboard with every build

Add this function to your `~/.bashrc`. Then `cb` builds and opens the dashboard of the workspace in one step:

```bash
cb() { colcon-dashboard . --open && colcon build "$@"; }
```

This needs the [service](install.md#service-commands). With the service running, `colcon-dashboard` returns at once, so the build starts right away. Without it, `colcon-dashboard` stays in the foreground, and the build does not start. Pass colcon's options as usual, for example `cb --packages-up-to my_package`. To see the build status in a second terminal or over SSH, run `colcon-dashboard --status`.
