---
icon: lucide/scroll-text
description: >-
  One log pane per package, with highlighted errors and warnings, folded
  install lines, search, the raw view, and fast scrolling also in a 10 MB
  build log.
---

# Log panes

The dock at the bottom of the page holds the logs. It opens with the **Build log** tab: the whole build as a terminal shows it, with a `Starting >>>` and a `Finished <<<` line around the output of each package. Click a package in the graph or the timeline, and its own log opens in a new tab. Each tab has its own log, so the output of parallel jobs never mixes.

![The log pane of one package: a compiler warning with its file position, the code excerpt, and the warning flag, and the marks beside the scrollbar](../assets/screens/logs-light.webp#only-light)
![The log pane of one package, dark theme](../assets/screens/logs-dark.webp#only-dark)

## Highlighting

colcon writes its logs without colors, so the panes color the parts that matter:

- **Errors and warnings** get a colored bar at the left edge and a tint: red for errors, amber for warnings, and blue for notes. This covers GCC, Clang, and NVCC, CMake warnings and errors, and failed commands.
- **The marks** beside the scrollbar show where the errors and warnings are. Click a mark to jump to its line.
- **A compiler message** shows the file position underlined, the severity in bold, the quoted code on a tint, and the warning flag, for example `[-Wunused-variable]`, dimmed.
- **Install lines** (`-- Installing:`, `-- Up-to-date:`, and the like) fold into one line with a count, for example "312 install lines". They are often more than half of a build log. Click the line to open the group.
- **Package names** in the build log each get their own color, so the output of parallel jobs separates. Click a name to open the log of that package.
- **Durations** at the end of a package turn orange over one minute and red over five minutes.
- **CMake progress** such as `[ 42%]` shows as a small bar. `Built target` lines are green.
- **Long commands** fold their environment variables into one chip, for example "4 environment variables". Click the chip to see them.
- **Directories** in paths are dimmed, so the file names stand out.
- Rows have a faint stripe, and the row under the mouse lights up.

The panes also show real terminal colors (ANSI), with palettes for each theme.

![The build log of Autoware: package names in their own colors, CMake progress bars, folded install lines, and Finished lines with durations](../assets/screens/buildlog-light.webp#only-light)
![The build log of Autoware, dark theme](../assets/screens/buildlog-dark.webp#only-dark)

## Raw view

Click **Raw** to see every character of the log in its place. The raw view keeps the colors, the error and warning tints, and the marks, but it hides and moves nothing. The install lines do not fold, the commands show their full environment, and the progress and duration chips show their original text. The page keeps your choice for new panes.

## Find and copy

- The **search** box filters as you type, and the matches light up. ++enter++ and ++shift+enter++ step through them. The search stays live while the log grows.
- The browser's own find (++ctrl+f++) also finds lines inside folded groups, and it opens the group of a match.
- A selection over more than one line copies whole lines, exactly as the log has them, also the lines inside folded groups.

## Large logs

A pane loads the whole log, also a 10 MB build log with 60,000 lines. A thin bar at the top of the pane shows the progress of the first load. Scrolling, resizing, and the **Wrap** button stay fast at any size, because the pane draws only the part near the view.

## Pane controls

- **Follow** keeps the pane at the end while new lines arrive. Scroll up to stop it.
- **Time** shows or hides the timestamps. The build log counts from the start of the build, and a package pane from the start of the package.
- **Wrap** wraps long lines. Prose from Claude starts wrapped.
- The selector in a package pane switches between the timestamped output, `stdout+stderr`, `stderr`, `stdout`, and the command log.
- **Path** copies the absolute source path of the package.
- If you set an [editor link](../configuration.md#editor-links), every `file:line` position gets a ↗ link that opens your editor at that line.

The ✕ on a tab closes it. **Close all** closes every tab except the build log. Drag the bar above the dock to change its height. A reload of the page keeps the place in each pane.

## Links to a pane

The address follows the open pane, for example `#pkg=autoware_planning_msgs`. Copy the address, and a colleague opens the same package. The `ws` and `build` parameters pick the workspace and the build.
