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
$ colcon-dashboard .
http://127.0.0.1:8642/?ws=%2Fhome%2Fuser%2Fws
```

The dashboard needs nothing from colcon. It reads the log files that colcon already writes. Any build shows up, from any terminal, with any options.

One server runs per machine, on port 8642, and serves every workspace. The `ws` query parameter picks the workspace, so each browser tab can show a different one. A file lock refuses duplicate servers. The server keeps running after the build, so the pages stay available for the next build and for post-mortems.

To open the workspace picker, click the workspace path in the header. The picker shows your recent workspaces, a path box, and a scan of your home directory.

## The command line

```bash
colcon-dashboard                              # start the server, or print its URL
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

The server follows `log/latest_build`. If a new build starts in the same workspace, the page switches to it and shows a notice. `colcon test` runs appear in the build picker too, with their own pass/fail counts.
