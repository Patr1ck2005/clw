"""Bounded, one-shot JSONL transport for the installed Codex App Server.

The command is an executable prefix; start() appends app-server --listen stdio://.
No config, model, authentication or approval decisions are supplied by this layer.
Timeouts do not cancel provider work: dispatched calls remain unknown until a
clw/lateResponse event reconciles them. Callback failures are isolated; callback
code must return eventually (Python cannot forcibly stop a blocked callback).
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time
from typing import Callable


_WINDOWS = os.name == "nt"
_MAX_LINE_BYTES = 2 * 1024 * 1024
_MAX_QUEUE = 128
_MAX_PENDING = 128
_MAX_LATE = 256
_WRITE_TIMEOUT = 30.0
_START_TIMEOUT = 30.0
_EXIT_WAIT = 0.5
_JOIN_WAIT = 0.2


class RpcFailure(Exception):
    """A bounded local code; unknown means dispatch may have taken effect."""

    def __init__(self, code: str, *, unknown: bool = False):
        self.code = (code if isinstance(code, str) and
                     re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) else "rpc_failure")
        self.unknown = bool(unknown)
        super().__init__(self.code)


def codex_command() -> list[str]:
    """Resolve PATH only, using the adjacent standard npm Node entry on Windows.

    An unsupported shell wrapper fails closed; it is never evaluated by a shell.
    Only the known adjacent package entry and node.exe are checked, not profiles
    or credential/configuration stores.
    """
    try:
        executable = shutil.which("codex")
        if not executable:
            raise RpcFailure("codex_not_found")
        path = Path(executable)
        if _WINDOWS and path.suffix.lower() in {".cmd", ".bat", ".ps1"}:
            entry = path.parent / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            if not entry.is_file():
                raise RpcFailure("codex_wrapper_unsupported")
            adjacent_node = path.parent / "node.exe"
            node = str(adjacent_node) if adjacent_node.is_file() else shutil.which("node")
            if not node:
                raise RpcFailure("node_not_found")
            return [node, str(entry)]
        return [executable]
    except OSError:
        raise RpcFailure("codex_not_found") from None


def _id_key(value):
    # bool compares equal to integer IDs in Python; it is not a protocol ID.
    if type(value) is int or (type(value) is str and len(value) <= 256):
        return type(value), value
    raise RpcFailure("protocol_error")


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("nonfinite JSON")


def _encode(message):
    try:
        data = (json.dumps(message, ensure_ascii=False, allow_nan=False,
                           separators=(",", ":")) + "\n").encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise RpcFailure("invalid_request") from None
    if len(data) > _MAX_LINE_BYTES:
        raise RpcFailure("request_too_large")
    return data


@dataclass(eq=False)
class _Frame:
    data: bytes
    deadline: float
    request_id: int | None = None
    sent: threading.Event = field(default_factory=threading.Event)
    replied: threading.Event = field(default_factory=threading.Event)
    dispatched: bool = False
    cancelled: bool = False
    result: dict | None = None
    failure: RpcFailure | None = None


class CodexConnection:
    def __init__(self, root: Path, on_event: Callable[[dict], None],
                 command: list[str] | None = None):
        if not callable(on_event):
            raise RpcFailure("invalid_callback")
        if command is not None and (not isinstance(command, list) or not command or
                                    any(not isinstance(arg, str) or not arg or "\0" in arg
                                        for arg in command)):
            raise RpcFailure("invalid_command")
        self.root = Path(root)
        self._on_event = on_event
        self._command = list(command) if command is not None else None
        self._lock = threading.RLock()
        self._start_lock = threading.Lock()
        self._process = None
        self._threads = []
        self._stop = threading.Event()
        self._closed = threading.Event()
        self._terminal = None
        self._initialization = None
        self._next_id = 1
        self._pending = {}
        self._late = OrderedDict()
        self._server_requests = {}
        self._outbound = set()
        self._writes = queue.Queue(maxsize=_MAX_QUEUE)
        self._events = queue.Queue(maxsize=_MAX_QUEUE)

    @property
    def alive(self):
        with self._lock:
            return (self._terminal is None and self._process is not None and
                    self._process.poll() is None)

    @property
    def pid(self):
        with self._lock:
            return self._process.pid if self._process is not None else None

    def start(self) -> dict:
        with self._start_lock:
            with self._lock:
                self._check_open()
                if self._initialization is not None:
                    return json.loads(json.dumps(self._initialization))
                command = self._command if self._command is not None else codex_command()
                try:
                    self._process = subprocess.Popen(
                        [*command, "app-server", "--listen", "stdio://"],
                        cwd=self.root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, bufsize=0, shell=False,
                        creationflags=subprocess.CREATE_NO_WINDOW if _WINDOWS else 0,
                    )
                except (OSError, ValueError):
                    self._fail("start_failed")
                    raise RpcFailure("start_failed") from None
                for target, name in ((self._write_loop, "writer"),
                                     (self._read_loop, "reader"),
                                     (self._event_loop, "events")):
                    thread = threading.Thread(target=target, name=f"clw-rpc-{name}", daemon=True)
                    self._threads.append(thread)
                    thread.start()
            try:
                result = self._request("initialize", {
                    "clientInfo": {"name": "clw_harness", "title": "CLW Harness", "version": "0.1.0"}
                }, _START_TIMEOUT, initializing=True)
                self._send({"method": "initialized"})
                with self._lock:
                    self._check_open()
                    self._initialization = result
                    return json.loads(json.dumps(result))
            except RpcFailure:
                self.close()
                raise

    def _check_open(self):
        if self._terminal is not None:
            raise RpcFailure(self._terminal)

    def request(self, method: str, params: dict | None, timeout: float = 30) -> dict:
        return self._request(method, params, timeout)

    def _request(self, method, params, timeout, *, initializing=False):
        if (not isinstance(method, str) or not method or len(method) > 256 or
                (params is not None and not isinstance(params, dict)) or type(timeout) not in (float, int) or
                not 0 <= timeout <= threading.TIMEOUT_MAX or not math.isfinite(timeout)):
            raise RpcFailure("invalid_request")
        deadline = time.monotonic() + timeout
        with self._lock:
            self._check_open()
            if self._process is None or (not initializing and self._initialization is None):
                raise RpcFailure("not_started")
            if len(self._pending) >= _MAX_PENDING:
                raise RpcFailure("pending_limit")
            request_id = self._next_id
            frame = _Frame(_encode({"id": request_id, "method": method, "params": params}),
                           deadline, request_id)
            self._enqueue(frame)
            self._pending[request_id] = frame
            self._next_id += 1
        if not frame.replied.wait(max(0, deadline - time.monotonic())):
            with self._lock:
                if not frame.replied.is_set():
                    self._expire(frame)
        if frame.failure is not None:
            raise frame.failure
        return frame.result

    def _enqueue(self, frame):
        # Called under the state lock so the writer cannot race registration.
        self._check_open()
        try:
            self._writes.put_nowait(frame)
        except queue.Full:
            raise RpcFailure("write_queue_full") from None
        self._outbound.add(frame)

    def _send(self, message):
        frame = _Frame(_encode(message), time.monotonic() + _WRITE_TIMEOUT)
        with self._lock:
            self._enqueue(frame)
        self._wait_sent(frame)

    def _wait_sent(self, frame):
        if not frame.sent.wait(max(0, frame.deadline - time.monotonic())):
            with self._lock:
                if not frame.sent.is_set():
                    self._expire(frame)
        if frame.failure is not None:
            raise frame.failure

    def respond(self, request_id, result: dict):
        key = _id_key(request_id)
        if not isinstance(result, dict):
            raise RpcFailure("invalid_request")
        frame = _Frame(_encode({"id": request_id, "result": result}),
                       time.monotonic() + _WRITE_TIMEOUT)
        with self._lock:
            self._check_open()
            if key not in self._server_requests:
                raise RpcFailure("unknown_server_request")
            if self._server_requests[key] is not None:
                raise RpcFailure("already_responded")
            self._enqueue(frame)
            self._server_requests[key] = frame
        try:
            self._wait_sent(frame)
        finally:
            # Claiming an approval response is one-shot, including unknown writes.
            with self._lock:
                self._server_requests.pop(key, None)

    def _expire(self, frame):
        frame.cancelled = True
        frame.failure = RpcFailure("timeout", unknown=frame.dispatched)
        self._outbound.discard(frame)
        if frame.request_id is not None:
            self._pending.pop(frame.request_id, None)
            if frame.dispatched:
                if len(self._late) >= _MAX_LATE:
                    self._fail("late_response_limit")
                else:
                    self._late[frame.request_id] = None
        frame.sent.set()
        frame.replied.set()

    def _write_loop(self):
        while not self._stop.is_set():
            try:
                frame = self._writes.get(timeout=0.05)
            except queue.Empty:
                continue
            with self._lock:
                if self._stop.is_set() or frame.cancelled:
                    continue
                if time.monotonic() >= frame.deadline:
                    self._expire(frame)
                    continue
                frame.dispatched = True
            try:
                data = memoryview(frame.data)
                while data:
                    written = self._process.stdin.write(data)
                    if not written:
                        raise OSError("closed pipe")
                    data = data[written:]
            except (OSError, ValueError):
                self._fail("write_failed")
                return
            with self._lock:
                self._outbound.discard(frame)
                frame.sent.set()

    def _read_loop(self):
        buffer = bytearray()
        try:
            while not self._stop.is_set():
                chunk = self._process.stdout.read(min(65536, _MAX_LINE_BYTES + 1 - len(buffer)))
                if not chunk:
                    if buffer:
                        raise RpcFailure("malformed_line")
                    self._fail("eof")
                    return
                buffer.extend(chunk)
                while buffer:
                    end = buffer.find(b"\n")
                    if end < 0:
                        if len(buffer) > _MAX_LINE_BYTES:
                            raise RpcFailure("line_too_large")
                        break
                    if end + 1 > _MAX_LINE_BYTES:
                        raise RpcFailure("line_too_large")
                    line = buffer[:end + 1]
                    del buffer[:end + 1]
                    try:
                        message = json.loads(line.decode("utf-8"), object_pairs_hook=_object,
                                             parse_constant=_invalid_constant)
                    except (ValueError, UnicodeError, RecursionError):
                        raise RpcFailure("malformed_line") from None
                    self._receive(message)
        except RpcFailure as error:
            self._fail(error.code)
        except (OSError, ValueError):
            self._fail("read_failed")

    def _receive(self, message):
        if not isinstance(message, dict) or message.get("jsonrpc", "2.0") != "2.0":
            raise RpcFailure("protocol_error")
        with self._lock:
            if self._stop.is_set():
                return
            if "method" in message:
                method = message["method"]
                if (not isinstance(method, str) or not method or len(method) > 256 or
                        "result" in message or "error" in message or
                        not isinstance(message.get("params", {}), dict)):
                    raise RpcFailure("protocol_error")
                if "id" in message:
                    key = _id_key(message["id"])
                    if key in self._server_requests:
                        raise RpcFailure("duplicate_server_request")
                    if len(self._server_requests) >= _MAX_PENDING:
                        raise RpcFailure("server_request_limit")
                    self._server_requests[key] = None
                self._event(message)
                return
            if "id" not in message or (("result" in message) == ("error" in message)):
                raise RpcFailure("protocol_error")
            key = _id_key(message["id"])
            if "result" in message and not isinstance(message["result"], dict):
                raise RpcFailure("protocol_error")
            if "error" in message:
                error = message["error"]
                if (not isinstance(error, dict) or type(error.get("code")) is not int or
                        not isinstance(error.get("message"), str)):
                    raise RpcFailure("protocol_error")
            # Client and server request IDs live in separate namespaces.
            frame = self._pending.get(key[1]) if key[0] is int else None
            if frame is not None and frame.dispatched:
                self._pending.pop(frame.request_id)
                if "error" in message:
                    frame.failure = RpcFailure("rpc_error")
                else:
                    frame.result = message["result"]
                frame.replied.set()
            elif key[0] is int and key[1] in self._late:
                self._late.pop(key[1])
                field_name = "result" if "result" in message else "error"
                self._event({"method": "clw/lateResponse", "params": {
                    "id": message["id"], field_name: message[field_name]}})
            else:
                raise RpcFailure("unexpected_response")

    def _event(self, message):
        try:
            self._events.put_nowait(message)
        except queue.Full:
            raise RpcFailure("event_queue_full") from None

    def _event_loop(self):
        while not self._stop.is_set() or not self._events.empty():
            try:
                message = self._events.get(timeout=0.05)
            except queue.Empty:
                continue
            try:
                self._on_event(message)
            except Exception:
                # Never print an application exception or stop protocol I/O.
                continue

    def _fail(self, code):
        with self._lock:
            if self._terminal is not None:
                return
            self._terminal = code
            self._stop.set()
            for frame in set(self._pending.values()) | self._outbound:
                if not frame.replied.is_set():
                    frame.failure = RpcFailure(code, unknown=frame.dispatched)
                frame.sent.set()
                frame.replied.set()
            self._pending.clear()
            self._outbound.clear()
            self._late.clear()
            self._server_requests.clear()
            while True:
                try:
                    self._writes.get_nowait()
                except queue.Empty:
                    break
            threading.Thread(target=self._reap, name="clw-rpc-close", daemon=True).start()

    def _reap(self):
        try:
            process = self._process
            if process is not None:
                # Windows CRT close can wait on a blocked pipe write. Close on a
                # helper so it cannot prevent the bounded terminate/kill path.
                def close_input():
                    try:
                        process.stdin.close()
                    except (OSError, ValueError):
                        pass
                closer = threading.Thread(target=close_input, name="clw-rpc-stdin", daemon=True)
                closer.start()
                for action in (None, process.terminate, process.kill):
                    try:
                        if action is not None and process.poll() is None:
                            action()
                        process.wait(timeout=_EXIT_WAIT)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                    except OSError:
                        continue
                closer.join(timeout=_JOIN_WAIT)
                for stream in (process.stdout, process.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except (OSError, ValueError):
                            pass
            for thread in self._threads:
                thread.join(timeout=_JOIN_WAIT)
        finally:
            self._closed.set()

    def close(self):
        self._fail("connection_closed")
        self._closed.wait(3 * _EXIT_WAIT + 4 * _JOIN_WAIT + 0.5)
