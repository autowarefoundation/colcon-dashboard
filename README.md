# Colcon Dashboard

A live web dashboard for `colcon build`. It shows how many packages are done, building, ready, waiting, or failed. It draws the dependency graph and colors each node as the build moves through it. Each package gets its own log pane, so logs never mix.

The server is one Python file. It uses only the standard library. It works on any colcon workspace, because it reads the `events.log` and `logger_all.log` files that colcon writes under `log/` for every build.

## Install

The package has two parts: the `colcon-dashboard` command, and a colcon plugin that can start the dashboard when `colcon build` runs.

On Ubuntu, install the apt package from the PPA. This is the official method. It puts the plugin in the same Python environment as the apt colcon, where colcon finds it:

```bash
sudo add-apt-repository ppa:xmfcx/colcon-dashboard
sudo apt install python3-colcon-dashboard
```

For other setups, install from PyPI into the environment that runs colcon:

- colcon in a virtualenv or a conda environment: `pip install colcon-dashboard` in that environment.
- colcon installed with pipx: `pipx inject colcon-common-extensions colcon-dashboard`.
- For the `colcon-dashboard` command alone, without the plugin: `pipx install colcon-dashboard`.

To install from a checkout, replace the package name with the path to this repository.

To keep the server always available, install it as a systemd user service:

```bash
colcon-dashboard --install-service
```

The service starts at login and restarts on failure.

## Quick start

Run a build with the dashboard switched on. The plugin starts it and prints the address of your workspace's page:

```text
$ colcon build --event-handlers dashboard+
[colcon-dashboard] dashboard: http://127.0.0.1:8642/?ws=%2Fhome%2Fuser%2Fws
```

The plugin stays off by default, so a plain `colcon build` starts no server.

For daily use, turn it on once. Pick one of these:

Add this line to your `~/.bashrc`:

```bash
export COLCON_DASHBOARD=1
```

Or enable the handler in `~/.colcon/defaults.yaml`:

```yaml
build:
  event-handlers: [dashboard+]
```

After that, every `colcon build` starts the dashboard server, or reuses the one that already runs. The command line toggle wins over the environment default in both directions.

One server runs per machine, on port 8642, and serves every workspace. The page's `ws` query parameter picks the workspace, so each browser tab can show a different one. A file lock refuses duplicate servers, and the server keeps running after the build, so the pages stay available for the next build and for post-mortems.

Click the workspace path in the header to open the workspace picker: your recent workspaces, a path box, and a scan of your home directory for colcon workspaces.

You can also run it by hand, with or without the plugin:

```bash
colcon-dashboard                              # start the server, or print its URL
colcon-dashboard ~/projects/autoware          # same, and open this workspace
colcon-dashboard --list                       # the known workspaces and their URLs
colcon-dashboard --stop                       # stop the server
```

The server follows `log/latest_build`. If a new build starts in the same workspace, the page switches to it and shows a notice.

## What the page shows

### Header

The header shows the workspace path, the build id, a LIVE / COMPLETE / FAILED / STOPPED badge, and the parallel worker count. The workspace path opens the workspace picker. The build id opens the build picker. The power button stops the server, after a confirmation. When the server stops answering, the whole top panel turns red.

The workspace picker lists your recent workspaces with their build count, log size, and last build time, and shows live progress for workspaces that build now. A star pins a favorite to the top. The picker also opens any path and scans your home directory for colcon workspaces.

The build picker lists every build of the workspace with its log size and its outcome: a passed, failed, or aborted chip, with the done, failed, aborted, and skipped package counts. The outcome comes from one pass over the build's `events.log`, cached in a small file inside the build folder. Open a build and the whole dashboard shows it, with the `build` query parameter in the address. The 🗑 buttons delete one build's logs, and a prune action keeps the last three. The server refuses to delete a build that runs now.

The right side is the system strip. A colcon build can exhaust the machine, so pressure stays visible at all times:

- A per-core heatmap, one cell per core. Cell color runs from the idle gray to full blue at 100% use. Hover a cell for the exact number.
- CPU, RAM, and swap meters. A fill turns amber under pressure (CPU 85%, RAM 75%, swap 30%) and red near the limit (96%, 90%, 70%). At red the label also turns red and bold.
- Hover the CPU meter for the load average. Hover the RAM meter for the exact percentage.
- In a narrow window the strip folds behind a chart button and drops down on demand.

### Progress strip

The meter fills as the build advances: green for done, animated blue stripes for building, red for failed, orange for aborted.

The tiles count each state: done out of the total, building, ready, waiting (plus a blocked count after a failure), failed, aborted, and skipped. Elapsed time and the rate in packages per minute sit at the end.

### Dependency graph

Every package in the build, laid out left to right by dependency depth. An edge points from a dependency to the package that needs it.

Node states combine color, border, and motion:

- **Done**: a green wash.
- **Building**: a blue box that slowly breathes, each node in its own rhythm. The box fills left to right with a deeper blue as make reports `[ 42%]` progress, and the label stays legible on top. A faint halo glows behind the node on the backmost layer, so the active zone shows even from far out.
- **Ready**: a dashed blue border. All dependencies are done, and the package starts as soon as a worker becomes free.
- **Next up**: a slow pulse. This waiting package starts when the packages that build now finish, because no deeper dependency blocks it.
- **Waiting**: quiet gray. **Skipped**: gray with a struck label.
- **Failed**: solid red. Everything downstream of a failure turns red-dashed with red edges. This blast radius looks different from the packages that the stop only abandoned, which stay gray.
- **Aborted**: orange. The package was building when the build stopped.

Edges take color from their endpoints:

- Light green between two done packages: finished lineage.
- Solid blue into a building package, with droplets that flow along the edge at constant speed: the package consumes its finished dependencies.
- Dashed blue marching into a next-up package: what it waits for.
- Red along the failure cascade.

Interaction:

- Hover a node to see its state, phase, time, stderr count, and path, and to light its full dependency chain while the rest dims.
- Click a node to open its log pane.
- The **find package** box highlights matching packages while the rest fades, in every layout and in the timeline. Enter and Shift+Enter jump through the matches.
- Double-click a log tab in the dock to center the view on that package.
- Drag to pan, scroll to zoom. **Fit** frames the whole graph.
- **⌖ follow build** keeps the camera on the packages that build now, so the action stays framed as the build moves through the graph. Pan or zoom by hand and the camera is yours again.
- The **show** switch picks what the graph draws: only this build's packages, or the whole workspace.
- When most package names share a prefix such as `autoware_`, the labels hide it. Tooltips keep the full name.

### Layout modes

The **layout** menu picks one of three modes, and the choice persists:

- `layered`: the static left-to-right layout described above.
- `force`: a live spring simulation with the same left-to-right anchoring. Drag nodes to rearrange. The simulation cools and stops by itself.
- `3d`: the build as a wavefront. Building packages share one central plane, finished discs stack to its left, and waiting discs queue to the right by dependency depth. Packages glide through the blue plane as the build advances. Left-drag orbits, shift-drag or right-drag or middle-drag pans, the wheel zooms, and the camera rotates by itself until the first grab.

Fit and follow build drive the camera in every mode. In the force and 3D modes, a **spread** slider in the corner scales how far the simulation spreads the nodes.

### Timeline

A Gantt chart of every started package, sorted by start time, with a time axis and a dashed now line. Bar colors match the graph states.

The chart makes the parallelism and the long serial chains visible. It auto-scrolls to the newest bars as they start. Scroll up to release, or use the **⤓ follow new** toggle.

Click a bar or a package name and its log pane opens while the graph flies to that package. From the pure timeline this switches to the side-by-side view, so the graph comes in without losing the timeline.

**Side by side** shows the graph and the timeline together, over a drag bar. The split ratio persists.

### Log panes

The dock opens with a pinned **build log** tab: the whole build, as a terminal shows it, with `Starting >>>` and `Finished <<<` lines between every package's output. Click any package in the graph or the timeline to open its own tab next to it. Each tab has its own scrollback, so logs never interleave.

- A pane follows new output until you scroll up. The **⤓ follow** button re-engages.
- Panes open at the tail for an instant start. **⤒ load all** fetches the whole history in one click.
- Every line carries a timestamp: build-relative in the build log, job-relative in package panes. The **🕒 ts** button hides them.
- The **↩ wrap** button soft-wraps long lines. The choice sticks for future panes, and AI panes start wrapped because prose reads badly on one line.
- The **search** box filters as you type: matching lines highlight, Enter and Shift+Enter step through them, and the search stays live while the log streams.
- A selector switches a package pane between the timestamped output, `stdout+stderr`, `stderr`, `stdout`, and the command log.
- ANSI colors render as in a terminal: the 16 classic colors, 256-color, and truecolor, with palettes tuned per theme. Uncolored lines that match error or warning patterns still get color.
- When a package fails, its pane opens by itself and a toast points to it. A page opened on an already failed build opens the failed packages' panes too, earliest failure first.
- Drag the bar above the dock to resize it.

### AI failure analysis

When the [claude CLI](https://claude.com/claude-code) is installed, the pane of a failed package shows an **✦ ask claude** button. It starts a headless `claude` run in the workspace, with the tail of the failed log as the prompt. A new ✦ pane streams the investigation live: the files it reads, the commands it runs, and the answer.

- Nothing runs by itself. Each analysis starts with a click, and it spends your Claude usage.
- The run gets read tools approved and no edit tools, and headless claude refuses actions that need more permission.
- The transcript persists next to the package's logs, so it survives a server restart and reopens instantly.
- The input box under the transcript asks follow-up questions in the same session, through `claude --resume`.

### Theme

The page follows the system theme. The theme button cycles system, light, and dark. Every view recolors instantly, including the 3D canvas.

## How it works

colcon writes a structured event stream to `log/<build>/events.log`. The server tails this file and reconstructs the exact job set from it. `JobQueued` events carry the full dependency closure of each job, as colcon resolved it. `JobStarted`, `JobEnded`, and `JobSkipped` events give the state machine. `TimerEvent` heartbeats give liveness, so the LIVE badge does not depend on process inspection.

The graph shows direct edges, not the full closure. The server computes the transitive reduction of colcon's per-job dependency sets. Package metadata (path, build type) and the edges of packages outside the current build come from a scan of the `package.xml` files in the workspace.

Per-package logs come from `log/<build>/<package>/`. The server serves them incrementally by byte offset, so an open pane costs one small request per second.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `workspace` | | Workspace to register and print the page URL for (optional) |
| `--port` | `8642` | HTTP port. The default falls back to a free port when taken |
| `--host` | `127.0.0.1` | Bind address. Use `0.0.0.0` to reach the page from another machine |
| `--log-base` | `log` | Log directory, relative to a workspace |
| `--stop` | | Stop the server |
| `--list` | | List the known workspaces and their URLs |
| `--install-service` | | Install and start the systemd user service |

## API

Workspace endpoints take a `ws=<path>` query parameter. Add `build=<build id>` to read an older build.

| Endpoint | Returns |
|---|---|
| `/api/workspaces` | The recent workspaces, with live build info where known |
| `/api/discover` | Colcon workspaces found under the home directory |
| `/api/register?ws=` (POST) | Registers a workspace, like opening it in the page |
| `/api/favorite?ws=&fav=1` (POST) | Pins or unpins a workspace |
| `/api/builds/delete?ws=&build=` (POST) | Deletes one build's logs |
| `/api/builds/prune?ws=&keep=3` (POST) | Deletes all but the newest builds |
| `/api/state?ws=` | Job states, counts, timings, build metadata |
| `/api/graph?ws=` | Direct dependency edges for the graph views |
| `/api/builds?ws=` | The `build_*` directories under the log base |
| `/api/log/<pkg>?ws=&offset=N&file=streams` | A log chunk from byte `N`, plus the new offset |
| `/api/buildlog?ws=&offset=N` | A chunk of the combined build log, same shape |
| `/api/analyze/<pkg>?ws=&q=` (POST) | Starts an AI analysis of a failed package, or asks a follow-up |
| `/api/analysis/<pkg>?ws=&offset=N` | The analysis transcript from byte `N`, plus a running flag |
| `/api/stop` (POST) | Stops the server, like `colcon-dashboard --stop` |

## Limits

- One server per machine, and a lock enforces it. It serves any number of workspaces.
- A page follows its workspace's latest build, unless its address pins an older one. Finished builds stay readable until their logs get deleted.
- The server trusts the local workspace. Do not expose the port to an untrusted network.
