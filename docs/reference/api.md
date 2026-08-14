---
icon: lucide/plug
description: >-
  The HTTP API of the Colcon Dashboard server: workspace registry, build
  state, dependency graph, log streaming, and AI analysis endpoints.
---

# HTTP API

Workspace endpoints take a `ws=<path>` query parameter. Add `build=<build id>` to read an older build.

| Endpoint | Returns |
|---|---|
| `/api/workspaces` | The recent workspaces, with live build info where known |
| `/api/config` | The server version and the loaded config values |
| `/api/discover` | Colcon workspaces found under the home directory |
| `/api/register?ws=` (POST) | Registers a workspace, like opening it in the page |
| `/api/favorite?ws=&fav=1` (POST) | Pins or unpins a workspace |
| `/api/builds/delete?ws=&build=` (POST) | Deletes the logs of one build |
| `/api/builds/prune?ws=&keep=3` (POST) | Deletes all but the newest runs of each kind |
| `/api/state?ws=` | Job states, counts, timings, build metadata |
| `/api/graph?ws=` | Direct dependency edges for the graph views |
| `/api/builds?ws=` | The `build_*` and `test_*` runs under the log base, plus the latest and pinned ids |
| `/api/log/<pkg>?ws=&offset=N&file=streams` | A log chunk from byte `N`, plus the new offset |
| `/api/buildlog?ws=&offset=N` | A chunk of the combined build log, same shape |
| `/api/analyze/<pkg>?ws=&q=` (POST) | Starts an AI analysis of a failed package, or asks a follow-up |
| `/api/analysis/<pkg>?ws=&offset=N` | The analysis transcript from byte `N`, plus a running flag |
| `/api/stop` (POST) | Stops the server, like `colcon-dashboard --stop` |

The server trusts the local workspace. Do not expose the port to an untrusted network.
