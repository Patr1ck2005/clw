import { expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createNativeTurnAdmission, NativeTurnReconciliationError } from '../native-turn-admission';
import { readNativeToolActivity } from '../upstream/src/adapters/chatgpt-web/native-tool-activity';

const require = createRequire(import.meta.url);
const { installTurnJournal } = require('../turn-journal.cjs');
const fixture = join(import.meta.dir, 'fixtures', 'native-owner-phase-owner.ts');

type Phase = 'delivered' | 'complete_ack_lost' | 'synthetic_send_activated' | 'synthetic_send_accepted';
type PhaseRecord = { phase: Phase; traceId: string; identity: { threadId: string; turnId: string };
  callId?: string; ackWithheld?: boolean; syntheticWebCheckpoint?: boolean };

async function waitForPhase(home: string, child: ChildProcessWithoutNullStreams, diagnostics: () => string): Promise<PhaseRecord> {
  const file = join(home, 'phase.json');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')) as PhaseRecord; } catch { /* writer is finishing */ }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Offline owner exited before its phase boundary: ${diagnostics()}`);
    }
    await Bun.sleep(20);
  }
  throw new Error(`Offline owner did not reach its phase boundary: ${diagnostics()}`);
}

async function stopOwner(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolveStopped, rejectStopped) => {
    const timer = setTimeout(() => rejectStopped(new Error('Offline owner did not exit')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolveStopped(); });
  });
  child.kill();
  await stopped;
}

function safeCleanup(home: string): void {
  if (!resolve(home).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Cleanup escaped temp directory');
  rmSync(home, { recursive: true, force: true });
}

async function crashedAt(phase: Phase, check: (home: string, marker: PhaseRecord) => void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), `clw-native-${phase}-`));
  const child = spawn(process.execPath, [fixture, home, phase], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' },
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  try {
    const marker = await waitForPhase(home, child, () => diagnostics.slice(-2000));
    expect(marker.phase).toBe(phase);
    expect(marker.traceId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.parse(readFileSync(join(home, 'turns', `${marker.traceId}.json`), 'utf8')).status).toBe('running');
    await stopOwner(child); // The actual owner process exits at the fixed boundary.

    // A new process has no live tab; the persisted turn is explicitly unresolved.
    const host = { turnTabs: new Map(), async beginTurn() {}, async endTurn() {} };
    const journal = installTurnJournal(host, home);
    const row = journal.recent().find((item: { traceId: string }) => item.traceId === marker.traceId);
    expect(row).toMatchObject({ traceId: marker.traceId, status: 'needs_reconciliation',
      reason: 'browser_owner_restarted', submission: 'not-observed', automaticReplay: false });

    const replacement = createNativeTurnAdmission(home, `replacement_${phase}`);
    expect(() => replacement.admit(marker.identity, marker.traceId)).toThrow(NativeTurnReconciliationError);
    expect(() => replacement.admit(marker.identity, `${marker.traceId}_retry`)).toThrow(NativeTurnReconciliationError);
    expect(() => replacement.admit({ threadId: marker.identity.threadId,
      turnId: `${marker.identity.turnId}_next` }, `${marker.traceId}_next`))
      .toThrow(NativeTurnReconciliationError);
    check(home, marker);
  } finally {
    await stopOwner(child);
    safeCleanup(home);
  }
}

for (const phase of ['delivered', 'complete_ack_lost'] as const) {
  test(`native owner death after ${phase} keeps the exact broker call unresolved without a second execution`, async () => {
    await crashedAt(phase, (home, marker) => {
      expect(marker.callId).toMatch(/^call_/);
      const events = readNativeToolActivity(join(home, 'native-activity.jsonl')).events;
      expect(events.map(event => event.phase)).toEqual(phase === 'delivered'
        ? ['queued', 'delivered'] : ['queued', 'delivered', 'result']);
      expect(events.every(event => event.traceId === marker.traceId && event.callId === marker.callId)).toBe(true);
      const executions = readFileSync(join(home, 'tool-executions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      expect(executions).toEqual([{ traceId: marker.traceId, callId: marker.callId }]);
      if (phase === 'complete_ack_lost') expect(marker.ackWithheld).toBe(true);
    });
  }, 30_000);
}

for (const phase of ['synthetic_send_activated', 'synthetic_send_accepted'] as const) {
  test(`native owner death after a ${phase} fixture checkpoint blocks another Web Send`, async () => {
    await crashedAt(phase, (home, marker) => {
      expect(marker.syntheticWebCheckpoint).toBe(true);
      const checkpoint = join(home, 'diagnostics', 'browser-turns', `${marker.traceId}-fixture`,
        phase === 'synthetic_send_accepted' ? '01-submission-accepted.json' : '01-send-activated.json');
      expect(existsSync(checkpoint)).toBe(true);
      expect(existsSync(join(home, 'tool-executions.jsonl'))).toBe(false);
    });
  }, 30_000);
}
