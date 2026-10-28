import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-atomic-pause-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(root: string) {
  return {
    cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Simulated command", parameters: { type: "object" } }],
  };
}

async function openCall(socketPath: string, remote: RemoteTurnBroker, root: string, traceId: string) {
  const token = await remote.register(environment(root), 60_000, traceId);
  const { bindingId } = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
  const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
    method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "fixture" },
  }, 10_000);
  // Cancellation tests intentionally reject this call; attach a handler at creation time.
  void invocation.catch(() => {});
  const [call] = await remote.nextToolBatch(token);
  if (!call) throw new Error("fixture did not deliver its tool call");
  return { token, traceId, bindingId, callId: call.callId, invocation };
}

async function waitForInvocationCount(broker: TurnBroker, token: string, count: number): Promise<void> {
  const channels = (broker as unknown as {
    channels: Map<string, { invocations: Map<string, unknown> }>;
  }).channels;
  const deadline = Date.now() + 1_000;
  while (channels.get(token)?.invocations.size !== count) {
    if (Date.now() > deadline) throw new Error(`fixture did not reach ${count} outstanding calls`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const result: BrokerToolResult = { content: [{ type: "text", text: "private fixture output" }] };

test("the exact one-shot pause holds the original result and ACK while another channel advances", async () => {
  const root = scratch();
  const socketPath = defaultBrokerEndpoint(root);
  const activityPath = join(root, "activity.jsonl");
  const broker = TurnBroker.forSocket(socketPath, activityPath);
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  try {
    const target = await openCall(socketPath, remote, root, "trace_paused");
    expect(() => broker.armOneShotCompletionPauseForTest("turn_wrong_identity", target.traceId, target.callId))
      .toThrow("exact sole delivered call");
    expect(() => broker.armOneShotCompletionPauseForTest(target.token, "wrong_trace", target.callId))
      .toThrow("exact sole delivered call");
    expect(() => broker.armOneShotCompletionPauseForTest(target.token, target.traceId, "wrong_call"))
      .toThrow("exact sole delivered call");
    const pause = broker.armOneShotCompletionPauseForTest(target.token, target.traceId, target.callId);
    expect(pause.release()).toBe(false);
    expect(() => broker.armOneShotCompletionPauseForTest(target.token, target.traceId, target.callId))
      .toThrow("already armed");

    let invocationSettled = false;
    let ackSettled = false;
    void target.invocation.then(() => { invocationSettled = true; }, () => { invocationSettled = true; });
    const complete = { method: "owner_complete" as const, token: target.token, callId: target.callId, toolResult: result };
    const ack = callTurnBroker<{ completed: true }>(socketPath, complete, 10_000);
    void ack.then(() => { ackSettled = true; }, () => { ackSettled = true; });
    expect(await pause.reached).toBe(true);
    expect(await remote.readCompletionReceipt(target.token, target.traceId, target.callId, result)).toEqual({
      receipt: { completed: true }, reconciliationOnly: true, toolOutputAvailable: false,
    });
    await expect(remote.readCompletionReceipt(target.token, target.traceId, target.callId, {
      content: [{ type: "text", text: "changed" }],
    })).rejects.toThrow("does not match");
    const saved = readdirSync(`${activityPath}.completion-receipts`)
      .map(name => readFileSync(join(`${activityPath}.completion-receipts`, name), "utf8")).join("\n");
    expect(saved).not.toContain(target.token);
    expect(saved).not.toContain("private fixture output");

    const duplicate = callTurnBroker<{ completed: true }>(socketPath, complete, 10_000);
    void duplicate.catch(() => {});
    await expect(callTurnBroker(socketPath, {
      ...complete, toolResult: { content: [{ type: "text", text: "conflicting output" }] },
    })).rejects.toThrow("completion result conflicts with original");
    expect((await remote.nextToolBatch(target.token)).map(call => call.callId)).toEqual([target.callId]);
    await expect(callTurnBroker(socketPath, { method: "claim", token: target.token }))
      .rejects.toThrow("pause blocks another call");
    await expect(callTurnBroker(socketPath, {
      method: "invoke", bindingId: target.bindingId, wireName: "exec_command", arguments: { cmd: "second" },
    })).rejects.toThrow("pause blocks another call");

    const other = await openCall(socketPath, remote, root, "trace_other");
    expect(await callTurnBroker(socketPath, {
      method: "owner_complete", token: other.token, callId: other.callId, toolResult: result,
    })).toEqual({ completed: true });
    expect(await other.invocation).toEqual(result);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(invocationSettled).toBe(false);
    expect(ackSettled).toBe(false);

    expect(pause.release()).toBe(true);
    expect(pause.release()).toBe(false);
    expect(pause.cancel()).toBe(false);
    expect(await ack).toEqual({ completed: true });
    expect(await duplicate).toEqual({ completed: true });
    expect(await target.invocation).toEqual(result);

    // The seam is consumed: this same channel can complete a later call normally.
    const nextInvocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId: target.bindingId, wireName: "exec_command", arguments: { cmd: "next" },
    }, 10_000);
    const [next] = await remote.nextToolBatch(target.token);
    expect(next?.callId).not.toBe(target.callId);
    expect(await callTurnBroker(socketPath, {
      method: "owner_complete", token: target.token, callId: next!.callId, toolResult: result,
    })).toEqual({ completed: true });
    expect(await nextInvocation).toEqual(result);
  } finally {
    await broker.close();
  }
});

test("cancel or channel retirement rejects the held ACK and invocation but retains the exact read-only receipt", async () => {
  const root = scratch();
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, join(root, "activity.jsonl"));
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  try {
    const target = await openCall(socketPath, remote, root, "trace_cancelled");
    const pause = broker.armOneShotCompletionPauseForTest(target.token, target.traceId, target.callId);
    const ack = callTurnBroker(socketPath, {
      method: "owner_complete", token: target.token, callId: target.callId, toolResult: result,
    }, 10_000);
    void ack.catch(() => {});
    expect(await pause.reached).toBe(true);
    expect(pause.cancel()).toBe(true);
    expect(pause.release()).toBe(false);
    await expect(ack).rejects.toThrow("pause was cancelled");
    await expect(target.invocation).rejects.toThrow("pause was cancelled");
    expect(await remote.readCompletionReceipt(target.token, target.traceId, target.callId, result)).toEqual({
      receipt: { completed: true }, reconciliationOnly: true, toolOutputAvailable: false,
    });
    await expect(callTurnBroker(socketPath, {
      method: "owner_complete", token: target.token, callId: target.callId, toolResult: result,
    })).rejects.toThrow("invalid or expired");

    const beforeReceipt = await openCall(socketPath, remote, root, "trace_cancel_before_receipt");
    const unused = broker.armOneShotCompletionPauseForTest(
      beforeReceipt.token, beforeReceipt.traceId, beforeReceipt.callId,
    );
    expect(unused.cancel()).toBe(true);
    expect(await unused.reached).toBe(false);
    await expect(beforeReceipt.invocation).rejects.toThrow("pause was cancelled");
    await expect(remote.readCompletionReceipt(
      beforeReceipt.token, beforeReceipt.traceId, beforeReceipt.callId, result,
    )).rejects.toThrow("unavailable");

    const retired = await openCall(socketPath, remote, root, "trace_owner_revoked");
    const held = broker.armOneShotCompletionPauseForTest(retired.token, retired.traceId, retired.callId);
    const retiredAck = callTurnBroker(socketPath, {
      method: "owner_complete", token: retired.token, callId: retired.callId, toolResult: result,
    }, 10_000);
    void retiredAck.catch(() => {});
    expect(await held.reached).toBe(true);
    await remote.revoke(retired.token);
    await expect(retiredAck).rejects.toThrow("revoked");
    await expect(retired.invocation).rejects.toThrow("revoked");
    expect(held.release()).toBe(false);
  } finally {
    await broker.close();
  }
});

test("arming rejects a channel with another outstanding call", async () => {
  const root = scratch();
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, join(root, "activity.jsonl"));
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  try {
    const target = await openCall(socketPath, remote, root, "trace_multiple");
    const second = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId: target.bindingId, wireName: "exec_command", arguments: { cmd: "second" },
    }, 10_000);
    void second.catch(() => {});
    await waitForInvocationCount(broker, target.token, 2);
    expect(() => broker.armOneShotCompletionPauseForTest(target.token, target.traceId, target.callId))
      .toThrow("exact sole delivered call");
    broker.revoke(target.token);
    await expect(target.invocation).rejects.toThrow("revoked");
    await expect(second).rejects.toThrow("revoked");
  } finally {
    await broker.close();
  }
});
