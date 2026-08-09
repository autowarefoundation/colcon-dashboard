# Colcon Mission Control

A live web dashboard for `colcon build`. It shows how many packages are done, building, ready, waiting, or failed. It draws the dependency graph and colors each node as the build moves through it. Each package gets its own log pane, so logs never mix.

The server is one Python file. It uses only the standard library. It works on any colcon workspace, because it reads the `events.log` and `logger_all.log` files that colcon writes under `log/` for every build.

## Quick start

1. Start a build in your workspace, or use a workspace that already has build logs.
2. Start the server with the workspace path:

```bash
python3 server.py ~/projects/autoware
```

3. Open <http://127.0.0.1:8642/> in a browser.

The server follows `log/latest_build`. If a new build starts in the same workspace, the page switches to it and shows a notice.

## What the page shows

### Header

The header shows the workspace path, the build id, a LIVE / COMPLETE / FAILED / STOPPED badge, and the parallel worker count.

The right side is the system strip. A colcon build can exhaust the machine, so pressure stays visible at all times:

- A per-core heatmap, one cell per core. Cell color runs from the idle gray to full blue at 100% use. Hover a cell for the exact number.
- CPU, RAM, and swap meters. A fill turns amber under pressure (CPU 85%, RAM 75%, swap 30%) and red near the limit (96%, 90%, 70%). At red the label also turns red and bold.
- Hover the CPU meter for the load average. Hover the RAM meter for the exact percentage.

### Progress strip

The meter fills as the build advances: green for done, animated blue stripes for building, red for failed, orange for aborted.

The tiles count each state: done of total, building, ready, waiting (plus a blocked count after a failure), failed, aborted, and skipped. Elapsed time and the rate in packages per minute sit at the end.

### Dependency graph

Every package in the build, laid out left to right by dependency depth. An edge points from a dependency to the package that needs it.

Node states combine color, border, and motion:

- **Done**: a green wash.
- **Building**: a blue box that slowly breathes, desynced per node. The box fills left to right with a deeper blue as make reports `[ 42%]` progress, and the label stays legible on top.
- **Ready**: a dashed blue border. All dependencies are done, and the package starts as soon as a worker frees.
- **Next up**: a slow pulse. This waiting package starts when the packages that build now finish, because no deeper dependency blocks it.
- **Waiting**: quiet gray. **Skipped**: gray with a struck label.
- **Failed**: solid red. Everything downstream of a failure turns red-dashed with red edges. This blast radius stays distinct from packages that were merely abandoned when the build stopped.
- **Aborted**: orange. The package was building when the build stopped.

Edges take color from their endpoints:

- Light green between two done packages: finished lineage.
- Solid blue into a building package, with droplets that flow along the edge at constant speed: the package consumes its finished dependencies.
- Dashed blue marching into a next-up package: what it waits for.
- Red along the failure cascade.

Interaction:

- Hover a node to see its state, phase, time, stderr count, and path, and to light its full dependency chain while the rest dims.
- Click a node to open its log pane.
- Drag to pan, scroll to zoom. **Fit** frames the whole graph. **Frontier** zooms to what builds now.
- **This build / All packages** switches between the build's packages and the whole workspace.
- When most package names share a prefix such as `autoware_`, the labels hide it. Tooltips keep the full name.

### Layout modes

The **Layout** button cycles three modes, and the choice persists:

- `layered`: the static left-to-right layout described above.
- `force`: a live spring simulation with the same left-to-right anchoring. Drag nodes to rearrange. The simulation cools and stops by itself.
- `3d`: the build as a wavefront. Building packages share one central plane, finished discs stack to its left, and waiting discs queue to the right by dependency depth. Packages glide through the blue plane as the build advances. Left-drag orbits, shift-drag or right-drag or middle-drag pans, the wheel zooms, and the camera rotates by itself until the first grab.

Fit and Frontier drive the camera in every mode.

### Timeline

A Gantt chart of every started package, sorted by start time, with a time axis and a dashed now line. Bar colors match the graph states.

The chart makes the parallelism and the long serial chains visible. It auto-scrolls to the newest bars as they start; scroll up to release, or use the **⤓ follow new** toggle.

### Log panes

Click any package in the graph or the timeline to open its log in the dock at the bottom. Each package gets its own tab and its own scrollback, so logs never interleave.

- A pane follows new output until you scroll up. The **⤓ follow** button re-engages.
- A selector switches between `stdout+stderr`, `stderr`, `stdout`, and the command log.
- ANSI colors render as in a terminal: the 16 classic colors, 256-color, and truecolor, with palettes tuned per theme. Uncolored lines that match error or warning patterns still get color.
- When a package fails, its pane opens by itself and a toast points to it.
- Drag the bar above the dock to resize it.

### Theme

The page follows the system theme. The ◐ button cycles system, light, and dark. Every view recolors instantly, including the 3D canvas.

## How it works

colcon writes a structured event stream to `log/<build>/events.log`. The server tails this file and reconstructs the exact job set from it. `JobQueued` events carry the full dependency closure of each job, as colcon resolved it. `JobStarted`, `JobEnded`, and `JobSkipped` events give the state machine. `TimerEvent` heartbeats give liveness, so the LIVE badge does not depend on process inspection.

The graph shows direct edges, not the full closure. The server computes the transitive reduction of colcon's per-job dependency sets. Package metadata (path, build type) and the edges of packages outside the current build come from a scan of the `package.xml` files in the workspace.

Per-package logs come from `log/<build>/<package>/`. The server serves them incrementally by byte offset, so an open pane costs one small request per second.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `workspace` | `.` | Colcon workspace root (positional) |
| `--port` | `8642` | HTTP port |
| `--host` | `127.0.0.1` | Bind address. Use `0.0.0.0` to reach the page from another machine |
| `--log-base` | `log` | Log directory, relative to the workspace |

## API

| Endpoint | Returns |
|---|---|
| `/api/state` | Job states, counts, timings, build metadata |
| `/api/graph` | Direct dependency edges for the graph views |
| `/api/builds` | The `build_*` directories under the log base |
| `/api/log/<pkg>?offset=N&file=combined` | A log chunk from byte `N`, plus the new offset |

## Limits

- One server watches one workspace. Start a second server on another port for a second workspace.
- The page follows the latest build. Finished builds stay readable until a new build starts.
- The server trusts the local workspace. Do not expose the port to an untrusted network.
