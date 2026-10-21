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

    [discover]
    extra_roots = /mnt/data, ~/ros

    [notify]
    command = notify-send "colcon {outcome}" "{name}: {summary}"

A missing file, a broken file, or a bad value must never stop the
server: unreadable values resolve to None, like missing ones.
"""

import configparser
import os
import re


def config_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config")
    return os.path.join(base, "colcon-dashboard", "config.ini")


TEMPLATE = """\
# colcon-dashboard configuration.
# Every key is optional and shown with its default; the command line
# always wins. Uncomment a key to change it, then restart the server
# (colcon-dashboard --restart-service when it runs as a service).

[server]
# The bind address. 0.0.0.0 serves the dashboard to your network.
#host = 127.0.0.1

# The HTTP port.
#port = 8642

# The log directory colcon writes, relative to each workspace.
#log_base = log

# Check PyPI once a day for a newer version and show a note in the
# workspace picker.
#check_updates = false

[builds]
# After a build finishes, delete old runs, keeping the newest N of
# each kind (build_*/test_*). Unset or -1: never delete anything.
# For example 10 keeps the newest 10 builds and 10 test runs.
#auto_prune_keep = -1

[ai]
# The claude CLI used for failure analysis (default: found on PATH).
#claude_bin = /path/to/claude

[ui]
# Turn file:line references in failure logs into editor links.
# Placeholders: {path}, {line}, {line0} (= {line} - 1), and
# {project} (the workspace directory name). Unset: no links.
#editor_url = vscode://file{path}:{line}
# JetBrains IDEs need the open project's name and count lines from
# zero, hence {project} and {line0}:
#editor_url = jetbrains://clion/navigate/reference?project={project}&path={path}:{line0}

[discover]
# More directories for the workspace scan, next to your home directory.
# Separate them with commas or newlines. ~ expands to your home.
#extra_roots = /mnt/data, ~/ros

[notify]
# A command to run when a build ends, also with no dashboard page open.
# It runs for the workspaces that the server watches. The server does not
# use a shell: it splits the line into arguments, then fills them in.
# Placeholders: {workspace}, {name} (the workspace directory name),
# {build}, {outcome} (passed, failed, or aborted), {summary}, {failed}.
#command = notify-send "colcon {outcome}" "{name}: {summary}"
# A webhook works through curl:
#command = curl -s -X POST -d "{name}: {summary}" https://example.com/hook
"""


def write_template(path=None):
    """Write a fully commented template so the keys are discoverable.

    The CLI calls this when no config file exists. Mode "x" never
    clobbers a file that appeared meanwhile, and any failure returns
    None: the template is a convenience, never a requirement.
    """
    path = path or config_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "x") as f:
            f.write(TEMPLATE)
    except OSError:
        return None
    return path


def save_extra_roots(roots, path=None):
    """Write roots as the [discover] extra_roots line of the ini file.

    Edits that one line in place, so every comment and every other key
    stays as the user wrote it. A missing file starts from the template.
    Returns the written path, or None when the write fails.
    """
    path = path or config_path()
    try:
        with open(path) as f:
            lines = f.read().splitlines(keepends=True)
    except FileNotFoundError:
        lines = TEMPLATE.splitlines(keepends=True)
    except (OSError, UnicodeDecodeError):
        return None
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    new = "extra_roots = %s\n" % ", ".join(roots)
    head = next((i for i, ln in enumerate(lines)
                 if ln.strip().lower() == "[discover]"), None)
    if head is None:
        lines += ["\n", "[discover]\n", new]
    else:
        end = next((i for i in range(head + 1, len(lines))
                    if lines[i].startswith("[")), len(lines))
        key = re.compile(r"extra_roots\s*[=:]")
        at = next((i for i in range(head + 1, end)
                   if key.match(lines[i])), None)
        if at is not None:
            stop = at + 1  # an indented line continues the value
            while stop < end and lines[stop].strip() and \
                    lines[stop][0] in " \t":
                stop += 1
            lines[at:stop] = [new]
        else:
            # below the commented example, else under the header
            hint = [i for i in range(head + 1, end)
                    if re.match(r"#\s*extra_roots", lines[i])]
            lines.insert((hint[-1] if hint else head) + 1, new)
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w") as f:
            f.write("".join(lines))
        os.replace(tmp, path)  # a crash mid-write never truncates it
    except OSError:
        return None
    return path


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
        self.extra_roots = self._get_list(cp, "discover", "extra_roots")
        self.notify_command = self._get(cp, "notify", "command")

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
    def _get_list(cls, cp, section, key):
        """Comma- or newline-separated paths, ~-expanded; unset: []."""
        value = cls._get(cp, section, key)
        if value is None:
            return []
        return [os.path.expanduser(v.strip())
                for v in re.split(r"[,\n]", value) if v.strip()]

    @classmethod
    def _get_bool(cls, cp, section, key):
        value = cls._get(cp, section, key)
        if value is None:
            return None
        return value.lower() in ("1", "true", "yes", "on")


CONFIG = Config()
