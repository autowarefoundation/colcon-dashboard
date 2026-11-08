---
icon: lucide/plug
description: >-
  The HTTP API of the Colcon Dashboard server: workspace registry, build
  state, dependency graph, log streaming, and AI analysis endpoints.
---

# HTTP API

Workspace endpoints take a `ws=<path>` query parameter. Add `build=<build id>` to read an older build.

The server refuses requests that a web page on another site sends. It answers `403` in these cases:

- A POST with an `Origin` header that differs from the server's own address, or with `Sec-Fetch-Site: cross-site`. Without this check, any open web page could delete build logs or stop the server.
- Any request with a `Host` header that names another machine. The header must be an IP address, `localhost`, or the host name of this machine. This check blocks DNS rebinding (a foreign domain name that points at `127.0.0.1`).

Clients that send no `Origin` header, such as `curl` and the `colcon-dashboard` command, pass.

| Endpoint | Returns |
|---|---|
| `/api/workspaces` | The recent workspaces, with live build info where known |
| `/api/config` | The server version and the loaded config values |
| `/api/discover` | Colcon workspaces found under the home directory and the scan roots |
| `/api/scan-roots` | The home directory, the `extra_roots` list, and the config.ini path |
| `/api/scan-roots/set?path=&path=` (POST) | Replaces the `extra_roots` list in config.ini. A new path must be a directory |
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
| `/api/ping` | The app name, the process id, the version, and the start time of the server |
| `/api/live` | The live build of each watched workspace, for the tray icon |
| `/api/server` | The service state: start at login, the tray icon, and how the server runs |
| `/api/server/restart` (POST) | Restarts the server |
| `/api/server/login?on=1` (POST) | Turns the start at login on or off |
| `/api/server/tray?on=1` (POST) | Turns the tray icon on or off |
| `/api/notify?mode=` (POST) | Sets the notifications: `off`, `on`, or `sound` |
| `/api/notify/test` (POST) | Sends a test notification |
| `/api/client-error` (POST) | A page that fails to start reports its error here. The server writes it to its log |
| `/last` | Redirects to the page of the workspace that was open last |

The server trusts the local workspace. Do not expose the port to an untrusted network.
