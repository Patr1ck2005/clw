"""Isolated transport tests. The child is Python JSONL, never a real model."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import harness_rpc as rpc


CHILD = r'''
import json, os, sys, time
mode = sys.argv[1]
seen, deferred, reversed_calls, approvals = [], [], [], {}
initialized = False
decisions = []

def emit(value):
    sys.stdout.buffer.write((json.dumps(value, ensure_ascii=False) + "\n").encode())
    sys.stdout.buffer.flush()

def result(call, value):
    emit({"id": call["id"], "result": value})

for line in sys.stdin.buffer:
    call = json.loads(line)
    seen.append(call)
    method = call.get("method")
    params = call.get("params", {})
    if method == "initialize":
        if mode == "init_hang":
            time.sleep(60)
        elif mode == "init_error":
            emit({"id": call["id"], "error": {"code": -32000, "message": "fixture-private-error"}})
        elif mode == "init_eof":
            sys.exit(0)
        else:
            result(call, {"userAgent": "fake-codex", "initialize": call,
                          "argv": sys.argv[2:], "cwd": os.getcwd(),
                          "setting": os.environ.get("CLW_RPC_FIXTURE_SETTING")})
    elif method == "initialized":
        initialized = True
    elif method == "probe":
        result(call, {"initialized": initialized, "seen": seen, "decisions": decisions})
    elif method == "echo":
        result(call, params)
    elif method == "reverse":
        reversed_calls.append(call)
        if len(reversed_calls) == params["total"]:
            for item in reversed(reversed_calls):
                result(item, item["params"])
            reversed_calls.clear()
    elif method == "stream":
        for i in range(params.get("count", 3)):
            emit({"method": "item/agentMessage/delta", "params": {"index": i, "delta": "文字 🌍"}})
        result(call, {"streamed": True})
    elif method == "approve":
        approval_id = params.get("server_id", call["id"])
        approvals[(type(approval_id).__name__, approval_id)] = call
        emit({"id": approval_id, "method": "item/commandExecution/requestApproval",
              "params": {"command": "fixture-only", "clientRequestId": call["id"]}})
    elif method is None:
        decisions.append(call)
        original = approvals.pop((type(call["id"]).__name__, call["id"]), None)
        if original:
            result(original, {"decision": call["result"], "responses": len(decisions)})
    elif method == "defer":
        deferred.append(call)
        emit({"method": "fixture/dispatched", "params": {"id": call["id"]}})
    elif method == "release":
        for item in deferred:
            if item["params"].get("error"):
                emit({"id": item["id"], "error": {"code": -32001, "message": "fixture-late-error"}})
            else:
                result(item, {"applied": True})
        deferred.clear()
        result(call, {"count": sum(item.get("method") == "defer" for item in seen)})
    elif method == "error":
        emit({"id": call["id"], "error": {"code": -32601,
              "message": "fixture-private-error" * 500, "data": {"private": "fixture-only"}}})
    elif method == "stderr":
        sys.stderr.write("fixture-private-stderr" * 100000)
        sys.stderr.flush()
        result(call, {})
    elif method == "raw":
        raw = bytes.fromhex(params["hex"])
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()
        if params.get("exit"):
            sys.exit(0)
    elif method == "fragmented":
        packet = (json.dumps({"jsonrpc": "2.0", "method": "fixture/fragment", "params": {"text": "🪷"}}, ensure_ascii=False) + "\r\n" +
                  json.dumps({"jsonrpc": "2.0", "id": call["id"], "result": {"fragmented": True}}) + "\n").encode()
        for byte in packet:
            sys.stdout.buffer.write(bytes([byte]))
            sys.stdout.buffer.flush()
    elif method == "oversized":
        sys.stdout.buffer.write(b"x" * params["length"])
        sys.stdout.buffer.flush()
    elif method == "no_read":
        result(call, {"stalled": True})
        time.sleep(60)
    elif method == "eof":
        emit({"method": "fixture/final", "params": {}})
        sys.exit(0)
    elif method == "close_linger":
        result(call, {})
        for ignored in sys.stdin.buffer:
            pass
        time.sleep(60)
    elif method == "duplicate_approval":
        approval = {"id": "same", "method": "fixture/approval", "params": {}}
        emit(approval)
        emit(approval)
    elif method == "approval_flood":
        for i in range(params["count"]):
            emit({"id": "approval-" + str(i), "method": "fixture/approval", "params": {}})
    else:
        emit({"id": call["id"], "error": {"code": -32601, "message": "fixture unknown method"}})
'''


class CommandTests(unittest.TestCase):
    def test_native_executable_and_missing_command(self):
        with patch.object(rpc, "_WINDOWS", False), patch.object(rpc.shutil, "which", return_value="/bin/codex"):
            self.assertEqual(rpc.codex_command(), ["/bin/codex"])
        with patch.object(rpc.shutil, "which", return_value=None):
            with self.assertRaises(rpc.RpcFailure) as error:
                rpc.codex_command()
            self.assertEqual(error.exception.code, "codex_not_found")
            self.assertFalse(error.exception.unknown)

    def test_windows_npm_entry_uses_adjacent_node_without_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wrapper = root / "codex.cmd"
            entry = root / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            entry.parent.mkdir(parents=True)
            entry.touch()
            node = root / "node.exe"
            node.touch()
            with patch.object(rpc, "_WINDOWS", True), patch.object(rpc.shutil, "which", return_value=str(wrapper)) as which:
                self.assertEqual(rpc.codex_command(), [str(node), str(entry)])
                which.assert_called_once_with("codex")

    def test_windows_npm_entry_uses_path_node_and_rejects_unknown_wrapper(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = root / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            entry.parent.mkdir(parents=True)
            entry.touch()
            with patch.object(rpc, "_WINDOWS", True), patch.object(rpc.shutil, "which", side_effect=[str(root / "codex.cmd"), "node.exe"]):
                self.assertEqual(rpc.codex_command(), ["node.exe", str(entry)])
            with patch.object(rpc, "_WINDOWS", True), patch.object(rpc.shutil, "which", side_effect=[str(root / "codex.cmd"), None]):
                with self.assertRaises(rpc.RpcFailure) as error:
                    rpc.codex_command()
                self.assertEqual(error.exception.code, "node_not_found")
            entry.unlink()
            with patch.object(rpc, "_WINDOWS", True), patch.object(rpc.shutil, "which", return_value=str(root / "codex.cmd")):
                with self.assertRaises(rpc.RpcFailure) as error:
                    rpc.codex_command()
                self.assertEqual(error.exception.code, "codex_wrapper_unsupported")

    def test_failure_text_is_bounded_and_unknown_is_explicit(self):
        for raw in ("provider raw\nfixture-private-error", "x" * 10000, None):
            failure = rpc.RpcFailure(raw, unknown=True)
            self.assertEqual(str(failure), "rpc_failure")
            self.assertTrue(failure.unknown)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.connections = []
        self.gates = []
        self.events = queue.Queue()

    def tearDown(self):
        for gate in self.gates:
            gate.set()
        for connection in self.connections:
            connection.close()
            if connection._process is not None:
                self.assertIsNotNone(connection._process.poll(), "owned child was not reaped")
                self.assertTrue(connection._process.stdin.closed)
                self.assertTrue(connection._process.stdout.closed)
            self.assertTrue(connection._closed.is_set())
            for thread in connection._threads:
                thread.join(timeout=1)
                self.assertFalse(thread.is_alive(), thread.name)
        self.directory.cleanup()

    def connection(self, mode="normal", callback=None, start=True):
        connection = rpc.CodexConnection(self.root, callback or self.events.put,
                                         [sys.executable, "-u", "-c", CHILD, mode])
        self.connections.append(connection)
        if start:
            connection.start()
        return connection

    def failure(self, operation, code, unknown=None):
        with self.assertRaises(rpc.RpcFailure) as caught:
            operation()
        error = caught.exception
        self.assertEqual(error.code, code)
        if unknown is not None:
            self.assertEqual(error.unknown, unknown)
        return error

    def test_handshake_order_launch_arguments_and_preserved_configuration(self):
        config = self.root / ".codex" / "config.toml"
        config.parent.mkdir()
        baseline = b'model = "fixture-existing-model"\nmodel_reasoning_effort = "high"\napproval_policy = "on-request"\n'
        config.write_bytes(baseline)
        with patch.dict(os.environ, {"CLW_RPC_FIXTURE_SETTING": "unchanged"}), patch.object(rpc.subprocess, "Popen", wraps=subprocess.Popen) as popen:
            connection = self.connection(start=False)
            self.assertFalse(connection.alive)
            self.assertIsNone(connection.pid)
            initialization = connection.start()
            self.assertTrue(connection.alive)
            self.assertIsInstance(connection.pid, int)
            self.assertEqual(initialization["argv"], ["app-server", "--listen", "stdio://"])
            self.assertEqual(Path(initialization["cwd"]), self.root)
            self.assertEqual(initialization["setting"], "unchanged")
            self.assertEqual(initialization["initialize"]["params"], {
                "clientInfo": {"name": "clw_harness", "title": "CLW Harness", "version": "0.1.0"}})
            observed = connection.request("probe", {})
            self.assertTrue(observed["initialized"])
            self.assertEqual([item["method"] for item in observed["seen"]], ["initialize", "initialized", "probe"])
            self.assertTrue(all("jsonrpc" not in item for item in observed["seen"]))
            self.assertEqual(observed["seen"][1], {"method": "initialized"})
            initialization["initialize"]["params"].clear()
            self.assertIn("clientInfo", connection.start()["initialize"]["params"])
            self.assertEqual(popen.call_count, 1)
            options = popen.call_args.kwargs
            self.assertFalse(options["shell"])
            self.assertNotIn("env", options)
            self.assertEqual(options["stderr"], subprocess.DEVNULL)
            connection.close()
        self.assertEqual(config.read_bytes(), baseline)
        self.assertEqual(list(self.root.rglob("*")), [config.parent, config])

    def test_default_command_is_resolved_but_only_fixture_is_launched(self):
        command = [sys.executable, "-u", "-c", CHILD, "normal"]
        with patch.object(rpc, "codex_command", return_value=command) as resolve:
            connection = rpc.CodexConnection(self.root, self.events.put)
            self.connections.append(connection)
            self.assertEqual(connection.start()["userAgent"], "fake-codex")
            resolve.assert_called_once_with()

    def test_concurrent_requests_correlate_out_of_order(self):
        connection = self.connection()
        total = 16
        with ThreadPoolExecutor(max_workers=total) as pool:
            futures = [pool.submit(connection.request, "reverse", {"index": i, "total": total}, 3) for i in range(total)]
            self.assertEqual([future.result(4)["index"] for future in futures], list(range(total)))
        observed = connection.request("probe", {})["seen"]
        ids = [item["id"] for item in observed if "id" in item]
        self.assertEqual(len(ids), len(set(ids)))

    def test_streamed_unicode_events_are_ordered(self):
        connection = self.connection()
        self.assertEqual(connection.request("stream", {}), {"streamed": True})
        events = [self.events.get(timeout=2) for _ in range(3)]
        self.assertEqual([event["params"]["index"] for event in events], [0, 1, 2])
        self.assertEqual(events[0]["params"]["delta"], "文字 🌍")
        self.assertEqual(connection.request("echo", {"text": "🪷"}), {"text": "🪷"})

    def test_fragmented_utf8_crlf_and_optional_jsonrpc_field(self):
        connection = self.connection()
        self.assertEqual(connection.request("fragmented", {}, 2), {"fragmented": True})
        event = self.events.get(timeout=2)
        self.assertEqual(event["method"], "fixture/fragment")
        self.assertEqual(event["params"], {"text": "🪷"})

    def test_approval_collision_is_forwarded_and_explicit_decision_sent_once(self):
        connection = self.connection()
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(connection.request, "approve", {}, 3)
            approval = self.events.get(timeout=2)
            self.assertEqual(approval["id"], approval["params"]["clientRequestId"])
            self.assertFalse(pending.done())
            self.assertEqual(connection.request("probe", {})["decisions"], [])
            decision = {"decision": "decline"}
            connection.respond(approval["id"], decision)
            self.assertEqual(pending.result(2), {"decision": decision, "responses": 1})
            self.failure(lambda: connection.respond(approval["id"], decision), "unknown_server_request", False)
            self.assertEqual(len(connection.request("probe", {})["decisions"]), 1)

    def test_approval_ids_preserve_types_zero_and_concurrent_one_shot(self):
        connection = self.connection()
        with ThreadPoolExecutor(max_workers=4) as pool:
            first = pool.submit(connection.request, "approve", {"server_id": 0}, 3)
            self.assertEqual(self.events.get(timeout=2)["id"], 0)
            second = pool.submit(connection.request, "approve", {"server_id": "0"}, 3)
            self.assertEqual(self.events.get(timeout=2)["id"], "0")
            barrier = threading.Barrier(2)
            def respond():
                barrier.wait(timeout=2)
                try:
                    connection.respond(0, {"decision": "decline"})
                    return "sent"
                except rpc.RpcFailure as error:
                    return error.code
            a, b = pool.submit(respond), pool.submit(respond)
            outcomes = [a.result(2), b.result(2)]
            self.assertEqual(outcomes.count("sent"), 1)
            self.assertIn(next(item for item in outcomes if item != "sent"), {"already_responded", "unknown_server_request"})
            connection.respond("0", {"decision": "cancel"})
            self.assertEqual(first.result(2)["decision"], {"decision": "decline"})
            self.assertEqual(second.result(2)["decision"], {"decision": "cancel"})

    def test_callback_can_make_requests_and_respond(self):
        connection = None
        completed = queue.Queue()
        def callback(event):
            if "id" in event:
                connection.respond(event["id"], {"decision": "decline"})
            else:
                completed.put(connection.request("echo", {"nested": True}, timeout=2))
        connection = self.connection(callback=callback)
        self.assertEqual(connection.request("approve", {}, 3)["decision"], {"decision": "decline"})
        connection.request("stream", {"count": 1})
        self.assertEqual(completed.get(timeout=3), {"nested": True})

    def test_callback_exception_does_not_stop_events_or_responses(self):
        def callback(event):
            self.events.put(event)
            raise RuntimeError("fixture-private-callback-error")
        connection = self.connection(callback=callback)
        connection.request("stream", {})
        for _ in range(3):
            self.events.get(timeout=2)
        self.assertEqual(connection.request("echo", {"still": "alive"}), {"still": "alive"})

    def test_slow_callback_does_not_block_requests_or_close(self):
        gate, entered = threading.Event(), threading.Event()
        self.gates.append(gate)
        def callback(event):
            entered.set()
            gate.wait(5)
        connection = self.connection(callback=callback)
        connection.request("stream", {"count": 1})
        self.assertTrue(entered.wait(2))
        self.assertEqual(connection.request("echo", {"ok": True}, 1), {"ok": True})
        start = time.monotonic()
        connection.close()
        self.assertLess(time.monotonic() - start, 2.5)
        gate.set()

    def test_rpc_error_is_safe_and_connection_survives(self):
        connection = self.connection()
        error = self.failure(lambda: connection.request("error", {}), "rpc_error", False)
        self.assertEqual(str(error), "rpc_error")
        self.assertNotIn("fixture-private", "".join(traceback.format_exception(error)))
        self.assertEqual(connection.request("echo", {}), {})
        self.assertEqual(connection.request("stderr", {}), {})

    def test_timeout_is_unknown_no_replay_and_late_success_is_observed(self):
        connection = self.connection()
        self.failure(lambda: connection.request("defer", {}, 0.1), "timeout", True)
        request_id = self.events.get(timeout=2)["params"]["id"]
        self.assertEqual(connection.request("release", {}), {"count": 1})
        self.assertEqual(self.events.get(timeout=2), {
            "method": "clw/lateResponse", "params": {"id": request_id, "result": {"applied": True}}})
        self.assertEqual(connection.request("release", {}), {"count": 1})

    def test_late_error_is_observed_without_replay(self):
        connection = self.connection()
        self.failure(lambda: connection.request("defer", {"error": True}, 0.1), "timeout", True)
        request_id = self.events.get(timeout=2)["params"]["id"]
        connection.request("release", {})
        event = self.events.get(timeout=2)
        self.assertEqual(event["method"], "clw/lateResponse")
        self.assertEqual(event["params"], {"id": request_id, "error": {"code": -32001, "message": "fixture-late-error"}})

    def test_timeout_before_dispatch_never_writes(self):
        connection = self.connection()
        self.failure(lambda: connection.request("echo", {"must_not_send": True}, 0), "timeout", False)
        self.assertNotIn("echo", [item.get("method") for item in connection.request("probe", {})["seen"]])

    def test_blocked_stdin_has_bounded_timeout_and_close(self):
        connection = self.connection()
        connection.request("no_read", {})
        start = time.monotonic()
        self.failure(lambda: connection.request("echo", {"bulk": "x" * (1024 * 1024)}, 0.2), "timeout", True)
        self.failure(lambda: connection.request("echo", {"queued": True}, 0.1), "timeout", False)
        connection.close()
        self.assertLess(time.monotonic() - start, 3)
        self.assertIsNotNone(connection._process.poll())

    def test_malformed_and_invalid_protocol_frames_fail_pending_requests(self):
        cases = [
            (b"not JSON\n", "malformed_line", False),
            (b"\xff\n", "malformed_line", False),
            (b"\n", "malformed_line", False),
            (b'{"id":2,"id":3,"result":{}}\n', "malformed_line", False),
            (b'{"id":2,"result":{"x":NaN}}\n', "malformed_line", False),
            (b"[1,2]\n", "protocol_error", False),
            (b'{"id":true,"result":{}}\n', "protocol_error", False),
            (b'{"id":2,"result":{},"error":{}}\n', "protocol_error", False),
            (b'{"id":2,"result":null}\n', "protocol_error", False),
            (b'{"id":2,"error":{"message":"no code"}}\n', "protocol_error", False),
            (b'{"jsonrpc":"1.0","id":2,"result":{}}\n', "protocol_error", False),
            (b'{"method":"event","params":[]}\n', "protocol_error", False),
            (b'{"id":9999,"result":{}}\n', "unexpected_response", False),
            (b'{"id":2,"result":{}}', "malformed_line", True),
        ]
        for raw, code, exit_child in cases:
            with self.subTest(raw=raw):
                connection = self.connection()
                self.failure(lambda: connection.request("raw", {"hex": raw.hex(), "exit": exit_child}, 2), code, True)
                self.assertFalse(connection.alive)
                connection.close()

    def test_oversized_unterminated_line_fails_without_waiting_for_eof(self):
        connection = self.connection()
        with patch.object(rpc, "_MAX_LINE_BYTES", 2048):
            self.failure(lambda: connection.request("oversized", {"length": 8192}, 2), "line_too_large", True)
        self.assertFalse(connection.alive)

    def test_invalid_and_oversized_outgoing_requests_are_not_sent(self):
        connection = self.connection()
        invalid = [("", {}, 1), ("echo", [], 1), ("echo", {"n": float("nan")}, 1),
                   ("echo", {"x": object()}, 1), ("echo", {"x": "\ud800"}, 1),
                   ("echo", {}, -1), ("echo", {}, float("inf")), ("echo", {}, True)]
        for method, params, timeout in invalid:
            with self.subTest(method=method, timeout=timeout):
                self.failure(lambda: connection.request(method, params, timeout), "invalid_request", False)
        with patch.object(rpc, "_MAX_LINE_BYTES", 1000):
            self.failure(lambda: connection.request("echo", {"bulk": "x" * 2000}), "request_too_large", False)
        self.assertEqual([item["method"] for item in connection.request("probe", {})["seen"]], ["initialize", "initialized", "probe"])

    def test_parameterless_protocol_request_preserves_null_params(self):
        connection=self.connection()
        reply=connection.request('probe',None)
        self.assertIsNone(reply['seen'][-1]['params'])

    def test_pending_limit_rejects_without_dispatch(self):
        connection = self.connection()
        with patch.object(rpc, "_MAX_PENDING", 1), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(connection.request, "defer", {}, 3)
            self.events.get(timeout=2)
            self.failure(lambda: connection.request("echo", {}), "pending_limit", False)
            connection.close()
            self.failure(lambda: pending.result(2), "connection_closed", True)

    def test_write_queue_is_bounded_when_child_stops_reading(self):
        with patch.object(rpc, "_MAX_QUEUE", 2):
            connection = self.connection()
        connection.request("no_read", {})
        self.failure(lambda: connection.request("echo", {"bulk": "x" * (1024 * 1024)}, 0.2), "timeout", True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            queued = [pool.submit(connection.request, "echo", {"queued": i}, 3) for i in range(2)]
            deadline = time.monotonic() + 2
            while connection._writes.qsize() < 2 and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertEqual(connection._writes.qsize(), 2)
            self.failure(lambda: connection.request("echo", {}), "write_queue_full", False)
            connection.close()
            for future in queued:
                self.failure(lambda: future.result(2), "connection_closed", False)

    def test_event_queue_overflow_fails_instead_of_dropping_events(self):
        gate, entered = threading.Event(), threading.Event()
        self.gates.append(gate)
        def callback(event):
            entered.set()
            gate.wait(5)
        with patch.object(rpc, "_MAX_QUEUE", 2):
            connection = self.connection(callback=callback)
        connection.request("stream", {"count": 1})
        self.assertTrue(entered.wait(2))
        self.failure(lambda: connection.request("stream", {"count": 10}, 2), "event_queue_full", True)
        gate.set()

    def test_approval_duplicates_and_unanswered_limit_fail_closed(self):
        connection = self.connection()
        self.failure(lambda: connection.request("duplicate_approval", {}, 2), "duplicate_server_request", True)
        connection = self.connection()
        with patch.object(rpc, "_MAX_PENDING", 2):
            self.failure(lambda: connection.request("approval_flood", {"count": 3}, 2), "server_request_limit", True)

    def test_late_response_registry_is_bounded(self):
        connection = self.connection()
        with patch.object(rpc, "_MAX_LATE", 1):
            self.failure(lambda: connection.request("defer", {}, 0.1), "timeout", True)
            self.failure(lambda: connection.request("defer", {}, 0.1), "timeout", True)
            self.failure(lambda: connection.request("echo", {}), "late_response_limit", False)

    def test_eof_unblocks_all_waiters_and_delivers_final_notification(self):
        connection = self.connection()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(connection.request, "defer", {}, 3)
            self.events.get(timeout=2)
            self.failure(lambda: connection.request("eof", {}), "eof", True)
            self.failure(lambda: pending.result(2), "eof", True)
        self.assertEqual(self.events.get(timeout=2)["method"], "fixture/final")
        self.assertFalse(connection.alive)
        self.failure(lambda: connection.request("echo", {}), "eof", False)

    def test_close_terminates_only_owned_lingering_child_and_is_idempotent(self):
        connection = self.connection()
        other = self.connection()
        connection.request("close_linger", {})
        pid = connection.pid
        start = time.monotonic()
        connection.close()
        connection.close()
        self.assertLess(time.monotonic() - start, 3)
        self.assertFalse(connection.alive)
        self.assertEqual(connection.pid, pid)
        self.assertEqual(other.request("echo", {"alive": True}), {"alive": True})
        self.failure(connection.start, "connection_closed", False)

    def test_close_from_callback_is_bounded(self):
        finished = threading.Event()
        connection = None
        def callback(event):
            connection.close()
            finished.set()
        connection = self.connection(callback=callback)
        try:
            connection.request("stream", {"count": 1})
        except rpc.RpcFailure as error:
            # Closing may race the reply immediately following the notification.
            self.assertEqual(error.code, "connection_closed")
            self.assertTrue(error.unknown)
        self.assertTrue(finished.wait(3))

    def test_not_started_closed_and_failed_start_are_safe(self):
        connection = self.connection(start=False)
        self.failure(lambda: connection.request("echo", {}), "not_started", False)
        connection.close()
        self.failure(connection.start, "connection_closed", False)
        connection = self.connection(start=False)
        with patch.object(rpc.subprocess, "Popen", side_effect=OSError("fixture-private-path")):
            error = self.failure(connection.start, "start_failed", False)
        self.assertNotIn("fixture-private", "".join(traceback.format_exception(error)))

    def test_handshake_errors_eof_and_timeout_reap_the_child(self):
        for mode, code in (("init_error", "rpc_error"), ("init_eof", "eof"), ("init_hang", "timeout")):
            with self.subTest(mode=mode), patch.object(rpc, "_START_TIMEOUT", 0.3):
                connection = self.connection(mode=mode, start=False)
                self.failure(connection.start, code, code != "rpc_error")
                self.assertFalse(connection.alive)
                self.assertIsNotNone(connection._process.poll())


if __name__ == "__main__":
    unittest.main(verbosity=2)
