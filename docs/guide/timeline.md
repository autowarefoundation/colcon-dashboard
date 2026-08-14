---
icon: lucide/chart-gantt
description: >-
  The Gantt timeline of a colcon build: sort orders, auto-scroll, and the
  side-by-side view that pairs the timeline with the dependency graph.
---

# Timeline

A Gantt chart of every started package, with a time axis and a dashed now line. Bar colors match the graph states.

<!-- TODO(images): timeline of a parallel build, longest bars sorted on top. -->

The **order** menu sorts the rows: by start time, by duration with the longest build first, by end time, or by status with failures on top. The choice persists.

The chart makes the parallelism and the long serial chains visible. It auto-scrolls to the newest bars as they start. Scroll up to release, or use the **⤓ follow new** toggle. Drag anywhere to pan, like the graph.

Click a bar or a package name and its log pane opens while the graph flies to that package. From the pure timeline, this click switches to the side-by-side view, so the graph comes in without losing the timeline.

**Side by side** shows the graph and the timeline together, over a drag bar. It is the default view, and the split ratio and the view choice persist.
