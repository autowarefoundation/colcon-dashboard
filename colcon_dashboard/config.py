"""The server configuration file, read once at startup.

~/.config/colcon-dashboard/config.ini (configparser format; YAML would
need a dependency, and tomllib needs Python 3.11). Every value is
optional, and the command line always wins:

    [server]
    host = 0.0.0.0
    port = 8642
    log_base = log
    check_updates = true

    [builds]
    auto_prune_keep = 10

    [ai]
    claude_bin = /custom/path/claude

    [ui]
    editor_url = vscode://file{path}:{line}

A missing file, a broken file, or a bad value must never stop the
server: unreadable values resolve to None, like missing ones.
"""

import configparser
import os


def config_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config")
    return os.path.join(base, "colcon-dashboard", "config.ini")


class Config:
    """A typed view over the ini file; unset keys resolve to None."""

    def __init__(self, path=None):
        self.path = path or config_path()
        cp = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
        try:
            self.exists = bool(cp.read(self.path))
        except (configparser.Error, OSError, UnicodeDecodeError):
            # a broken file behaves like a missing one: half-applied
            # values, with every diagnostic denying them, would be worse
            cp = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
            self.exists = False
        self.host = self._get(cp, "server", "host")
        self.port = self._get_int(cp, "server", "port")
        self.log_base = self._get(cp, "server", "log_base")
        self.check_updates = bool(self._get_bool(cp, "server",
                                                 "check_updates"))
        self.auto_prune_keep = self._get_int(cp, "builds", "auto_prune_keep")
        self.claude_bin = self._get(cp, "ai", "claude_bin")
        self.editor_url = self._get(cp, "ui", "editor_url")

    @staticmethod
    def _get(cp, section, key):
        try:
            value = cp.get(section, key).strip()
        except (configparser.Error, ValueError):
            return None
        return value or None

    @classmethod
    def _get_int(cls, section_cp, section, key):
        value = cls._get(section_cp, section, key)
        if value is None:
            return None
        try:
            return int(value)
        except ValueError:
            return None

    @classmethod
    def _get_bool(cls, cp, section, key):
        value = cls._get(cp, section, key)
        if value is None:
            return None
        return value.lower() in ("1", "true", "yes", "on")


CONFIG = Config()
