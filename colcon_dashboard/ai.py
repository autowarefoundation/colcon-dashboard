"""AI failure analysis: shell out to the claude CLI when it is installed."""

import json
import os
import shutil
import subprocess
import threading

from .config import CONFIG


def _find_claude():
    """The claude CLI: the config file wins, then PATH, then
    ~/.local/bin, which is not on the systemd user PATH."""
    if CONFIG.claude_bin:
        cand = os.path.expanduser(CONFIG.claude_bin)
        if os.access(cand, os.X_OK):
            return cand
    found = shutil.which("claude")
    if found:
        return found
    cand = os.path.join(os.path.expanduser("~"), ".local", "bin", "claude")
    return cand if os.access(cand, os.X_OK) else None


CLAUDE_BIN = _find_claude()
AI_FILE = "claude-analysis.json"
AI_DIM = "\x1b[90m"
AI_BOLD = "\x1b[1m"
AI_RESET = "\x1b[0m"


class AIAnalysis:
    """One claude CLI conversation about one package's failure.

    The transcript accumulates in memory and persists next to the package's
    logs, so a finished analysis survives a server restart. The saved session
    id lets --resume turn the analysis into a conversation.
    """

    def __init__(self, workspace, build_dir, pkg):
        self.workspace = workspace
        self.build_dir = build_dir
        self.pkg = pkg
        self.lock = threading.Lock()
        self.buf = b""
        self.running = False
        self.session_id = None
        try:
            with open(self._path()) as f:
                d = json.load(f)
            self.buf = d.get("text", "").encode()
            self.session_id = d.get("session_id")
        except (OSError, ValueError):
            pass

    def _path(self):
        return os.path.join(self.build_dir, self.pkg, AI_FILE)

    def _append(self, text):
        with self.lock:
            self.buf += text.encode()

    def read(self, offset):
        with self.lock:
            size = len(self.buf)
            reset = offset < 0 or offset > size
            if reset:
                offset = 0
            data = self.buf[offset:size].decode("utf-8", "replace")
        return {"size": size, "start": 0, "offset": size, "data": data,
                "reset": reset, "running": self.running}

    def start(self, prompt, resume, label):
        with self.lock:
            if self.running:
                return False
            self.running = True
        threading.Thread(target=self._run, args=(prompt, resume, label),
                         daemon=True).start()
        return True

    def _run(self, prompt, resume, label):
        timer = None
        try:
            lead = "\n" if self.buf else ""
            self._append(f"{lead}{AI_BOLD}❯ {label}{AI_RESET}\n\n")
            cmd = [CLAUDE_BIN]
            if resume and self.session_id:
                cmd += ["--resume", self.session_id]
            cmd += ["-p", prompt, "--output-format", "stream-json",
                    "--verbose", "--allowedTools", "Read,Grep,Glob",
                    "--max-turns", "16"]
            proc = subprocess.Popen(
                cmd, cwd=self.workspace, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                text=True, errors="replace")
            timer = threading.Timer(600, proc.kill)  # a hung run dies here
            timer.start()
            first = True
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                t = msg.get("type")
                if t in ("system", "result"):
                    self.session_id = msg.get("session_id") or self.session_id
                    if t == "result":
                        secs = round((msg.get("duration_ms") or 0) / 1000)
                        self._append(f"\n{AI_DIM}─ answered in {secs}s"
                                     f" · ask a follow-up below"
                                     f"{AI_RESET}\n")
                elif t == "assistant":
                    for block in (msg.get("message") or {}).get("content", []):
                        if block.get("type") == "text":
                            text = block.get("text", "").strip()
                            if text:
                                self._append(("" if first else "\n")
                                             + text + "\n")
                                first = False
                        elif block.get("type") == "tool_use":
                            arg = block.get("input") or {}
                            hint = (arg.get("file_path") or arg.get("command")
                                    or arg.get("pattern") or arg.get("path")
                                    or "")
                            hint = " ".join(str(hint).split())[:100]
                            name = block.get("name", "tool")
                            self._append(f"{AI_DIM}  → {name} {hint}"
                                         f"{AI_RESET}\n")
            rc = proc.wait()
            if rc != 0:
                self._append(f"{AI_DIM}claude exited with rc {rc}"
                             f"{AI_RESET}\n")
        except Exception as exc:
            self._append(f"{AI_DIM}analysis failed: {exc}{AI_RESET}\n")
        finally:
            if timer is not None:
                timer.cancel()
            self.running = False
            try:
                with open(self._path(), "w") as f:
                    json.dump({"text": self.buf.decode("utf-8", "replace"),
                               "session_id": self.session_id}, f)
            except OSError:
                pass
