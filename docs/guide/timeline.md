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

The page keeps your choice.

## While the build runs

![The timeline during a live build of ros2/examples: the building packages in blue up to the dashed line of the current time, and the finished packages in green](../assets/screens/timeline-live-light.webp#only-light)
![The timeline during a live build of ros2/examples, dark theme](../assets/screens/timeline-live-dark.webp#only-dark)

The timeline scrolls to the newest packages as they start. Scroll up to stop this, or click **Follow** to start it again. A reload of the page keeps your place.

## Read and move

- The time axis stays at the top while you scroll.
- A long package name ends in "…", and its tooltip shows the full name. Drag the right edge of the name column to make it wider. Double-click the edge to fit the column to the names again.
- Drag anywhere to pan, like in the graph.
- Click a bar or a name to open the log of that package.

## Side by side

**Side by side** shows the timeline and the graph together, with a bar between them that you can drag. It is the default view. In this view, a click on a package also moves the graph to it. The page keeps the view and the split.
