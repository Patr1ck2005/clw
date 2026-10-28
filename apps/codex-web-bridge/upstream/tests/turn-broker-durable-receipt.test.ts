import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const roots: string[] = [];
const fixtureChildren = new Map<string, ChildProcess>();
function waitForChildClose(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rejectClose(new Error("broker fixture child did not close within its deadline"));
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      rejectClose(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolveClose(code);
    });
  });
}
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "cgw-durable-receipt-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    // If a failed fixture has not actually closed, leave its temporary directory intact.
    if (fixtureChildren.has(root)) continue;
    rmSync(root, { recursive: true, force: true });
  }
});

function environment(root: string) {
  return {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Simulated command", parameters: { type: "object" } }],
  };
}

const verifyWriteFailure = async () => {
  const root = scratch();
  const socketPath = defaultBrokerEndpoint(root);
  const activityPath = join(root, "activity.jsonl");
  const receiptDirectory = `${activityPath}.completion-receipts`;
  const broker = TurnBroker.forSocket(socketPath, activityPath);
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  const traceId = "durable_ack_test";
  const token = await remote.register(environment(root), 60_000, traceId);
  const result: BrokerToolResult = { content: [{ type: "text", text: "private output 8123" }], isError: false };
  try {
    const { bindingId, activityId } = await callTurnBroker<{ bindingId: string; activityId: string }>(
      socketPath, { method: "claim", token },
    );
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "test" },
    }, 10_000);
    const [call] = await remote.nextToolBatch(token);
    expect(call).toBeDefined();

    const writableBroker = broker as unknown as { writeReceiptFile: (path: string, value: unknown) => void };
    const writeReceiptFile = writableBroker.writeReceiptFile.bind(broker);
    writableBroker.writeReceiptFile = () => { throw new Error("simulated receipt disk write failure"); };
    expect(() => broker.completeTool(token, call!.callId, result))
      .toThrow("simulated receipt disk write failure");
    expect((await remote.nextToolBatch(token)).map(request => request.callId)).toEqual([call!.callId]);
    writableBroker.writeReceiptFile = writeReceiptFile;

    const originalAck = await callTurnBroker<{ completed: true }>(socketPath, {
      method: "owner_complete", token, callId: call!.callId, toolResult: result,
    });
    expect(originalAck).toEqual({ completed: true });
    expect(await invocation).toEqual(result);
    expect(await callTurnBroker(socketPath, {
      method: "owner_complete", token, callId: call!.callId, toolResult: result,
    })).toEqual(originalAck);
    expect(await remote.readCompletionReceipt(token, traceId, call!.callId, result)).toEqual({
      receipt: originalAck, reconciliationOnly: true, toolOutputAvailable: false,
    });
    const saved = readdirSync(receiptDirectory).map(name => readFileSync(join(receiptDirectory, name), "utf8")).join("\n");
    expect(saved).not.toContain(token);
    expect(saved).not.toContain("private output 8123");
    if (process.platform !== "win32") expect(statSync(receiptDirectory).mode & 0o077).toBe(0);

    await expect(remote.readCompletionReceipt(token, traceId, call!.callId, {
      content: [{ type: "text", text: "different" }],
    })).rejects.toThrow("does not match");
    await expect(remote.readCompletionReceipt("turn_invalid_wrong_identity", traceId, call!.callId, result))
      .rejects.toThrow();
    await expect(remote.readCompletionReceipt(token, "different_trace", call!.callId, result))
      .rejects.toThrow();
    await expect(remote.readCompletionReceipt(token, traceId, "call_wrong_identity_1234567890", result))
      .rejects.toThrow();
    await callTurnBroker(socketPath, { method: "activity_complete", token, activityId });
    await remote.revoke(token);
    expect(await remote.readCompletionReceipt(token, traceId, call!.callId, result)).toEqual({
      receipt: originalAck, reconciliationOnly: true, toolOutputAvailable: false,
    });
    await expect(callTurnBroker(socketPath, {
      method: "owner_complete", token, callId: call!.callId, toolResult: result,
    })).rejects.toThrow("invalid or expired");
  } finally {
    await broker.close();
  }
};

test("a persisted receipt can precede delivery of the result to the waiting MCP call", async () => {
  const root = scratch();
  const socketPath = defaultBrokerEndpoint(root);
  const activityPath = join(root, "activity.jsonl");
  const broker = TurnBroker.forSocket(socketPath, activityPath);
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  const traceId = "before_invocation_resolve";
  const token = await remote.register(environment(root), 60_000, traceId);
  try {
    const { bindingId, activityId } = await callTurnBroker<{ bindingId: string; activityId: string }>(
      socketPath, { method: "claim", token },
    );
    let invocationSettled = false;
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "test" },
    }, 10_000);
    void invocation.then(() => { invocationSettled = true; }, () => { invocationSettled = true; });
    const [call] = await remote.nextToolBatch(token);
    const result: BrokerToolResult = { content: [{ type: "text", text: "accepted but not delivered" }] };
    const writableBroker = broker as unknown as {
      persistCompletionReceipt: (token: string, channel: unknown, callId: string, digest: string) => void;
    };
    const persist = writableBroker.persistCompletionReceipt.bind(broker);
    writableBroker.persistCompletionReceipt = (...args) => {
      persist(...args);
      throw new Error("injected stop after durable receipt, before invocation resolution");
    };
    try {
      expect(() => broker.completeTool(token, call!.callId, result)).toThrow("injected stop");
      expect(invocationSettled).toBe(false);
      expect(await remote.readCompletionReceipt(token, traceId, call!.callId, result)).toEqual({
        receipt: { completed: true }, reconciliationOnly: true, toolOutputAvailable: false,
      });
      expect((await remote.nextToolBatch(token)).map(request => request.callId)).toEqual([call!.callId]);
    } finally {
      writableBroker.persistCompletionReceipt = persist;
    }
    broker.completeTool(token, call!.callId, result);
    expect(await invocation).toEqual(result);
    await callTurnBroker(socketPath, { method: "activity_complete", token, activityId });
  } finally {
    await broker.close();
  }
});

test("a broker process death leaves only an exact, read-only completion receipt", async () => {
  const root = scratch();
  const socketPath = defaultBrokerEndpoint(root);
  const activityPath = join(root, "activity.jsonl");
  const sourceUrl = new URL("../src/adapters/chatgpt-web/turn-broker.ts", import.meta.url).href;
  const configUrl = new URL("../src/config.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["-e", `
    const { TurnBroker, RemoteTurnBroker, callTurnBroker } = await import(${JSON.stringify(sourceUrl)});
    const { defaultBrokerEndpoint } = await import(${JSON.stringify(configUrl)});
    const root = process.argv[1];
    const activityPath = process.argv[2];
    const socketPath = defaultBrokerEndpoint(root);
    const broker = TurnBroker.forSocket(socketPath, activityPath);
    const remote = new RemoteTurnBroker(socketPath);
    await broker.listen();
    const traceId = "process_death_ack";
    const token = await remote.register({ cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{ name: "exec_command", description: "Simulated", parameters: { type: "object" } }] },
      60_000, traceId);
    const { bindingId } = await callTurnBroker(socketPath, { method: "claim", token });
    const invocation = callTurnBroker(socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "test" },
    }, 10_000);
    const [call] = await remote.nextToolBatch(token);
    const result = { content: [{ type: "text", text: "private child result" }] };
    const ack = await callTurnBroker(socketPath, {
      method: "owner_complete", token, callId: call.callId, toolResult: result,
    });
    await invocation;
    process.stdout.write("@@RECEIPT@@" + JSON.stringify({ token, traceId, callId: call.callId, result, ack }) + "\\n");
    process.exit(0);
  `, root, activityPath], { stdio: ["ignore", "pipe", "pipe"] });
  fixtureChildren.set(root, child);
  child.once("close", () => fixtureChildren.delete(root));
  const closed = waitForChildClose(child);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout!.on("data", chunk => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr!.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));
  let code: number | null;
  try {
    code = await closed;
  } catch (error) {
    throw new Error(`broker fixture child failed: ${String(error)}; stderr=${Buffer.concat(stderrChunks).toString("utf8").slice(0, 4_096)}`);
  }
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (code !== 0) throw new Error(`broker fixture child exited ${code}; stderr=${stderr.slice(0, 4_096)}`);
  expect(stderr).not.toContain("error:");
  const line = stdout.split(/\r?\n/).find(value => value.startsWith("@@RECEIPT@@"));
  expect(line).toBeDefined();
  const { token, traceId, callId, result, ack } = JSON.parse(line!.slice("@@RECEIPT@@".length)) as {
    token: string; traceId: string; callId: string; result: BrokerToolResult; ack: { completed: true };
  };

  const restarted = TurnBroker.forSocket(socketPath, activityPath);
  await restarted.listen();
  try {
    const remote = new RemoteTurnBroker(socketPath);
    expect(await remote.readCompletionReceipt(token, traceId, callId, result)).toEqual({
      receipt: ack, reconciliationOnly: true, toolOutputAvailable: false,
    });
    await expect(callTurnBroker(socketPath, {
      method: "owner_complete", token, callId, toolResult: result,
    })).rejects.toThrow("invalid or expired");
    await expect(remote.nextToolBatch(token)).rejects.toThrow("invalid or expired");
    await expect(remote.readCompletionReceipt(token, traceId, callId, {
      content: [{ type: "text", text: "changed" }],
    })).rejects.toThrow("does not match");
    const receiptDirectory = `${activityPath}.completion-receipts`;
    const saved = readdirSync(receiptDirectory).map(name => readFileSync(join(receiptDirectory, name), "utf8")).join("\n");
    expect(saved).not.toContain(token);
    expect(saved).not.toContain("private child result");
  } finally {
    await restarted.close();
  }
});

test("owner_complete writes before ACK and leaves the original call pending on storage failure", verifyWriteFailure);
