import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {atomicWriteFile} from './upstream/src/config';
import type {ChatGptTurnSession} from './upstream/src/adapters/chatgpt-web/turn-execution';
import nativeReceipt from './native-terminal-receipt.cjs';

type Identity = {threadId: string; turnId: string};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read(file: string, max = 256 * 1024): string {
  const before = statSync(file);
  if (!before.isFile() || before.size < 1 || before.size > max) throw Error('failure_evidence_size');
  const text = readFileSync(file, 'utf8'), after = statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('failure_evidence_changed');
  return text;
}
function evidence(home: string, identity: Identity, traceId: string) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw Error('failure_trace_invalid');
  const source = JSON.parse(read(join(home, 'turn-sources', `${traceId}.json`)));
  const turn = JSON.parse(read(join(home, 'turns', `${traceId}.json`)));
  if (source.traceId !== traceId || source.threadId !== identity.threadId || source.turnId !== identity.turnId ||
      source.purpose === 'compaction' || turn.traceId !== traceId || turn.status !== 'failed') throw Error('failure_evidence_mismatch');
  return {source, turn, sourceSha256: hash(source), turnSha256: hash(turn)};
}
const fileFor = (home: string, trace: string) => join(home, 'runtime', 'native-turn-admission', `failed-settlement-${trace}.json`);
function save(home: string, identity: Identity, traceId: string, kind: string, receipt: unknown) {
  const e = evidence(home, identity, traceId);
  atomicWriteFile(fileFor(home, traceId), JSON.stringify({version: 1, ...identity, traceId, kind,
    sourceSha256: e.sourceSha256, turnSha256: e.turnSha256, receiptSha256: hash(receipt),
    observedAt: new Date().toISOString(), automaticReplay: false}) + '\n');
}
export function hasFailedSettlement(home: string, identity: Identity, traceId: string): boolean {
  try {
    const e = evidence(home, identity, traceId), row = JSON.parse(read(fileFor(home, traceId)));
    return row.version === 1 && row.threadId === identity.threadId && row.turnId === identity.turnId && row.traceId === traceId &&
      ['upstream_physical_settlement', 'native_failed_without_tools'].includes(row.kind) &&
      row.sourceSha256 === e.sourceSha256 && row.turnSha256 === e.turnSha256 && /^[a-f0-9]{64}$/.test(row.receiptSha256);
  } catch { return false; }
}

/** Use the original upstream session, cleanup promise and capability retirement. No replacement execution. */
export async function observeFailedSettlement(home: string, identity: Identity, traceId: string, session?: ChatGptTurnSession): Promise<boolean> {
  if (!session || session.traceId !== traceId || session.nativeThreadId !== identity.threadId || session.nativeTurnId !== identity.turnId ||
      session.settledOutcome()?.type !== 'error') return false;
  try {
    await session.physicalSettlement;
    return await session.runExclusive(async () => {
      const phase = session.runtime.submission?.phase;
      if (!session.isPhysicallySettled() || session.outstanding().length || !['prepared', 'accepted'].includes(phase || '')) return false;
      if (session.runtime.mode === 'tools' && !session.runtime.retireCapability) return false;
      await session.runtime.retireCapability?.();
      save(home, identity, traceId, 'upstream_physical_settlement', {phase, toolsPending: 0, capabilityRetired: true});
      return true;
    });
  } catch { return false; } // Failure evidence never replaces the original error.
}

/** Compatibility for old failed turns: exact native error, zero tools, and the host's completed end handshake. */
export function reconcileLegacyFailedSettlement(home: string, identity: Identity, traceId: string, sessionsRoot?: string): boolean {
  if (hasFailedSettlement(home, identity, traceId)) return true;
  try {
    const {turn} = evidence(home, identity, traceId);
    if (turn.submission !== 'confirmed') return false; // Unknown Send stays unresolved.
    const receipt = nativeReceipt.verifyNativeFailureReceipt({...identity, sessionsRoot});
    const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.endedAt);
    const browserStart = Date.parse(turn.startedAt), browserEnd = Date.parse(turn.endedAt);
    if (!Number.isFinite(browserStart) || !Number.isFinite(browserEnd) || browserEnd < browserStart || browserStart < start || browserEnd > end) return false;
    let started = false, settled = false;
    for (const line of read(join(home, 'activity.jsonl'), 64 * 1024 * 1024).split(/\r?\n/).filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.traceId !== traceId) continue;
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at < start || at > end) return false;
      if (row.event === 'browser.turn_started') { if (started) return false; started = true; }
      if (row.event === 'browser.turn_ended') { if (!started || settled || row.status !== 'failed') return false; settled = true; }
    }
    if (!started || !settled) return false;
    save(home, identity, traceId, 'native_failed_without_tools', receipt);
    return true;
  } catch { return false; }
}
