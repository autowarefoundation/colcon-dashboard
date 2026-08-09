"""colcon event handler that spawns the dashboard when a build starts.

Loaded by colcon through the `colcon_core.event_handler` entry point. The
handler is off by default: enable it for one build with
`--event-handlers dashboard+`, for every build with
`COLCON_DASHBOARD=1`, or through `~/.colcon/defaults.yaml`. The
command line toggle always wins over the environment default.
"""

import os

from colcon_core.event_handler import EventHandlerExtensionPoint
from colcon_core.plugin_system import satisfies_version


class DashboardEventHandler(EventHandlerExtensionPoint):
    """Serve a live web dashboard for this build."""

    def __init__(self):  # noqa: D107
        super().__init__()
        satisfies_version(
            EventHandlerExtensionPoint.EXTENSION_POINT_VERSION, "^1.0")
        # off by default: starting a server must be a choice, not a surprise
        self.enabled = os.environ.get(
            "COLCON_DASHBOARD", "").lower() in ("1", "yes", "true", "on")
        self._done = False

    def __call__(self, event):  # noqa: D102
        if self._done:
            return
        self._done = True
        args = getattr(self.context, "args", None)
        if getattr(args, "verb_name", None) != "build":
            return
        try:
            # imported lazily: never let the dashboard break a build
            from colcon_dashboard.server import ensure_running
            url, _started = ensure_running(os.getcwd())
            if url:
                print(f"[colcon-dashboard] dashboard: {url}")
        except Exception:  # noqa: BLE001
            pass
