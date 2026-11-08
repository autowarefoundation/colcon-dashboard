---
icon: lucide/panel-top
description: >-
  A tour of the Colcon Dashboard page: the header, the workspace and build
  pickers, the build command, the progress line, the system meters, and the
  settings.
---

# Tour of the page

The page has four parts, from top to bottom:

1. The **header**: the workspace, the build, the build status, and the system meters.
2. The **progress line**: one sentence about the build, under a progress bar.
3. The **views**: the [dependency graph](graph.md), the [timeline](timeline.md), or both side by side.
4. The **dock**: the [log panes](logs.md), one tab per package.

![The whole page during a live Autoware build](../assets/screens/hero-light.webp#only-light)
![The whole page during a live Autoware build, dark theme](../assets/screens/hero-dark.webp#only-dark)

## Header

![The header during a build: the workspace and build switchers, the LIVE badge, the build command, and the per-core heatmap with the CPU, RAM, and swap meters](../assets/screens/header-light.webp#only-light)
![The header during a build, dark theme](../assets/screens/header-dark.webp#only-dark)

From left to right, the header shows:

- The **Workspace** switcher. It shows the name of the workspace folder. Click it to open the workspace picker.
- The **Build** switcher. It shows when the build started. Its caption says "latest" while the page follows the newest build, and "pinned" when the page shows an earlier one. Click it to open the build picker.
- The **status badge**: LIVE, COMPLETE, FAILED, or STOPPED.
- The number of parallel workers.
- The **build command**, for example `colcon build · 2 options`, when the build used options. Click it to see the whole command.
- The **system meters**: a heatmap with one cell per CPU core, and meters for CPU, RAM, and swap.
- The buttons for notifications, the keyboard help, the theme, and the settings.

Hold the mouse over a switcher to see the full workspace path or the build id. When the server stops answering, the whole header turns red.

## Workspace picker

The workspace picker has three sections: **Starred**, **Recent**, and **Found on disk**. Each row shows the workspace name, its parent folder, and the time since the last build. A dot shows the result of the last build: green for passed, red for failed, orange for aborted. A workspace that builds now shows a progress bar.

- Type in the box to filter the list. The arrow keys and ++enter++ open a row.
- Paste a path and press ++enter++ to open any workspace.
- Click the star to move a workspace to **Starred**.
- The sort menu orders each section by the last build, the build count, or the log size.

The picker searches your home folder for colcon workspaces when it opens for the first time. To search other folders too, add them as [scan roots](../configuration.md#extra-scan-roots). When three or more found workspaces share a parent folder, they fold into one row.

## Build picker

![The build picker of Autoware: each build with its outcome, its duration, and the change against the previous build](../assets/screens/builds-light.webp#only-light){ .cd-narrow }
![The build picker, dark theme](../assets/screens/builds-dark.webp#only-dark){ .cd-narrow }

The build picker lists every build and every `colcon test` run of the workspace. Each row shows the outcome, the package counts, the log size, and the duration. The duration also shows the change against the previous run of the same kind: a slower run shows `+3:12` in red, and a faster run shows `−1:04` in green.

- Click a run to open it. The whole page then shows that run, and the address gets a `build` parameter, so you can share the link.
- The 🗑 button deletes the logs of one run. **Prune** keeps the newest three runs of each kind. The server never deletes a run that still writes its logs.

The page follows the newer of `log/latest_build` and `log/latest_test`. When a new build or test run starts, the page switches to it and shows a notice. For a test run, the page also shows the test results of each package.

## Build command

![The build command dropdown, with the colcon command colored like a shell and a Copy button](../assets/screens/command-light.webp#only-light){ .cd-narrow }
![The build command dropdown, dark theme](../assets/screens/command-dark.webp#only-dark){ .cd-narrow }

Click the build command in the header to see the whole command, with one option on each line. **Copy** copies it as one line, so you can run the same build again in a terminal. The dropdown shows the options that differ from the colcon defaults.

## Progress line

The progress bar fills as the build advances: green for done, moving blue stripes for building, red for failed, and orange for aborted.

During a build, the line under the bar reads, for example, "131 of 502 packages built · 3m 12s". Then it counts the building, ready, waiting, and failed packages. At the end, it shows the build rate and the estimated time left. The estimate uses the package durations of the previous build.

After the build, the line reads, for example, "502 packages built in 8m 47s". When packages printed compiler or CMake warnings, the line shows the warning count. Hold the mouse over the count to see the packages, and click it to open the first warning.

## System meters

A colcon build can use all CPU cores and run out of memory, so the header keeps the load in view:

- The heatmap has one cell per core. A cell turns from gray to full blue at 100% use.
- The CPU, RAM, and swap meters turn amber under pressure and red near the limit.
- Hold the mouse over the CPU meter for the load average, and over the RAM meter for the exact numbers.

In a narrow window, the meters fold behind a chart button.

## Settings

![The settings panel at the right edge of the page](../assets/screens/settings-light.webp#only-light){ .cd-narrow }
![The settings panel, dark theme](../assets/screens/settings-dark.webp#only-dark){ .cd-narrow }

The gear button opens the settings at the right edge of the page. The panel stays open while you work with the page.

- **This browser**: the theme, the notifications, the defaults of the log panes, and a reset of the page layout.
- **Package names**: hide a common prefix such as `autoware_` in the labels.
- **Scan roots**: more folders for the workspace picker.
- **Server**: the configuration of the server, start at login, the [tray icon](../desktop-app.md#the-tray-icon), and the buttons to restart or stop the server.

## Notifications

The bell button turns on notifications: the build finished, the build failed, or the first package failed. A second click adds a short chime. When the page runs on the same machine as the server, the server shows the notifications on your desktop, also when no page is open.

## Browser tab and theme

The browser tab shows the build also in the background. The title shows `[42%] workspace` while the build runs, and then ✓ or ✗. The icon changes color with it.

The theme button switches between the light and the dark theme. Every view changes at once, also the 3D view.

## Keyboard

Press ++question++ to see all the keys. These are the most useful:

| Key | Action |
|---|---|
| ++slash++ | Jump to the find-package box |
| ++enter++ / ++shift+enter++ | Next or previous match, in every search box |
| ++esc++ | Clear the search, or close a dropdown or the settings |
| ++left++ / ++right++ | Move between the log tabs |
