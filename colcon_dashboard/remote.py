"""Remote workspace URIs, SSH transport, and a sparse local mirror."""

from dataclasses import dataclass
import hashlib
import json
import os
import re
import select
import shlex
import shutil
import subprocess
import threading
import time
from urllib.parse import quote, unquote, urlsplit

from .monitor import LOG_FILES, BuildMonitor


REMOTE_SCHEMES = ("ssh", "docker+ssh")
AGENT_TIMEOUT = 30


class RemoteError(RuntimeError):
    pass


@dataclass(frozen=True)
class RemoteWorkspace:
    scheme: str
    host: str
    path: str
    user: str = None
    port: int = None
    container: str = None

    @property
    def target(self):
        return (self.user + "@" if self.user else "") + self.host

    @property
    def uri(self):
        host = self.host
        if ":" in host and not host.startswith("["):
            host = "[" + host + "]"
        netloc = (quote(self.user, safe="") + "@" if self.user else "") + host
        if self.port:
            netloc += ":" + str(self.port)
        if self.container:
            path = "/" + quote(self.container, safe="") + quote(self.path, safe="/")
        else:
            path = quote(self.path, safe="/")
        return self.scheme + "://" + netloc + path

    @property
    def label(self):
        where = self.target
        if self.container:
            where += "/" + self.container
        return where + ":" + self.path


def parse_remote_workspace(value):
    """Parse and canonicalize a remote workspace URI, or return None."""
    if not isinstance(value, str) or "://" not in value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in REMOTE_SCHEMES:
        return None
    if parsed.password is not None:
        raise ValueError("passwords are not allowed in remote workspace URIs")
    if parsed.query or parsed.fragment:
        raise ValueError("remote workspace URIs cannot contain a query or fragment")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid SSH port") from exc
    host = parsed.hostname
    if not host:
        raise ValueError("remote workspace URI has no SSH host")
    user = unquote(parsed.username) if parsed.username else None
    if host.startswith("-") or any(c.isspace() or ord(c) < 32 for c in host):
        raise ValueError("invalid SSH host")
    if user and (user.startswith("-") or not re.fullmatch(
            r"[A-Za-z0-9_.-]+", user)):
        raise ValueError("invalid SSH user")
    raw_path = unquote(parsed.path)
    if not raw_path.startswith("/"):
        raise ValueError("remote workspace path must be absolute")
    container = None
    path = raw_path
    if parsed.scheme == "docker+ssh":
        parts = raw_path.split("/")
        if len(parts) < 3 or not parts[1] or not parts[2]:
            raise ValueError(
                "Docker URI must be docker+ssh://host/container/absolute/path")
        container = parts[1]
        path = "/" + "/".join(parts[2:])
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", container):
            raise ValueError("invalid Docker container name")
    if "\x00" in path or "\r" in path or "\n" in path:
        raise ValueError("invalid remote workspace path")
    path = os.path.normpath(path)
    if not path.startswith("/"):
        raise ValueError("remote workspace path must be absolute")
    return RemoteWorkspace(parsed.scheme, host, path, user, port, container)


def canonical_workspace(value):
    remote = parse_remote_workspace(value)
    return remote.uri if remote else os.path.realpath(os.path.expanduser(value))


class SSHAgent:
    """One serialized request stream to an in-memory remote agent."""

    BOOTSTRAP = (
        "import sys; n=int(sys.stdin.buffer.readline()); "
        "s=sys.stdin.buffer.read(n); exec(compile(s,'<colcon-dashboard-agent>','exec'))"
    )

    def __init__(self, workspace, timeout=AGENT_TIMEOUT, command=None):
        self.workspace = workspace
        self.timeout = timeout
        self.command = command
        self.process = None
        self.lock = threading.Lock()
        self.request_id = 0
        self.last_error = None
        self.retry_at = 0
        self.backoff = 1

    def _agent_source(self):
        path = os.path.join(os.path.dirname(__file__), "remote_agent.py")
        with open(path, "rb") as f:
            return f.read()

    def _argv(self):
        if self.command:
            return list(self.command)
        if shutil.which("ssh") is None:
            raise RemoteError("OpenSSH client not found: install the ssh command")
        ws = self.workspace
        argv = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
        if ws.port:
            argv += ["-p", str(ws.port)]
        argv.append(ws.target)
        remote = ["python3", "-u", "-c", self.BOOTSTRAP]
        if ws.container:
            remote = ["docker", "exec", "-i", ws.container, *remote]
        # OpenSSH passes one command string to the remote user's shell.
        argv.append(shlex.join(remote))
        return argv

    def _start(self):
        now = time.time()
        if now < self.retry_at:
            raise RemoteError(self.last_error or "SSH reconnect pending")
        self.close()
        try:
            self.process = subprocess.Popen(
                self._argv(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, bufsize=0)
            source = self._agent_source()
            self.process.stdin.write(str(len(source)).encode() + b"\n" + source)
            self.process.stdin.flush()
            self._request_unlocked("init", root=self.workspace.path)
        except (OSError, subprocess.SubprocessError, RemoteError) as exc:
            self._failed(str(exc))
            raise RemoteError(str(exc)) from exc
        self.last_error = None
        self.backoff = 1

    def _failed(self, message):
        stderr = b""
        process = self.process
        if process and process.stderr:
            try:
                ready, _, _ = select.select([process.stderr], [], [], 0)
                if ready:
                    stderr = os.read(process.stderr.fileno(), 4096)
            except OSError:
                pass
        self.close()
        detail = stderr.decode("utf-8", "replace").strip()
        self.last_error = detail or message or "SSH connection closed"
        self.retry_at = time.time() + self.backoff
        self.backoff = min(30, self.backoff * 2)

    def _readline(self):
        process = self.process
        if not process or not process.stdout:
            raise RemoteError("SSH connection is not running")
        ready, _, _ = select.select([process.stdout], [], [], self.timeout)
        if not ready:
            raise RemoteError("remote operation timed out")
        line = process.stdout.readline()
        if not line:
            raise RemoteError("SSH connection closed")
        return line

    def _read_exact(self, size):
        chunks = []
        while size:
            ready, _, _ = select.select([self.process.stdout], [], [], self.timeout)
            if not ready:
                raise RemoteError("remote operation timed out")
            chunk = os.read(self.process.stdout.fileno(), size)
            if not chunk:
                raise RemoteError("SSH connection closed")
            chunks.append(chunk)
            size -= len(chunk)
        return b"".join(chunks)

    def _request_unlocked(self, op, **params):
        self.request_id += 1
        request = {"id": self.request_id, "op": op, **params}
        try:
            self.process.stdin.write(
                json.dumps(request, separators=(",", ":")).encode() + b"\n")
            self.process.stdin.flush()
            line = self._readline()
            try:
                response = json.loads(line)
            except ValueError as exc:
                shown = line.decode("utf-8", "replace").strip()[:200]
                raise RemoteError(
                    "unexpected output before the remote agent response: " + shown) from exc
            if response.get("id") != self.request_id:
                raise RemoteError("remote protocol response mismatch")
            data = self._read_exact(response.get("data_length", 0))
            if not response.get("ok"):
                raise RemoteError(response.get("error") or "remote operation failed")
            return response.get("result"), data
        except (OSError, ValueError, RemoteError) as exc:
            self._failed(str(exc))
            raise RemoteError(self.last_error) from exc

    def request(self, op, **params):
        with self.lock:
            if not self.process or self.process.poll() is not None:
                self._start()
            return self._request_unlocked(op, **params)

    def close(self):
        process, self.process = self.process, None
        if not process:
            return
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                stream.close()
            except (OSError, AttributeError):
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()

    def shutdown(self):
        with self.lock:
            self.close()


class RemoteMirror:
    """Small local tree containing only files needed by existing parsers."""

    def __init__(self, workspace, log_base="log", cache_root=None, command=None):
        self.workspace = workspace
        key = hashlib.sha256(workspace.uri.encode()).hexdigest()[:20]
        base = cache_root or os.path.join(os.path.expanduser("~"), ".cache",
                                          "colcon-dashboard", "remotes")
        self.root = os.path.join(base, key, "workspace")
        self.log_base = log_base
        os.makedirs(self.root, exist_ok=True)
        self.agent = SSHAgent(workspace, command=command)
        self.lock = threading.Lock()

    def _local(self, rel):
        rel = os.path.normpath(rel)
        if os.path.isabs(rel) or rel == os.pardir or rel.startswith(os.pardir + os.sep):
            raise RemoteError("invalid remote relative path")
        return os.path.join(self.root, rel)

    def _read_all(self, rel, size):
        parts, offset = [], 0
        while offset < size:
            result, data = self.agent.request(
                "read", path=rel, offset=offset,
                limit=min(8 * 1024 * 1024, size - offset))
            if result.get("missing"):
                raise RemoteError("remote file disappeared: " + rel)
            if not data and offset < size:
                raise RemoteError("short remote read: " + rel)
            parts.append(data)
            offset += len(data)
        return b"".join(parts)

    def _sync_entry(self, entry):
        rel, size, mtime = entry["path"], entry["size"], entry["mtime"]
        local = self._local(rel)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        if entry.get("content"):
            st = None
            try:
                st = os.stat(local)
                if st.st_size == size and abs(st.st_mtime - mtime) < 0.001:
                    return
            except OSError:
                pass
            appendable = os.path.basename(rel) in ("events.log", "logger_all.log")
            if st and appendable and 0 < st.st_size < size:
                offset = st.st_size
                with open(local, "ab") as f:
                    while offset < size:
                        result, data = self.agent.request(
                            "read", path=rel, offset=offset,
                            limit=min(8 * 1024 * 1024, size - offset))
                        if result.get("missing") or not data:
                            raise RemoteError("short remote read: " + rel)
                        f.write(data)
                        offset += len(data)
            else:
                data = self._read_all(rel, size)
                tmp = local + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, local)
        else:
            try:
                with open(local, "ab") as f:
                    f.truncate(size)
            except OSError as exc:
                raise RemoteError(str(exc)) from exc
        try:
            os.utime(local, (mtime, mtime))
        except OSError:
            pass

    def _links(self, manifest):
        log = os.path.join(self.root, self.log_base)
        os.makedirs(log, exist_ok=True)
        for link in ("latest_build", "latest_test"):
            target = manifest.get(link)
            path = os.path.join(log, link)
            try:
                if os.path.lexists(path):
                    os.unlink(path)
                if target:
                    os.symlink(target, path)
            except OSError:
                pass

    def sync(self, history=False):
        with self.lock:
            manifest, _ = self.agent.request(
                "manifest", log_base=self.log_base, history=history)
            self._links(manifest)
            for name in manifest.get("runs", []):
                os.makedirs(os.path.join(self.root, self.log_base, name), exist_ok=True)
            if history:
                log = os.path.join(self.root, self.log_base)
                known = set(manifest.get("runs", []))
                for name in os.listdir(log):
                    path = os.path.join(log, name)
                    if name.startswith(("build_", "test_")) \
                            and name not in known and os.path.isdir(path):
                        shutil.rmtree(path, ignore_errors=True)
            for entry in manifest.get("files", []):
                self._sync_entry(entry)
            return manifest

    def sync_packages(self, base_paths):
        with self.lock:
            result, _ = self.agent.request("packages", base_paths=base_paths)
            entries = result.get("files", [])
            expected = {entry["path"] for entry in entries}
            for dirpath, _dirs, files in os.walk(self.root):
                if "package.xml" in files:
                    path = os.path.join(dirpath, "package.xml")
                    if os.path.relpath(path, self.root) not in expected:
                        try:
                            os.unlink(path)
                        except OSError:
                            pass
            for entry in entries:
                self._sync_entry(entry)

    def sync_tests(self, build_base):
        with self.lock:
            result, _ = self.agent.request("tests", build_base=build_base)
            for entry in result.get("files", []):
                self._sync_entry(entry)

    def read(self, rel, offset, limit):
        result, data = self.agent.request(
            "read", path=rel, offset=offset, limit=limit)
        return result, data

    def system(self):
        result, _ = self.agent.request("system")
        return result


class RemoteBuildMonitor(BuildMonitor):
    """BuildMonitor fed by a read-only remote sparse mirror."""

    def __init__(self, workspace, log_base="log", pin_build=None,
                 cache_root=None, command=None):
        self.remote_workspace = workspace
        self.mirror = RemoteMirror(workspace, log_base, cache_root, command)
        super().__init__(self.mirror.root, log_base, pin_build)
        self.workspace_id = workspace.uri
        self.workspace_name = os.path.basename(workspace.path.rstrip(os.sep))
        self.remote_error = None
        self._packages_synced = 0
        self._tests_synced = 0

    def sample_system(self):
        try:
            return self.mirror.system()
        except RemoteError:
            return None

    def scan_once(self):
        try:
            self.mirror.sync(history=bool(self.pin_build))
            if time.time() - self._packages_synced > 120:
                base_paths = (self.namespace or {}).get("base_paths") or ["."]
                self.mirror.sync_packages(base_paths)
                self._packages_synced = time.time()
            if (self.namespace or {}).get("verb_name") == "test" \
                    and time.time() - self._tests_synced > 2:
                self.mirror.sync_tests(
                    (self.namespace or {}).get("build_base") or "build")
                self._tests_synced = time.time()
                self._test_cache.clear()
                self._report_cache.clear()
                self._pkg_key = None
            self.remote_error = None
            super().scan_once()
            self._add_remote_state(True)
        except RemoteError as exc:
            self.remote_error = str(exc)
            self._add_remote_state(False, str(exc))

    def _add_remote_state(self, connected, error=None):
        with self.lock:
            try:
                state = json.loads(self.state_json)
            except ValueError:
                state = {}
            state["workspace"] = self.workspace_id
            state["remote"] = {
                "scheme": self.remote_workspace.scheme,
                "host": self.remote_workspace.host,
                "container": self.remote_workspace.container,
                "path": self.remote_workspace.path,
                "connected": connected,
            }
            state["capabilities"] = {
                "delete": False, "prune": False, "ai": False,
                "editor": False,
            }
            state["ai"] = False
            if error:
                state["remote"]["error"] = error
                state["active"] = False
                if not state.get("build_id"):
                    state["error"] = "remote workspace: " + error
            self.state_json = json.dumps(state, separators=(",", ":"))

    def list_builds(self):
        try:
            self.mirror.sync(history=True)
        except RemoteError:
            pass
        result = super().list_builds()
        result["capabilities"] = {"delete": False, "prune": False}
        return result

    def _load_prev_outcome(self, build_id):
        try:
            self.mirror.sync(history=True)
        except RemoteError:
            pass
        super()._load_prev_outcome(build_id)

    def run_outcome(self, run_id):
        try:
            self.mirror.sync(history=True)
        except RemoteError:
            pass
        return super().run_outcome(run_id)

    def _auto_prune(self):
        return

    def stop(self):
        super().stop()
        self.mirror.agent.shutdown()

    def analysis(self, pkg, build=None):
        return None

    def read_log(self, pkg, which, offset, build=None, limit=None, align=False):
        if which == "tests":
            return super().read_log(pkg, which, offset, build, limit, align)
        if which not in LOG_FILES or "/" in pkg or ".." in pkg or not pkg:
            return None
        build_id = build if build else self.build_id
        if not build_id:
            return None
        rel = os.path.join(self.mirror.log_base, build_id, pkg, LOG_FILES[which])
        cap = min(512 * 1024, limit) if limit else 512 * 1024
        try:
            # Initial reads tail the file, matching BuildMonitor.read_log.
            info, _ = self.mirror.read(rel, 0, 0)
            if info.get("missing"):
                return {"size": 0, "start": 0, "offset": 0, "data": "",
                        "reset": False, "missing": True}
            size = info["size"]
            reset = offset < 0 or offset > size
            if offset < 0:
                offset = max(0, size - 128 * 1024)
            elif offset > size:
                offset = 0
            result, raw = self.mirror.read(rel, offset, cap)
        except RemoteError:
            return {"size": 0, "start": 0, "offset": 0, "data": "",
                    "reset": False, "missing": True}
        start = offset
        end = offset + len(raw)
        if (reset or align) and offset > 0 and raw:
            i = raw.find(b"\n")
            if i >= 0:
                start += i + 1
                raw = raw[i + 1:]
        return {"size": result["size"], "start": start, "offset": end,
                "data": raw.decode("utf-8", "replace"), "reset": reset}
