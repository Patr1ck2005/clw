import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  NativeToolActivityJournal,
  nativeToolActivityName,
  readNativeToolActivity,
} from "../src/adapters/chatgpt-web/native-tool-activity";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

function scratch(): { root: string; socketPath: string; journalPath: string } {
  const root = mkdtempSync(join(tmpdir(), "cgw-native-activity-"));
  return { root, socketPath: defaultBrokerEndpoint(root), journalPath: join(root, "private", "activity.jsonl") };
}

function cleanup(root: string): void {
  const tempRoot = resolve(tmpdir());
  if (!resolve(root).startsWith(`${tempRoot}${sep}`)) throw new Error("test cleanup target escaped temp directory");
  rmSync(root, { recursive: true, force: true });
}

function environment(root: string) {
  return {
    cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [],
  };
}

test("native tool activity journal deduplicates phases and survives a reader restart", () => {
  const { root, journalPath } = scratch();
  const callId = `call_${"a".repeat(32)}`;
  const traceId = "aaaaaaaaaaaa";
  try {
    const first = new NativeToolActivityJournal(journalPath);
    const queued = first.record(traceId, callId, "queued", "exec_gateway");
    expect(first.record(traceId, callId, "queued", "exec_gateway")).toEqual(queued);
    const delivered = first.record(traceId, callId, "delivered", "exec_gateway");
    expect(delivered.eventId).toBe(queued.eventId + 1);
    expect(() => first.record(traceId, callId, "queued", "apply_patch"))
      .toThrow("duplicate conflicts");
    const restarted = new NativeToolActivityJournal(journalPath);
    expect(restarted.record(traceId, callId, "delivered", "exec_gateway")).toEqual(delivered);
    expect(restarted.record(traceId, callId, "result", "exec_gateway").eventId)
      .toBe(delivered.eventId + 1);
    expect(readNativeToolActivity(journalPath, queued.eventId).events.map(event => event.phase))
      .toEqual(["delivered", "result"]);
  } finally { cleanup(root); }
});

test("broker writes exact call phases once, in order, without arguments or tool output", async () => {
  const { root, socketPath, journalPath } = scratch();
  const broker = TurnBroker.forSocket(socketPath, journalPath);
  const secretInput = "ARGUMENT_SECRET_NEVER_PERSIST";
  const secretOutput = "OUTPUT_SECRET_NEVER_PERSIST";
  try {
    const token = await broker.register(environment(root), 60_000, "aaaaaaaaaaaa");
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId, wireName: "exec", freeform: true, input: secretInput,
    }, 10_000);
    const [request] = await broker.nextToolBatch(token);
    expect(request?.callId).toMatch(/^call_/);
    const replay = await broker.nextToolBatch(token);
    expect(replay.map(item => item.callId)).toEqual([request!.callId]);
    const result: BrokerToolResult = { content: [{ type: "text", text: secretOutput }] };
    await callTurnBroker(socketPath, { method: "owner_complete", token, callId: request!.callId, toolResult: result });
    expect(await invocation).toEqual(result);
    // ACK-loss retry must not add a second result event.
    await callTurnBroker(socketPath, { method: "owner_complete", token, callId: request!.callId, toolResult: result });
    broker.revoke(token);
    const page = readNativeToolActivity(journalPath);
    expect(page.events.map(event => event.phase)).toEqual(["queued", "delivered", "result"]);
    expect(page.events.map(event => event.eventId)).toEqual([1, 2, 3]);
    expect(page.events.every(event => event.traceId === "aaaaaaaaaaaa" && event.callId === request!.callId
      && event.tool === "exec_gateway")).toBe(true);
    const raw = readFileSync(journalPath, "utf8");
    expect(raw).not.toContain(secretInput);
    expect(raw).not.toContain(secretOutput);
    expect(raw).not.toContain(bindingId);
    expect(raw).not.toContain(token);
  } finally {
    await broker.close();
    cleanup(root);
  }
});

test("broker serializes concurrent calls, reports explicit errors, and marks unfinished calls retired", async () => {
  const { root, socketPath, journalPath } = scratch();
  const broker = TurnBroker.forSocket(socketPath, journalPath);
  try {
    const token = await broker.register(environment(root), 60_000, "cccccccccccc");
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const first = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId, wireName: "apply_patch", freeform: true, input: "PATCH_SECRET",
    }, 10_000);
    const [patchRequest] = await broker.nextToolBatch(token);
    expect(patchRequest?.wireName).toBe("apply_patch");
    const second = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId, wireName: "read_files_WITH_SECRET", arguments: { path: "PATH_SECRET" },
    }, 10_000);
    broker.completeTool(token, patchRequest!.callId, { content: [], isError: true });
    expect((await first).isError).toBe(true);
    const [secondRequest] = await broker.nextToolBatch(token);
    expect(secondRequest?.wireName).toBe("read_files_WITH_SECRET");
    broker.revoke(token);
    await expect(second).rejects.toThrow();
    const events = readNativeToolActivity(journalPath).events;
    expect(events.map(event => event.eventId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.filter(event => event.callId === patchRequest!.callId).map(event => event.phase))
      .toEqual(["queued", "delivered", "error"]);
    expect(events.filter(event => event.callId === secondRequest!.callId).map(event => event.phase))
      .toEqual(["queued", "delivered", "retired"]);
    expect(readFileSync(journalPath, "utf8")).not.toMatch(/PATCH_SECRET|PATH_SECRET|read_files_WITH_SECRET/);
  } finally {
    await broker.close();
    cleanup(root);
  }
});

test("broker restart continues event IDs and cursor reads do not replay earlier events", async () => {
  const { root, socketPath, journalPath } = scratch();
  const first = TurnBroker.forSocket(socketPath, journalPath);
  try {
    const token = await first.register(environment(root), 60_000, "bbbbbbbbbbbb");
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker(socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "SECRET_COMMAND" },
    }, 10_000);
    const [request] = await first.nextToolBatch(token);
    first.revoke(token);
    await expect(invocation).rejects.toThrow("revoked");
    const cursor = readNativeToolActivity(journalPath).latestEventId!;
    expect(cursor).toBe(3);
    await first.close();

    const second = TurnBroker.forSocket(socketPath, journalPath);
    try {
      const secondToken = await second.register(environment(root), 60_000, "dddddddddddd");
      const claim = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token: secondToken });
      const next = callTurnBroker(socketPath, {
        method: "invoke", bindingId: claim.bindingId, wireName: "apply_patch", freeform: true, input: "SECRET_PATCH",
      }, 10_000);
      const [nextRequest] = await second.nextToolBatch(secondToken);
      second.completeTool(secondToken, nextRequest!.callId, { content: [] });
      await next;
      const page = readNativeToolActivity(journalPath, cursor);
      expect(page.events.map(event => event.eventId)).toEqual([cursor + 1, cursor + 2, cursor + 3]);
      expect(page.events.every(event => event.traceId === "dddddddddddd" && event.callId === nextRequest!.callId))
        .toBe(true);
      expect(page.windowTruncated).toBe(false);
      expect(request?.callId).not.toBe(nextRequest?.callId);
    } finally { await second.close(); }
  } finally {
    await first.close();
    cleanup(root);
  }
});

test("journal hashes unsafe trace labels and never guesses nested exec activity", () => {
  const { root, journalPath } = scratch();
  try {
    const journal = new NativeToolActivityJournal(journalPath);
    journal.record("CREDENTIAL_SECRET", `call_${"z".repeat(32)}`, "queued", nativeToolActivityName("exec"));
    const [event] = readNativeToolActivity(journalPath).events;
    expect(event?.traceId).toMatch(/^trace_hash_/);
    expect(event?.tool).toBe("exec_gateway");
    expect(nativeToolActivityName("read_files_WITH_SECRET")).toBe("other");
    expect(readFileSync(journalPath, "utf8")).not.toContain("CREDENTIAL_SECRET");
  } finally { cleanup(root); }
});

test("rolling journal preserves monotonic IDs and reports a lost cursor window", () => {
  const { root, journalPath } = scratch();
  try {
    const journal = new NativeToolActivityJournal(journalPath, 1024);
    for (let index = 0; index < 25; index++) {
      journal.record("trace_window", `call_${String(index).padStart(20, "0")}`, "queued", "other");
    }
    const retained = readNativeToolActivity(journalPath, 1);
    expect(retained.oldestEventId).toBeGreaterThan(2);
    expect(retained.latestEventId).toBe(25);
    expect(retained.windowTruncated).toBe(true);
    expect(retained.events.map(event => event.eventId)).toEqual(
      retained.events.map(event => event.eventId).sort((a, b) => a - b),
    );
    const restarted = new NativeToolActivityJournal(journalPath, 1024);
    expect(restarted.record("trace_window", `call_${"z".repeat(20)}`, "queued", "other").eventId).toBe(26);
    appendFileSync(journalPath, "{partial-secret-line");
    const recovered = new NativeToolActivityJournal(journalPath, 1024);
    expect(recovered.record("trace_window", `call_${"y".repeat(20)}`, "queued", "other").eventId).toBe(27);
    expect(readFileSync(journalPath, "utf8")).not.toContain("partial-secret-line");
  } finally { cleanup(root); }
});
