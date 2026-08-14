#!/usr/bin/env python3
"""Static checks for the frontend ES modules.

Fails when an import is broken (name not exported by its source, module
missing, duplicate export names) or when a module grows a dependency edge
that is not in the frozen graph below. The graph is the architecture:
modules communicate sideways through bus.js events and the modes.js
interface, not through new imports. To add an edge on purpose, add it
here in the same commit.
"""

import os
import re
import sys

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      os.pardir, "colcon_dashboard", "static")

# module -> modules it may import from (kept sorted)
ALLOWED = {
    'ai': ['bus', 'dock', 'state', 'util'],
    'ansi': [],
    'app': ['ai', 'bus', 'camera', 'dock', 'g3d', 'gantt', 'gsearch',
            'header', 'help', 'modes', 'notify', 'pickers', 'poller',
            'state', 'theme', 'util', 'views'],
    'bus': [],
    # camera/force/graph/g3d/gsearch are one subsystem (the graph views)
    # and may import each other; only hoisted functions cross at load time
    'camera': ['bus', 'force', 'graph', 'modes', 'state', 'util'],
    'dock': ['ansi', 'bus', 'camera', 'graph', 'modes', 'state', 'toasts',
             'util'],
    'force': ['camera', 'graph', 'modes', 'state'],
    'g3d': ['bus', 'camera', 'force', 'graph', 'gsearch', 'modes', 'state',
            'util'],
    'gantt': ['bus', 'graph', 'gsearch', 'state', 'util'],
    'graph': ['bus', 'camera', 'gsearch', 'modes', 'state', 'util'],
    'gsearch': ['camera', 'state', 'util'],
    'header': ['bus', 'state', 'util'],
    'help': ['util'],
    'modes': ['state'],
    'notify': ['bus', 'state', 'util'],
    'pickers': ['graph', 'header', 'state', 'toasts', 'util'],
    'poller': ['bus', 'header', 'modes', 'state', 'toasts', 'util'],
    'state': [],
    'theme': ['bus', 'util'],
    'toasts': ['util'],
    'util': [],
    'views': ['bus', 'camera', 'force', 'gantt', 'graph', 'modes', 'state',
              'util'],
}

IMPORT_RE = re.compile(
    r"^import (?:\{ ([^}]+) \} from )?'\./([\w.]+)\.js';", re.M)
EXPORT_RE = re.compile(
    r"^export (?:async )?(?:function|const|let|class) ([\w$]+)", re.M)


def main():
    errors = []
    files = sorted(f[:-3] for f in os.listdir(STATIC) if f.endswith(".js"))

    exports = {}
    imports = {}
    for mod in files:
        src = open(os.path.join(STATIC, mod + ".js")).read()
        imports[mod] = []
        for m in IMPORT_RE.finditer(src):
            names = [n.strip() for n in m.group(1).split(",")] if m.group(1) else []
            imports[mod].append((m.group(2), names))
        for m in EXPORT_RE.finditer(src):
            name = m.group(1)
            if name in exports:
                errors.append("duplicate export '%s' in %s.js and %s.js"
                              % (name, exports[name], mod))
            exports[name] = mod

    known = set(files)
    for mod in files:
        if mod not in ALLOWED:
            errors.append("%s.js is not in the frozen module list" % mod)
            continue
        for frm, names in imports[mod]:
            if frm not in known:
                errors.append("%s.js imports missing module %s.js" % (mod, frm))
                continue
            if frm == mod:
                errors.append("%s.js imports itself" % mod)
            if frm not in ALLOWED[mod]:
                errors.append(
                    "%s.js -> %s.js is a new dependency edge; use a bus "
                    "event or the mode interface, or add the edge to "
                    "ALLOWED deliberately" % (mod, frm))
            for n in names:
                if exports.get(n) != frm:
                    errors.append("%s.js imports '%s' from %s.js, but it is "
                                  "exported by %s" %
                                  (mod, n, frm, exports.get(n)))
    stale = set(ALLOWED) - known
    for mod in sorted(stale):
        errors.append("ALLOWED lists %s.js, which no longer exists" % mod)

    for e in errors:
        print("ERROR:", e)
    n_edges = sum(len(v) for v in imports.values())
    print("%d modules, %d import edges, %d exports: %s"
          % (len(files), n_edges, len(exports),
             "FAIL" if errors else "OK"))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
