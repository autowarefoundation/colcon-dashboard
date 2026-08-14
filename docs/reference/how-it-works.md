---
icon: lucide/cog
description: >-
  How Colcon Dashboard reconstructs a build from the events.log that colcon
  writes: the job state machine, the transitive reduction, and log serving.
---

# How it works

colcon writes a structured event stream to `log/<build>/events.log`. The server tails this file and reconstructs the exact job set from it. `JobQueued` events carry the full dependency closure of each job, as colcon resolved it. `JobStarted`, `JobEnded`, and `JobSkipped` events give the state machine. `TimerEvent` heartbeats give liveness, so the LIVE badge does not depend on process inspection.

The graph shows direct edges, not the full closure. The server computes the transitive reduction of the per-job dependency sets from colcon. Package metadata (path, build type) and the edges of packages outside the current build come from a scan of the `package.xml` files in the workspace.

Per-package logs come from `log/<build>/<package>/`. The server serves them incrementally by byte offset, so an open pane costs one small request per second.

## Limits

- One server per machine, and a lock enforces it. It serves any number of workspaces.
- A page follows the latest build of its workspace, unless its address pins an older one. Finished builds stay readable until their logs get deleted.
- The server trusts the local workspace. Do not expose the port to an untrusted network.
