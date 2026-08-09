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
