---
icon: lucide/panel-top
description: >-
  A tour of the Colcon Dashboard page: the header, the workspace and build
  pickers, the system pressure strip, and the progress strip.
---

# The dashboard

<!-- TODO(images): full-page screenshot with header, graph, timeline, and dock visible. -->

## Header

The header shows the workspace path, the build id, a LIVE / COMPLETE / FAILED / STOPPED badge, and the parallel worker count. The workspace path opens the workspace picker. The build id opens the build picker. The bell button turns on desktop notifications: the build finished, the build failed, or the first package failed. A second click adds a quiet chime. The ? button (or the ++question++ key) opens the keyboard and mouse reference. The power button stops the server, after a confirmation. When the server stops answering, the whole top panel turns red.

The browser tab mirrors the build even in the background. The title shows `[42%] workspace` while the build runs, and then ✓ or ✗. The favicon changes color with it.

## Workspace picker

The workspace picker lists your recent workspaces with their build count, log size, and last build time. It shows live progress for workspaces that build now. The list sorts by the last build time. A workspace that builds now has the newest build, so it sits on top. A star pins a favorite, and a sort menu reorders the list by favorites, build count, or log size. The picker also opens any path and scans your home directory for colcon workspaces.

If `check_updates = true` is set in the [config file](../configuration.md), a dismissible line appears here when PyPI has a newer release. The server makes no other network request, ever.

## Build picker

The build picker lists every build and `colcon test` run of the workspace, with its log size and its outcome. The outcome is a passed, failed, or aborted chip, with the done, failed, aborted, and skipped package counts. Each finished run also shows its total duration, and the delta against the previous run of the same kind. A slower run shows `+3:12` in red. A faster run shows `−1:04` in green.

Open a run and the whole dashboard shows it, with the `build` query parameter in the address. The 🗑 buttons delete the logs of one run. A prune action keeps the last three runs of each kind (build and test). The server refuses to delete a run that still writes its logs. The `auto_prune_keep` key does the same pruning automatically each time the server sees a finished build, for every workspace that it watches.

## System strip

The right side is the system strip. A colcon build can exhaust the machine, so pressure stays visible at all times:

- A per-core heatmap, one cell per core. Cell color runs from the idle gray to full blue at 100% use. Hover a cell for the exact number.
- CPU, RAM, and swap meters. A fill turns amber under pressure (CPU 85%, RAM 75%, swap 30%) and red near the limit (96%, 90%, 70%). At red the label also turns red and bold.
- Hover the CPU meter for the load average. Hover the RAM meter for the exact percentage.
- In a narrow window the strip folds behind a chart button and drops down on demand.

## Progress strip

The meter fills as the build advances: green for done, animated blue stripes for building, red for failed, orange for aborted.

The tiles count each state: done out of the total, building, ready, waiting (plus a blocked count after a failure), failed, aborted, and skipped. Elapsed time, the rate in packages per minute, and an ETA sit at the end. The ETA is an estimate: the longest remaining dependency chain, or the remaining work spread over the workers, whichever is larger. The duration of each package comes from the previous build.

## Theme

The page follows the system theme. The theme button cycles system, light, and dark. Every view recolors instantly, including the 3D canvas.
