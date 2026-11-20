"""Workspace package discovery: package.xml metadata and the full
workspace dependency graph, plus colcon's parsed command line."""

import ast
import math
import os
import re
import time
import xml.etree.ElementTree as ET

NAMESPACE_RE = re.compile(r"Parsed command line arguments: Namespace\((?P<body>.*)\)\s*$")
NS_FIELD_RE = re.compile(r"(\w+)=(\[[^\]]*\]|'(?:[^'\\]|\\.)*'|True|False|None|-?\d+)")

DEP_TAGS = ("buildtool_depend", "build_depend", "depend", "exec_depend", "run_depend")


class PackageIndex:
    """All packages found under the workspace's base paths, with direct deps."""

    PRUNE_NAMES = {"build", "install", "log", "node_modules", "__pycache__"}

    def __init__(self, workspace):
        self.workspace = workspace
        self.packages = {}  # name -> {path, deps:set, build_type}
        self.scanned_at = 0.0

    def scan(self, base_paths):
        pkgs = {}
        roots = []
        for base in base_paths or ["."]:
            root = os.path.normpath(os.path.join(self.workspace, base))
            if not os.path.isdir(root) and os.path.isabs(base):
                # a path from inside a container, such as /ws/src when the
                # workspace is mounted at /ws: drop leading parts until the
                # rest exists here (src), down to the workspace itself
                parts = os.path.normpath(base).split(os.sep)[1:]
                for i in range(1, len(parts) + 1):
                    root = os.path.join(self.workspace, *parts[i:])
                    if os.path.isdir(root):
                        break
            roots.append(os.path.normpath(root))
        for root in roots:
            if not os.path.isdir(root):
                continue
            for dirpath, dirnames, filenames in os.walk(root):
                rel = os.path.relpath(dirpath, self.workspace)
                depth = 0 if rel == "." else rel.count(os.sep) + 1
                if depth > 14:
                    dirnames[:] = []
                    continue
                dirnames[:] = [
                    d for d in dirnames
                    if not d.startswith(".") and d not in self.PRUNE_NAMES
                ]
                if "COLCON_IGNORE" in filenames:
                    dirnames[:] = []
                    continue
                if "package.xml" not in filenames:
                    continue
                info = self._parse_package_xml(os.path.join(dirpath, "package.xml"))
                if info:
                    name, deps, build_type = info
                    if name not in pkgs:
                        pkgs[name] = {
                            "path": os.path.relpath(dirpath, self.workspace),
                            "deps": deps,
                            "build_type": build_type,
                        }
                dirnames[:] = []  # a package dir does not nest further packages
        for name, info in pkgs.items():
            info["deps"] = {d for d in info["deps"] if d in pkgs and d != name}
        self.packages = pkgs
        self.scanned_at = time.time()

    def dep_closure(self, name, _memo=None):
        memo = _memo if _memo is not None else {}
        if name in memo:
            return memo[name]
        memo[name] = set()  # cycle guard
        out = set()
        for d in self.packages.get(name, {}).get("deps", ()):
            out.add(d)
            out |= self.dep_closure(d, memo)
        memo[name] = out
        return out

    @staticmethod
    def _parse_package_xml(path):
        try:
            tree = ET.parse(path)
        except (ET.ParseError, OSError):
            return None
        root = tree.getroot()
        name_el = root.find("name")
        if name_el is None or not (name_el.text or "").strip():
            return None
        name = name_el.text.strip()
        deps = set()
        for tag in DEP_TAGS:
            for el in root.findall(tag):
                if el.text and el.text.strip():
                    deps.add(el.text.strip())
        build_type = "ament_cmake"
        export = root.find("export")
        if export is not None:
            bt = export.find("build_type")
            if bt is not None and bt.text:
                build_type = bt.text.strip()
        return name, deps, build_type


# colcon options worth showing, in the order they are shown, with their
# defaults: a build differs from the last one in these
SHOWN_ARGS = (
    ("packages_select", None), ("packages_up_to", None), ("packages_above", None),
    ("packages_skip", None), ("packages_select_regex", None),
    ("packages_skip_regex", None), ("packages_up_to_regex", None),
    ("packages_select_build_failed", False), ("packages_skip_build_finished", False),
    ("packages_select_test_failures", False), ("packages_skip_test_passed", False),
    ("mixin", None), ("symlink_install", False), ("merge_install", False),
    ("continue_on_error", False), ("cmake_clean_cache", False),
    ("cmake_clean_first", False), ("cmake_force_configure", False),
    ("cmake_args", None),
)


def arg_options(ns):
    """The command line options that differ from colcon's defaults, one
    list of words per option: [["--symlink-install"], ["--mixin", "release",
    "ccache"]]."""
    out = []
    for key, default in SHOWN_ARGS if ns else ():
        value = ns.get(key, default)
        if value == default or value in (None, [], ()):
            continue
        flag = "--" + key.replace("_", "-")
        if value is True:
            out.append([flag])
        elif isinstance(value, (list, tuple)):
            out.append([flag] + [str(v) for v in value])
        else:
            out.append([flag, str(value)])
    return out


def summarize_args(ns):
    """The options of arg_options as one short string:
    "--packages-up-to foo --mixin release ccache"."""
    return " ".join(" ".join(words) for words in arg_options(ns))


def parse_namespace(logger_path):
    """Extract simple fields of colcon's 'Parsed command line arguments' line."""
    try:
        with open(logger_path, "r", errors="replace") as f:
            head = f.read(512 * 1024)
    except OSError:
        return None
    for line in head.splitlines():
        m = NAMESPACE_RE.search(line)
        if not m:
            continue
        fields = {}
        for key, raw in NS_FIELD_RE.findall(m.group("body")):
            try:
                fields[key] = ast.literal_eval(raw)
            except (ValueError, SyntaxError):
                pass
        return fields
    return None


def _xml_files(paths):
    for path in paths:
        if os.path.isfile(path):
            yield path
        for dirpath, _dirnames, filenames in os.walk(path):
            for fn in sorted(filenames):
                if fn.endswith(".xml"):
                    yield os.path.join(dirpath, fn)


def _test_cases(paths):
    """The <testcase> elements of the JUnit XML files in paths (folders
    to walk, or single files), the files that `colcon test-result` reads.

    Returns (files, cases), or None when no file parses. A case is a
    dict: n (the name), d (seconds), bad ("failure", "error", or None),
    skip, and for a bad case m (the message), x (the failure text), and
    out (the output that the test runner captured)."""
    files, cases = [], []
    for path in _xml_files(paths):
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError):
            continue
        files.append(path)
        for case in root.iter("testcase"):
            try:
                sec = max(0.0, float(case.get("time") or 0))
            except ValueError:
                sec = 0.0
            if not math.isfinite(sec):  # "inf" is not valid JSON
                sec = 0.0
            kind, bad = "failure", case.find("failure")
            if bad is None:
                kind, bad = "error", case.find("error")
            c = {"n": ".".join(x for x in (case.get("classname"), case.get("name")) if x),
                 "d": sec, "bad": kind if bad is not None else None,
                 "skip": case.find("skipped") is not None}
            if bad is not None:
                c["m"] = (bad.get("message") or "").strip()
                c["x"] = (bad.text or "").strip()
                c["out"] = "\n".join(t for t in (
                    (case.findtext("system-out") or "").strip(),
                    (case.findtext("system-err") or "").strip()) if t)
            cases.append(c)
    return (files, cases) if files else None


def read_test_results(paths, max_failures=20):
    """Counts, the test time in seconds, and the first failed cases from
    the JUnit XML files in paths. None when there are none."""
    found = _test_cases(paths)
    if found is None:
        return None
    cases = found[1]
    failing = []
    for c in cases:
        if c["bad"] and len(failing) < max_failures:
            msg = (c["m"] or c["x"]).splitlines()
            failing.append({"n": c["n"], "m": (msg[0] if msg else "")[:200]})
    return {"t": len(cases),
            "f": sum(c["bad"] == "failure" for c in cases),
            "e": sum(c["bad"] == "error" for c in cases),
            "s": sum(c["skip"] for c in cases),
            "d": round(sum(c["d"] for c in cases), 1),
            "fail": failing}


REPORT_FULL = 200        # failed tests with their full text in the report
REPORT_TEXT = 16 * 1024  # characters of one failure's text in the report


def _cut(text):
    if len(text) <= REPORT_TEXT:
        return text
    return text[:REPORT_TEXT] + f"\n[{len(text) - REPORT_TEXT} more characters cut]"


def junit_report(paths, base=None):
    """The JUnit results in paths as plain text for a log pane: the
    counts, each failed test with its full text, and every test with its
    time, the slowest first. None when there are no results."""
    found = _test_cases(paths)
    if found is None:
        return None
    files, cases = found
    bad = [c for c in cases if c["bad"]]
    skipped = sum(c["skip"] for c in cases)
    passed = sum(not c["bad"] and not c["skip"] for c in cases)
    parts = [f"{passed} passed"]
    for n, word in ((sum(c["bad"] == "failure" for c in cases), "failed"),
                    (sum(c["bad"] == "error" for c in cases), "errors"),
                    (skipped, "skipped")):
        if n:
            parts.append(f"{n} {word}")
    out = [f"{len(cases)} tests: {', '.join(parts)}. "
           f"Test time {sum(c['d'] for c in cases):.2f} s.",
           "From the JUnit files of the last colcon test run of this package:"]
    for f in files:  # relative to the workspace, when the file is in it
        rel = os.path.relpath(f, base) if base else f
        out.append("  " + (f if rel.startswith(os.pardir + os.sep) else rel))
    if bad:
        out += ["", f"Failed tests ({len(bad)})"]
        for c in bad[:REPORT_FULL]:
            out += ["", f"{'FAILED' if c['bad'] == 'failure' else 'ERROR'}  "
                        f"{c['n']}  ({c['d']:.2f} s)"]
            if c["m"] and c["m"] not in c["x"]:
                out.append(_cut(c["m"]))
            if c["x"]:
                out.append(_cut(c["x"]))
            if c["out"]:
                out += ["Captured output:", _cut(c["out"])]
        if len(bad) > REPORT_FULL:
            out += ["", f"{len(bad) - REPORT_FULL} more failed tests: "
                        "the list below has their names."]
    out += ["", f"All tests ({len(cases)}), the slowest first"]
    status = {"failure": "FAILED", "error": "ERROR"}
    for c in sorted(cases, key=lambda c: -c["d"]):
        st = status.get(c["bad"]) or ("skipped" if c["skip"] else "passed")
        out.append(f"{c['d']:10.2f} s  {st:<7}  {c['n']}")
    return "\n".join(out) + "\n"

