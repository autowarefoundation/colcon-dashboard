---
title: Colcon Dashboard
template: home.html
hide:
  - navigation
  - toc
description: >-
  Colcon Dashboard is a live web dashboard for colcon build. Watch the
  dependency graph fill in, find the slow packages on a timeline, read each
  package's log on its own, and see the load on your machine.
---

# Colcon Dashboard { .cd-sr-only }

<div class="cd-pillars" markdown>

<div markdown>
:lucide-plug-zap: 

### Nothing to set up per build

The dashboard reads the logs that colcon writes into `log/`. Every build shows up: from any terminal, with any options, also a build that started before you opened the page.
</div>

<div markdown>
:lucide-feather: 

### No dependencies

The server is plain Python 3.8 or newer, with only the standard library. Install it from the Ubuntu PPA or with pipx, and it starts at every login.
</div>

<div markdown>
:lucide-monitor-smartphone: 

### One address for every workspace

One server on `localhost:8642` serves all your workspaces. Open it in a browser tab, or install it as an app with its own window.
</div>

</div>

<h2 class="cd-section-title">Everything about your build, on one page</h2>
<p class="cd-section-lead">A long build is no longer a wall of scrolling text. You see what builds now, what waits, what failed, and why.</p>

<div class="cd-feature" markdown>

![The dependency graph of Autoware zoomed in during a build: done packages in green, building packages in blue, ready packages with a dashed border](assets/screens/graph-live-light.webp#only-light)
![The dependency graph of Autoware zoomed in during a build, dark theme](assets/screens/graph-live-dark.webp#only-dark)

<div markdown>
<span class="cd-kicker">Dependency graph</span>

### Watch the build move through your packages

Every package is a node, placed by its dependency depth. Done packages turn green, building packages glow blue and fill up with their make progress, and the packages that start next pulse. Hover a package to light up its whole dependency chain.

[More about the graph](guide/graph.md)
</div>

</div>

<div class="cd-feature" markdown>

![The timeline of a finished Autoware build, sorted by duration, with the longest packages on top](assets/screens/timeline-light.webp#only-light)
![The timeline of a finished Autoware build, sorted by duration, dark theme](assets/screens/timeline-dark.webp#only-dark)

<div markdown>
<span class="cd-kicker">Timeline</span>

### Find the packages that hold up the build

A Gantt chart shows when each package started and how long it took. Sort it by duration, and the slow packages and the long serial chains stand out at once.

[More about the timeline](guide/timeline.md)
</div>

</div>

<div class="cd-feature" markdown>

![A package log pane with highlighted compiler warnings, file positions, and folded install lines](assets/screens/logs-light.webp#only-light)
![A package log pane with highlighted compiler warnings, dark theme](assets/screens/logs-dark.webp#only-dark)

<div markdown>
<span class="cd-kicker">Log panes</span>

### One log per package, easy to read

Each package gets its own tab, so the output of parallel jobs never mixes. Errors and warnings stand out, hundreds of install lines fold into one, and a strip beside the scrollbar shows where the problems are. Search, copy, and scroll stay fast also in a 10 MB log.

[More about the log panes](guide/logs.md)
</div>

</div>

<div class="cd-feature" markdown>

![A failed build: the failed package in red in the graph, and the Failures tab with the error of each failed package](assets/screens/failure-light.webp#only-light)
![A failed build, dark theme](assets/screens/failure-dark.webp#only-dark)

<div markdown>
<span class="cd-kicker">Failures</span>

### Go straight to the error

When a package fails, its log opens by itself at the error. The Failures tab collects the error of every failed package, and the graph shows which packages can no longer build. One click asks Claude to find the cause.

[What happens when a build fails](guide/failures.md)
</div>

</div>

<div class="cd-feature" markdown>

![The build picker: every build and test run of the workspace, with its outcome, its duration, and the change against the previous run](assets/screens/builds-light.webp#only-light)
![The build picker, dark theme](assets/screens/builds-dark.webp#only-dark)

<div markdown>
<span class="cd-kicker">History and system</span>

### Compare builds, and keep your machine in view

Every build and test run stays one click away, with its outcome and its time against the run before. A per-core heatmap and the CPU, RAM, and swap meters warn you before a big build runs out of memory.

[A tour of the page](guide/index.md)
</div>

</div>

<h2 class="cd-section-title">From a handful of packages to hundreds</h2>
<p class="cd-section-lead">The same page works for a small workspace and for a full Autoware build.</p>

<div class="cd-scale" markdown>

<figure markdown>
![The tf2 stack of ros2/geometry2 during its build: 15 packages, with tf2_ros building while the packages that need it wait](assets/screens/small-light.webp#only-light)
![The tf2 stack of ros2/geometry2 during its build, dark theme](assets/screens/small-dark.webp#only-dark)
<figcaption><strong>ros2/geometry2: 15 packages</strong>The whole graph fits on the screen. The timeline shows the chain: <code>tf2_ros</code> builds alone, and the packages after it wait.</figcaption>
</figure>

<figure markdown>
![The whole Autoware graph during a build: 502 packages, the finished ones in green at the left, the building front in blue, and the waiting packages at the right](assets/screens/big-light.webp#only-light)
![The whole Autoware graph during a build, dark theme](assets/screens/big-dark.webp#only-dark)
<figcaption><strong>Autoware: 502 packages</strong>You see the whole build at once, and you zoom in to read the names. The page stays fast at this size.</figcaption>
</figure>

</div>

<h2 class="cd-section-title">Install it in a minute</h2>

=== "Ubuntu (PPA)"

    ```bash
    sudo add-apt-repository ppa:xmfcx/colcon-dashboard
    sudo apt install python3-colcon-dashboard
    colcon-dashboard --start-service
    ```

=== "pipx"

    ```bash
    pipx install colcon-dashboard
    colcon-dashboard --install-service
    ```

Then open <http://localhost:8642/> and pick your workspace. Your next `colcon build` shows up there by itself.

<div class="cd-cta" markdown>

## Ready for your next build?

Install the dashboard, run `colcon build` as usual, and watch it.

[Get started](install.md){ .md-button .md-button--primary }
[Take the tour](guide/index.md){ .md-button }

</div>
