---
icon: lucide/chart-gantt
description: >-
  The Gantt timeline of a colcon build: find the slow packages and the long
  serial chains, sort the rows, follow the newest packages, and pair the
  timeline with the graph.
---

# Timeline

The timeline is a Gantt chart of every package that started. Each row is one package, and its bar runs from the start to the end of its build. A dashed line marks the current time while the build runs. The bar colors match the graph: green for done, blue for building, striped red for failed, and orange for aborted.

![The timeline of the full Autoware build, sorted by duration: the longest packages on top](../assets/screens/timeline-light.webp#only-light)
![The timeline of the full Autoware build, sorted by duration, dark theme](../assets/screens/timeline-dark.webp#only-dark)

## Find what slows the build

The timeline shows how well the build uses its workers. Many bars side by side mean a parallel build. One long bar alone means that the build waits for that package.

The **Order** menu sorts the rows:

- **Start time**: the order in which the packages started. This is the default.
- **Duration**: the longest package first. Use it to find the packages to speed up.
- **End time**: the order in which the packages finished.
- **Status**: the failed packages first.
- **Change**: the packages that got slower first, against the run that **Compare** shows.

The page keeps your choice.

## Compare with another run

The **Compare** menu shows why one run took longer than another. It draws the time of each package in the other run as a light outline behind its bar. After the bars, a red label such as `+42s` marks a package that got slower, and a green label such as `−10s` marks a package that got faster. The label `new` marks a package that was not in the other run.

- **Last run**: the previous run of the same kind.
- **Usual times**: the median time of each package over up to five earlier runs.
- An earlier run: any build or test run that the log directory still keeps.

A label shows a change of 10 seconds, or a change of 2 seconds and 10 %. Beside the menu, a line gives the change of the whole run and counts the slower, faster, and new packages. It gives the change of the whole run only when both runs ran all their packages to the end, with no abort and no package that a failure blocked. Choose **Change** in the **Order** menu to see the largest changes on top.

After a build, the [progress line](index.md#progress-line) shows how much slower or faster the build was than the last run, when both runs ran all their packages to the end. Click it to open the timeline with this comparison.

## While the build runs

![The timeline during a live build of ros2/examples: the building packages in blue up to the dashed line of the current time, and the finished packages in green](../assets/screens/timeline-live-light.webp#only-light)
![The timeline during a live build of ros2/examples, dark theme](../assets/screens/timeline-live-dark.webp#only-dark)

The timeline scrolls to the newest packages as they start. Scroll up to stop this, or click **Follow** to start it again. A jump to a package that is not at the end, for example from a click in the graph, also stops it. A reload of the page keeps your place.

## Read and move

- The time axis stays at the top while you scroll.
- A long package name ends in "…", and its tooltip shows the full name. Drag the right edge of the name column to make it wider. Double-click the edge to fit the column to the names again.
- Drag anywhere to pan, like in the graph.
- Click a bar or a name to select the package and to open its log. The bars of its dependency chain stay clear, and the other bars fade. ++ctrl++ + click or ++shift++ + click adds packages to the selection. Click empty space or press ++esc++ to clear it. The [graph](graph.md#find-a-package-and-its-chain) shows the same selection.

## Side by side

**Side by side** shows the timeline and the graph together, with a bar between them that you can drag. It is the default view. In this view, a click on a package in one view also moves the other view to it. A jump of the **Find package** box, a double-click on a log tab, and **Locate** in a log pane move both views. The page keeps the view and the split.
