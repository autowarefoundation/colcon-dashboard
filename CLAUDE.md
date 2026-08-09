# colcon-dashboard — architecture notes

A live web dashboard for `colcon build`. The server tails the log files
colcon already writes (`log/<build>/events.log`); it never talks to colcon.

## Invariants

- **Server: Python standard library only.** No pip dependencies, Python 3.8+.
- **Frontend: vanilla ES modules, no build step.** `static/` is served as-is;
  no bundler, no npm, no vendored libraries.
- **One server per machine** (port 8642, file lock), serving any number of
  workspaces; the `ws` query parameter selects one per page.

## Server modules (one-way dependencies, top to bottom)

    cli.py       argparse, single-instance lock, systemd service install
    web.py       Handler: /api/* endpoints + static serving
    registry.py  workspace registry, recents, home-directory discovery
    monitor.py   BuildMonitor: job-state machine, outcome cache, log serving
    events.py    events.log parser, synthesized build log (all colcon
                 log-format knowledge lives here)
    packages.py  package.xml scanning, colcon namespace parsing
    ai.py        claude CLI failure analysis

## Frontend modules

Layers: `util/state/bus` → `modes/toasts/ansi/theme/header` → the graph-view
subsystem (`camera/force/graph/g3d/gsearch`, which may import each other) →
`gantt/dock/ai` → `views/pickers/poller` → `app.js` (boot only).

Modules do not call sideways; they communicate through:

- **`bus.js` events**: `state`, `graph`, `build-changed`, `pkg-failed`
  (emitted by poller.js), `open-pkg`, `focus-pkg`, `analyze-pkg`,
  `theme-changed` (emitted by the interactions). Handlers subscribe at
  module bottom.
- **`modes.js`**: the three layout modes (layered/force/3d) each register
  one interface (`activate/deactivate/show/hide/onLayout/onState/fit/
  followFrontier/focusPkg/resize`). Never branch on `App.layoutMode`
  outside a mode implementation; call `mode().method?.()`.

The import graph is frozen in `scripts/check-frontend.py`; a new
cross-module import fails CI unless added there deliberately.

## Development

- The systemd user service runs an **editable pipx install** of this
  checkout. Frontend edits: reload the browser (server sends no-store).
  Server edits: `systemctl --user restart colcon-dashboard`.
- Tests: `python3 -m unittest discover -s tests` (stdlib only, no pytest).
  `tests/helpers.py` builds colcon-shaped fixture logs; extend those when
  covering new event formats.
- Frontend check: `python3 scripts/check-frontend.py`.
- Conventional commits (`type(scope): description`).
