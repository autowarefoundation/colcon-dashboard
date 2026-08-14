---
title: Live web dashboard for colcon builds
icon: lucide/layout-dashboard
description: >-
  Colcon Dashboard is a live web dashboard for colcon build. It shows the
  dependency graph, a Gantt timeline, per-package logs, and system pressure
  for any ROS 2 or Autoware workspace.
---

# Colcon Dashboard

A live web dashboard for `colcon build`. It shows how many packages are done, building, ready, waiting, or failed. It draws the dependency graph and colors each node as the build moves through it. Each package gets its own log pane, so logs never mix.

<!-- TODO(images): hero screenshot of the graph view on a live build goes here. -->

The server uses only the Python standard library, with zero dependencies. It works on any colcon workspace (ROS 2, Autoware, or anything else that colcon builds). For every build, colcon writes `events.log` and `logger_all.log` under `log/`. The dashboard reads these files and needs nothing from colcon itself. Any build shows up, from any terminal, with any options.

=== "Ubuntu PPA"

    ```bash
    sudo add-apt-repository ppa:xmfcx/colcon-dashboard
    sudo apt install python3-colcon-dashboard
    colcon-dashboard --install-service
    ```

    The package upgrades with the usual system updates (`sudo apt upgrade`).

=== "pipx"

    ```bash
    pipx install colcon-dashboard
    colcon-dashboard --install-service
    ```

    To upgrade to the newest release:

    ```bash
    pipx upgrade colcon-dashboard
    ```

=== "pip"

    ```bash
    pip install colcon-dashboard
    colcon-dashboard --install-service
    ```

    To upgrade to the newest release:

    ```bash
    pip install --upgrade colcon-dashboard
    ```

=== "From a checkout"

    ```bash
    git clone https://github.com/autowarefoundation/colcon-dashboard
    pipx install ./colcon-dashboard
    colcon-dashboard --install-service
    ```

    To upgrade, pull and reinstall:

    ```bash
    git -C colcon-dashboard pull
    pipx install --force ./colcon-dashboard
    ```

Open <http://127.0.0.1:8642/> and pick your workspace. That is the whole setup. After an upgrade, run `colcon-dashboard --restart-service`. The [install page](install.md) has the service commands.

## What you get

- **[Dependency graph](guide/graph.md)**: every package, laid out by dependency depth and recolored live as the build moves. The layouts are layered, force, and a 3D wavefront.
- **[Timeline](guide/timeline.md)**: a Gantt chart of every started package. It makes the parallelism and the long serial chains visible.
- **[Log panes](guide/logs.md)**: one tab per package, with search, ANSI colors, timestamps, and editor links. Failed panes open by themselves.
- **[AI failure analysis](guide/ai.md)**: one click starts a headless [claude](https://claude.com/claude-code) run on a failed package and streams the investigation live.
- **System pressure**: a per-core heatmap plus CPU, RAM, and swap meters. A colcon build can exhaust the machine, so pressure stays visible.
- **Build history**: every build and `colcon test` run of the workspace, with outcomes, durations, and deltas against the previous run.

## How it fits in

One server runs per machine, on port 8642, and serves every workspace. The `ws` query parameter picks the workspace, so each browser tab can show a different one. The server keeps running after the build, so the pages stay available for the next build and for post-mortems.

Start with the [quick start](quick-start.md), or read [how it works](reference/how-it-works.md).
