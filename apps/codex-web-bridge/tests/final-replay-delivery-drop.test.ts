import { test, expect } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const threadId = '01a0dc7b-2a50-7140-a55b-eed50ff96b02';
const turnId = '01a0dc7b-2a50-7140-a55b-eed50ff96b03';
const body = JSON.stringify({
  model: 'chatgpt-web/high', stream: true,
  reasoning: { effort: 'max', summary: 'none' },
  instructions: 'Keep the fixture private and answer the user.',
  client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
  input: [{ type: 'message', role: 'user', id: 'message-1',
    content: [{ type: 'input_text', text: 'Answer this fixture.' }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
});
const ownerFile = join(import.meta.dir, 'fixtures', 'final-replay-http-owner.ts');

type Owner = { child: ChildProcessWithoutNullStreams; url: string; stderr: () => string };

function startOwner(home: string, phase: 'initial' | 'replay'): Promise<Owner> {
  const child = spawn(process.execPath, [ownerFile, home, phase, home], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`Offline HTTP owner did not start: ${stderr}`)), 15_000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Offline HTTP owner exited ${code}: ${stderr}`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0 || settled) return;
      try {
        const ready = JSON.parse(stdout.slice(0, newline));
        if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw new Error('Invalid local port');
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${ready.port}/v1/responses`, stderr: () => stderr });
      } catch (error) { fail(error as Error); }
    });
  });
}

async function stopOwner(owner: Owner): Promise<void> {
  if (owner.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Offline HTTP owner did not exit: ${owner.stderr()}`)), 10_000);
    owner.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  owner.child.kill();
  await exited;
}

function events(wire: string): any[] {
  return wire.split(/\r?\n\r?\n/).filter(frame => frame.startsWith('event: response.'))
    .map(frame => {
      const data = frame.split(/\r?\n/).find(line => line.startsWith('data: '));
      if (!data) throw new Error(`Missing SSE data for ${frame.slice(0, 80)}`);
      return JSON.parse(data.slice(6));
    });
}

function markerCount(home: string, name: string): number {
  return readFileSync(join(home, name), 'utf8').trim().split('\n').length;
}

test('HTTP owner drops terminal SSE after durable final, then a restarted owner replays identical Responses IDs without another send', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clw-final-delivery-drop-'));
  let owner: Owner | undefined;
  try {
    owner = await startOwner(home, 'initial');
    const initialResponse = await fetch(owner.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    expect(initialResponse.status).toBe(200);
    const deliveredWire = await initialResponse.text();
    const initial = JSON.parse(readFileSync(join(home, 'initial.json'), 'utf8'));
    const delivered = events(deliveredWire);
    const full = events(initial.fullWire);
    expect(initial.journalCommittedAtDone).toBe(true);
    expect(delivered.length).toBeGreaterThan(1);
    expect(delivered.some(event => event.type === 'response.completed')).toBe(false);
    expect(full.at(-1)?.type).toBe('response.completed');
    expect(markerCount(home, 'physical-sends.jsonl')).toBe(1);
    const initialPid = owner.child.pid;
    await stopOwner(owner);
    owner = await startOwner(home, 'replay');
    expect(owner.child.pid).not.toBe(initialPid);

    const retryResponse = await fetch(owner.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    expect(retryResponse.status).toBe(200);
    const retryWire = await retryResponse.text();
    const replay = JSON.parse(readFileSync(join(home, 'replay.json'), 'utf8'));
    const retried = events(retryWire);
    expect(replay.journalCommittedAtDone).toBe(true);
    expect(replay.requestSha256).toBe(initial.requestSha256);
    expect(retried).toEqual(full);
    expect(delivered).toEqual(full.slice(0, -1));
    const completed = retried.at(-1);
    expect(completed.type).toBe('response.completed');
    expect(completed.response.status).toBe('completed');
    expect(completed.response.id).toBe(delivered[0].response.id);
    const firstItem = delivered.find(event => event.type === 'response.output_item.added')?.item;
    expect(firstItem?.id).toBe(completed.response.output[0]?.id);
    expect(markerCount(home, 'physical-sends.jsonl')).toBe(1);
    expect(markerCount(home, 'adapter-factories.jsonl')).toBe(1);
  } finally {
    if (owner) await stopOwner(owner);
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
