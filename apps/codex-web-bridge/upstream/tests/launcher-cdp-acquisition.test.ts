import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectLauncherBrowserHost, inspectLauncherBrowserHostLiveness,
  LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL,
} from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const metadata = { webSocketDebuggerUrl: "ws://127.0.0.1:39110/devtools/browser/owned" };
function descriptor(endpoint: string): string {
  const root = mkdtempSync(join(tmpdir(), "clw-cdp-acquire-")); roots.push(root);
  const file = join(root, "descriptor.json");
  writeFileSync(file, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production", pid: process.pid, endpoint,
    control: { endpoint, token: "test-control-0123456789abcdefghijklmnopqrstuv" },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:clw-account-a", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "0123456789abcdefghijklmnopqrstuv", surfaceTargets: {}, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return file;
}
async function serve(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test server address");
  return { endpoint: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test("a transient CDP handshake retries the same owner and tolerates a descriptor heartbeat", async () => {
  let reads = 0, path = "";
  const server = await serve((request, response) => {
    expect(request.url).toBe("/json/version");
    if (++reads === 1) {
      const current = JSON.parse(readFileSync(path, "utf8"));
      current.createdAt = new Date().toISOString();
      writeFileSync(path, JSON.stringify(current), { mode: 0o600 });
      response.writeHead(503); response.end();
    } else { response.writeHead(200); response.end(JSON.stringify(metadata)); }
  });
  path = descriptor(server.endpoint);
  try {
    const owner = await inspectLauncherBrowserHostLiveness(path, { timeoutMs: 1_000 });
    expect(owner.endpoint).toBe(server.endpoint); expect(owner.pid).toBe(process.pid); expect(reads).toBe(2);
  } finally { await server.close(); }
});

test("a five-second CDP stall recovers within the connection budget", async () => {
  let reads = 0;
  const server = await serve((_request, response) => {
    if (++reads === 1) return; // The owned browser is busy, not gone.
    response.writeHead(200); response.end(JSON.stringify(metadata));
  });
  try {
    await inspectLauncherBrowserHostLiveness(descriptor(server.endpoint), { timeoutMs: 6_500 });
    expect(reads).toBe(2);
  } finally { await server.close(); }
}, 8_000);

test.each([401, 403, 404])("CDP denial HTTP %s is never retried", async status => {
  let reads = 0;
  const server = await serve((_request, response) => { reads++; response.writeHead(status); response.end(); });
  try {
    await expect(inspectLauncherBrowserHostLiveness(descriptor(server.endpoint))).rejects.toThrow(`HTTP ${status}`);
    expect(reads).toBe(1);
  } finally { await server.close(); }
});

test("invalid CDP ownership metadata is not treated as a transient failure", async () => {
  let reads = 0;
  const server = await serve((_request, response) => { reads++; response.end('{"webSocketDebuggerUrl":"wss://elsewhere.invalid/browser"}'); });
  try {
    await expect(inspectLauncherBrowserHostLiveness(descriptor(server.endpoint))).rejects.toThrow("loopback WebSocket");
    expect(reads).toBe(1);
  } finally { await server.close(); }
});

test("CDP retries stop when the original owner changes", async () => {
  let reads = 0, path = "";
  const server = await serve((_request, response) => {
    reads++; const current = JSON.parse(readFileSync(path, "utf8")); current.partition = "persist:clw-account-b";
    writeFileSync(path, JSON.stringify(current), { mode: 0o600 }); response.writeHead(503); response.end();
  });
  path = descriptor(server.endpoint);
  try {
    await expect(inspectLauncherBrowserHostLiveness(path)).rejects.toThrow("owner changed"); expect(reads).toBe(1);
  } finally { await server.close(); }
});

test("CDP handshake has at most three attempts and respects a shorter deadline", async () => {
  let reads = 0;
  const server = await serve((_request, response) => { reads++; response.writeHead(503); response.end(); });
  const path = descriptor(server.endpoint);
  try {
    await expect(inspectLauncherBrowserHostLiveness(path, { timeoutMs: 1_000 })).rejects.toThrow("HTTP 503");
    expect(reads).toBe(3); reads = 0;
    await expect(inspectLauncherBrowserHostLiveness(path, { timeoutMs: 30 })).rejects.toThrow("HTTP 503");
    expect(reads).toBe(1);
  } finally { await server.close(); }
});

test("a cancelled connection never advances to CDP reconnect or a browser send", async () => {
  let reads = 0;
  const abort = new AbortController();
  const server = await serve((_request, response) => { reads++; abort.abort(); response.writeHead(503); response.end(); });
  try {
    await expect(connectLauncherBrowserHost(descriptor(server.endpoint), 1_000, undefined, abort.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(1);
  } finally { await server.close(); }
});
