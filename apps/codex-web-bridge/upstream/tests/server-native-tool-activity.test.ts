import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolActivityJournal } from "../src/adapters/chatgpt-web/native-tool-activity";
import { closeTurnBrokers, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { startServer } from "../src/server";

test("native tool activity admin read is authenticated, bounded, and starts from a recent window", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-activity-admin-"));
  const config = { ...defaultConfig("full"), port: 0, brokerSocketPath: defaultBrokerEndpoint(root) };
  const journalPath = join(root, "activity.jsonl");
  const broker = TurnBroker.forSocket(config.brokerSocketPath, journalPath);
  const journal = new NativeToolActivityJournal(journalPath);
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}/admin/native-tool-activity`;
  const headers = { authorization: `Bearer ${config.controlToken}` };
  try {
    for (let index = 1; index <= 5; index++) {
      journal.record("aaaaaaaaaaaa", `call_${String(index).padStart(32, "0")}`, "queued", "exec_command");
    }
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(`${endpoint}?recent=1&afterEventId=2`, { headers })).status).toBe(400);
    expect((await fetch(`${endpoint}?limit=257`, { headers })).status).toBe(400);
    expect((await fetch(`${endpoint}?limit=2&limit=2`, { headers })).status).toBe(400);
    const recent = await fetch(`${endpoint}?recent=1&limit=2`, { headers });
    expect(recent.status).toBe(200);
    expect(recent.headers.get("cache-control")).toBe("no-store");
    expect(await recent.json()).toMatchObject({
      oldestEventId: 1, latestEventId: 5, windowTruncated: false,
      events: [{ eventId: 4, tool: "exec_command" }, { eventId: 5, tool: "exec_command" }],
    });
    const incremental = await fetch(`${endpoint}?afterEventId=2&limit=2`, { headers });
    expect((await incremental.json()).events.map((event: { eventId: number }) => event.eventId)).toEqual([3, 4]);
    expect(broker.activityPath).toBe(journalPath);
    appendFileSync(journalPath, '{"secret":"must-not-escape"}\n');
    const damaged = await fetch(endpoint, { headers });
    expect(damaged.status).toBe(503);
    expect(await damaged.json()).toEqual({ status: "unavailable", code: "native_activity_read_failed" });
  } finally {
    await server.stop(true);
    await closeTurnBrokers();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native tool activity endpoint does not expose a journal in browser-only mode", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}/admin/native-tool-activity`;
  try {
    expect((await fetch(endpoint)).status).toBe(401);
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${config.controlToken}` } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", code: "native_activity_unavailable" });
  } finally { await server.stop(true); }
});
