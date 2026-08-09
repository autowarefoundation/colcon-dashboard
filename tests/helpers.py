"""Shared fixture builders: colcon-shaped log files in temp workspaces."""

import os


def event_line(t, name, event, payload="{}"):
    """One events.log line in colcon's format."""
    return "[{:.6f}] ({}) {}: {}\n".format(t, name, event, payload).encode()


def queued(t, name, deps=()):
    """JobQueued with a dict-repr recursive dependency set."""
    body = ", ".join("'{}': '/ws/install/{}'".format(d, d) for d in deps)
    return event_line(t, name, "JobQueued",
                      "{{'identifier': '{}', 'dependencies': {{{}}}}}"
                      .format(name, body))


def started(t, name):
    return event_line(t, name, "JobStarted", "{{'identifier': '{}'}}".format(name))


def ended(t, name, rc=0):
    rc_repr = "'{}'".format(rc) if isinstance(rc, str) else rc
    return event_line(t, name, "JobEnded",
                      "{{'identifier': '{}', 'rc': {}}}".format(name, rc_repr))


def stdout_line(t, name, text):
    return event_line(t, name, "StdoutLine", "{{'line': {!r}}}".format(text.encode()))


def stderr_line(t, name, text):
    return event_line(t, name, "StderrLine", "{{'line': {!r}}}".format(text.encode()))


def make_build(ws, build_id, events, mtime=None):
    """Create ws/log/<build_id>/events.log with the given bytes."""
    bdir = os.path.join(ws, "log", build_id)
    os.makedirs(bdir, exist_ok=True)
    path = os.path.join(bdir, "events.log")
    with open(path, "wb") as f:
        f.write(b"".join(events))
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return bdir
