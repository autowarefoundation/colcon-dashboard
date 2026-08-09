"""colcon event handler that spawns the dashboard when a build starts.

Loaded by colcon through the `colcon_core.event_handler` entry point, so a
plain `colcon build` brings the dashboard up (or reuses the one that already
watches the workspace). Disable for one run with
`--event-handlers mission_control-`, or globally with
`COLCON_MISSION_CONTROL=0`.
"""

import os

from colcon_core.event_handler import EventHandlerExtensionPoint
from colcon_core.plugin_system import satisfies_version


class MissionControlEventHandler(EventHandlerExtensionPoint):
    """Serve a live web dashboard for this build."""

    def __init__(self):  # noqa: D107
        super().__init__()
        satisfies_version(
            EventHandlerExtensionPoint.EXTENSION_POINT_VERSION, "^1.0")
        self._done = False

    def __call__(self, event):  # noqa: D102
        if self._done:
            return
        self._done = True
        if os.environ.get("COLCON_MISSION_CONTROL", "").lower() in (
                "0", "no", "false", "off"):
            return
        args = getattr(self.context, "args", None)
        if getattr(args, "verb_name", None) != "build":
            return
        try:
            # imported lazily: never let the dashboard break a build
            from colcon_mission_control.server import ensure_running
            url, _started = ensure_running(os.getcwd())
            if url:
                print(f"[mission-control] dashboard: {url}")
        except Exception:  # noqa: BLE001
            pass
