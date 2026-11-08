---
icon: lucide/waypoints
description: >-
  The live dependency graph of a colcon build: what the colors mean, how to
  find a package and its dependency chain, and the layered, force, and 3D
  layouts.
---

# Dependency graph

The graph shows every package of the build. Each package is a node, placed from left to right by its dependency depth. An edge points from a dependency to the package that needs it. The graph changes live as the build moves through it.

![The dependency graph of Autoware zoomed in during a build: done packages in green, building packages in blue, ready packages with a dashed blue border, and waiting packages in gray](../assets/screens/graph-live-light.webp#only-light)
![The dependency graph of Autoware zoomed in during a build, dark theme](../assets/screens/graph-live-dark.webp#only-dark)

## What the colors mean

| Node | State |
|---|---|
| Green | **Done**. |
| Blue, slowly breathing | **Building**. The box fills from left to right as make reports its progress, for example `[ 42%]`. |
| Dashed blue border | **Ready**. All its dependencies are done, and it starts when a worker is free. |
| Slow pulse | **Next up**. It starts as soon as the packages that build now finish. |
| Gray | **Waiting** for its dependencies. A struck label means **skipped**. |
| Red | **Failed**. Every package that depends on it gets a red dashed border, because it can no longer build. |
| Orange | **Aborted**. It was building when the build stopped. |

The edges take their color from the nodes at their ends. Light green edges connect finished packages. Blue edges, with small dots that flow along them, lead into a building package. Red edges follow a failure to the packages that depend on it.

From far away, the whole build reads at a glance: green at the left, the blue front of the build in the middle, and the gray packages that wait at the right.

![The whole Autoware graph during a build: green packages at the left, the building front in blue, and the waiting packages in gray at the right](../assets/screens/graph-overview-light.webp#only-light)
![The whole Autoware graph during a build, dark theme](../assets/screens/graph-overview-dark.webp#only-dark)

When you zoom out so far that the labels can no longer be read, each node becomes a plain colored box.

## Move around

- Drag to pan, and scroll to zoom.
- **Fit** shows the whole graph.
- **Follow** keeps the camera on the packages that build now. When you pan or zoom yourself, Follow turns off.
- Double-click a log tab in the dock to center the graph on that package.
- A reload of the page keeps the view. A new build fits the whole graph again.

## Find a package and its chain

![A selected package with its whole dependency chain in focus, and the rest of the graph dimmed](../assets/screens/graph-focus-light.webp#only-light)
![A selected package with its dependency chain in focus, dark theme](../assets/screens/graph-focus-dark.webp#only-dark)

- Hold the mouse over a package to see its state, its build time, and its path. Its whole dependency chain lights up, and the rest of the graph dims. If the previous build has a time for the package, the tooltip compares the two times.
- Click a package to select it and to open its log. The chain stays in focus after the mouse leaves. ++ctrl++ + click or ++shift++ + click adds packages to the selection. Click empty space or press ++esc++ to clear it.
- Type in the **Find package** box to highlight the matching packages. ++enter++ and ++shift+enter++ jump through the matches. The ++slash++ key jumps to the box.
- The state buttons (**Failed**, **Building**, **Waiting**, **Done**) highlight the packages in that state. One click on **Failed** shows every package that a failure blocks.

## What the graph shows

The **Show** switch picks the packages: only the packages of this build, or the whole workspace.

When most package names start with the same prefix, such as `autoware_`, the labels leave it out, so the names stay short. The page does this only when the names stay long enough without the prefix. In the tf2 stack, for example, `tf2_` stays, because `tf2_ros` would become `ros`. A label also never gets shorter than four characters. The tooltips and the pane headers keep the full names. To choose the prefix yourself, open the settings and use **Package names**.

## Layouts

The **Layout** menu has three layouts. The page keeps your choice.

- **Layered**: the left-to-right layout that this page shows. It is the clearest layout for a build.
- **Force**: a live spring simulation with the same left-to-right order. You can drag the nodes. A **Spread** slider sets how far the nodes spread out.
- **3D**: the build as a wave. The building packages share one plane in the middle, the finished packages stack at the left, and the waiting packages queue at the right. Drag to turn the view, ++shift++ + drag to pan, and scroll to zoom.

![The 3D layout during a build: the building packages on a blue plane in the middle, the finished packages at the left, and the waiting packages at the right](../assets/screens/graph-3d-light.webp#only-light)
![The 3D layout during a build, dark theme](../assets/screens/graph-3d-dark.webp#only-dark)

In the force and 3D layouts, the camera keeps the whole graph in view until you pan, zoom, or drag. **Fit** starts this again.
