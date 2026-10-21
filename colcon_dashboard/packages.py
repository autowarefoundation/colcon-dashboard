"""Workspace package discovery: package.xml metadata and the full
workspace dependency graph, plus colcon's parsed command line."""

import ast
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
        for base in base_paths or ["."]:
            root = os.path.normpath(os.path.join(self.workspace, base))
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


def summarize_args(ns):
    """The command line options that differ from colcon's defaults, as one
    short string: "--packages-up-to foo --mixin release ccache"."""
    if not ns:
        return ""
    out = []
    for key, default in SHOWN_ARGS:
        value = ns.get(key, default)
        if value == default or value in (None, [], ()):
            continue
        flag = "--" + key.replace("_", "-")
        if value is True:
            out.append(flag)
        elif isinstance(value, (list, tuple)):
            out.append(flag + " " + " ".join(str(v) for v in value))
        else:
            out.append(f"{flag} {value}")
    return " ".join(out)


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


def read_test_results(paths, max_failures=20):
    """Counts and failing cases from the JUnit XML files in paths (folders
    to walk, or single files), the files that `colcon test-result` reads.
    None when there are none."""
    total = failures = errors = skipped = 0
    failing = []
    found = False
    for path in _xml_files(paths):
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError):
            continue
        found = True
        for case in root.iter("testcase"):
            total += 1
            bad = case.find("failure")
            if bad is None:
                bad = case.find("error")
                if bad is not None:
                    errors += 1
            else:
                failures += 1
            if case.find("skipped") is not None:
                skipped += 1
            if bad is not None and len(failing) < max_failures:
                name = ".".join(x for x in (case.get("classname"), case.get("name")) if x)
                msg = (bad.get("message") or bad.text or "").strip().splitlines()
                failing.append({"n": name, "m": (msg[0] if msg else "")[:200]})
    if not found:
        return None
    return {"t": total, "f": failures, "e": errors, "s": skipped, "fail": failing}

