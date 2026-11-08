---
icon: lucide/rocket
description: >-
  Open the dashboard, pick your workspace, and run colcon build as usual.
  The build shows up live, because the dashboard reads the logs that colcon
  already writes.
---

# Quick start

This page assumes that the dashboard is [installed](install.md) and that its service runs. Your build commands stay the same.

## 1. Open the dashboard

Open <http://localhost:8642/> in your browser. Without a workspace, the page shows the workspace picker as a start page.

![The start page: the workspace picker with the starred, recent, and found workspaces](assets/screens/start-light.webp#only-light)
![The start page, dark theme](assets/screens/start-dark.webp#only-dark)

The picker lists your starred and recent workspaces, and the colcon workspaces that it finds in your home directory. Each row shows the result of the last build.

## 2. Pick your workspace

Click a workspace, or type a part of its name and press ++enter++. To open a workspace that the list does not show, paste its path into the box and press ++enter++.

You can also open the page of a workspace from its directory:

```bash
cd ~/ros2_ws
colcon-dashboard . --open
```

## 3. Build as usual

Run `colcon build` in the workspace, from any terminal, with any options:

```bash
colcon build --symlink-install
```

The page follows the build live. Packages turn blue while they build and green when they are done. The summary line counts the packages and estimates the time left.

![The ros2/examples workspace during its build: the timeline, the dependency graph, and the build log](assets/screens/small-light.webp#only-light)
![The ros2/examples workspace during its build, dark theme](assets/screens/small-dark.webp#only-dark)

The dashboard needs nothing from colcon. It reads the files that colcon writes into `log/` for every build. So a build shows up also when it started before you opened the page.

## 4. Read the result

When the build ends, the badge in the header says COMPLETE, FAILED, or STOPPED, and the browser tab shows ✓ or ✗.

- Click a package in the graph or the timeline to open its log.
- If a package fails, its log opens by itself. See [When a build fails](guide/failures.md).
- Click **Build** in the header to open an earlier build, and compare the times.

## Build and open in one step

Add this function to your `~/.bashrc`:

```bash
cb() { colcon-dashboard . --open && colcon build "$@"; }
```

Then `cb` opens the page of the workspace and starts the build. Pass the colcon options as usual, for example `cb --packages-up-to my_package`.

The function needs the service. With the service, `colcon-dashboard` returns at once. Without it, the command keeps the server in the foreground, and the build does not start.

## Next steps

- [Install the dashboard as an app](desktop-app.md), with its own window and a tray icon.
- [Take the tour](guide/index.md) of the whole page.
- [Watch a build on another machine](remote.md) through an SSH tunnel.
