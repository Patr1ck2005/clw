import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createNativeTurnAdmission, NativeTurnReconciliationError } from '../native-turn-admission';
import { observedAdapter } from '../observed-adapter';
import historicalReview from '../import-review.cjs';

const first = { threadId: 'thread-one', turnId: 'turn-one' };
const other = { threadId: 'thread-other', turnId: 'turn-other' };
const traceA = 'trace_a001';
const traceB = 'trace_b002';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'clw-native-admission-'));
  return { home, clean: () => rmSync(home, { recursive: true, force: true }) };
}

function legacy(home: string, traceId: string, identity: typeof first, status: string, submission: string, final = false) {
  mkdirSync(join(home, 'turn-sources'), { recursive: true });
  mkdirSync(join(home, 'turns'), { recursive: true });
  writeFileSync(join(home, 'turn-sources', `${traceId}.json`), JSON.stringify({ traceId, ...identity }));
  writeFileSync(join(home, 'turns', `${traceId}.json`), JSON.stringify({ traceId, status, submission }));
  if (final) {
    mkdirSync(join(home, 'turn-reviews'), { recursive: true });
    writeFileSync(join(home, 'turn-reviews', `${traceId}.json`), JSON.stringify({ traceId, ...identity, taskAcceptance: 'unverified', observedAt: new Date().toISOString() }));
  } else rmSync(join(home, 'turn-reviews', `${traceId}.json`), { force: true });
}

function nativeTerminal(home: string, traceId: string, identity: { threadId: string; turnId: string }, finalText = 'native final') {
  const day = new Date(Number.parseInt(identity.threadId.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-');
  const dir = join(home, 'sessions', ...day);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, 'turn-sources'), { recursive: true });
  mkdirSync(join(home, 'turns'), { recursive: true });
  mkdirSync(join(home, 'turn-reviews'), { recursive: true });
  writeFileSync(join(home, 'turn-sources', `${traceId}.json`), JSON.stringify({ traceId, ...identity }));
  writeFileSync(join(home, 'turns', `${traceId}.json`), JSON.stringify({ traceId, status: 'completed', submission: 'confirmed' }));
  writeFileSync(join(home, 'turn-reviews', `${traceId}.json`), JSON.stringify({ traceId, ...identity,
    finalSha256: createHash('sha256').update(finalText).digest('hex'), taskAcceptance: 'unverified', observedAt: '2026-09-26T09:00:03Z' }));
  const rows = [
    { timestamp: '2026-09-26T09:00:00Z', type: 'session_meta', payload: { id: identity.threadId } },
    { timestamp: '2026-09-26T09:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: identity.turnId } },
    { timestamp: '2026-09-26T09:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: finalText }] } },
    { timestamp: '2026-09-26T09:00:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: identity.turnId, last_agent_message: finalText } },
  ];
  writeFileSync(join(dir, `rollout-2026-09-26T09-00-00-${identity.threadId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n'));
}

test('changed owner rejects an incomplete trace and native turn while unrelated work remains admissible', () => {
  const { home, clean } = fixture();
  try {
    const oldOwner = createNativeTurnAdmission(home, 'owner-a');
    oldOwner.admit(first, traceA);
    const directory = join(home, 'runtime', 'native-turn-admission');
    const before = readdirSync(directory).sort().map(name => readFileSync(join(directory, name), 'utf8'));
    const restarted = createNativeTurnAdmission(home, 'owner-b');
    expect(() => restarted.admit(first, traceA)).toThrow(NativeTurnReconciliationError);
    expect(() => restarted.admit(first, traceB)).toThrow(NativeTurnReconciliationError);
    expect(() => restarted.admit({ threadId: first.threadId, turnId: 'turn-two' }, 'trace_d004')).toThrow(NativeTurnReconciliationError);
    expect(readdirSync(directory).sort().map(name => readFileSync(join(directory, name), 'utf8'))).toEqual(before);
    restarted.admit(other, 'trace_c003').complete();
  } finally { clean(); }
});

test('an actual process exit leaves its native trace closed to a replacement owner', () => {
  const { home, clean } = fixture();
  try {
    const moduleUrl = new URL('../native-turn-admission.ts', import.meta.url).href;
    const script = `import { createNativeTurnAdmission } from ${JSON.stringify(moduleUrl)};
      createNativeTurnAdmission(process.env.CLW_TEST_ADMISSION_HOME, 'exited-owner')
        .admit({ threadId: 'thread-one', turnId: 'turn-one' }, 'trace_a001');
      process.exit(0);`;
    const child = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, CLW_TEST_ADMISSION_HOME: home },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.status).toBe(0);
    expect(child.error).toBeUndefined();
    const restarted = createNativeTurnAdmission(home, 'replacement-owner');
    expect(() => restarted.admit(first, traceA)).toThrow(NativeTurnReconciliationError);
    expect(() => restarted.admit({ threadId: first.threadId, turnId: 'turn-two' }, traceB)).toThrow(NativeTurnReconciliationError);
    restarted.admit(other, 'trace_c003').complete();
  } finally { clean(); }
});

test('bridge final alone does not release a restarted thread without native terminal evidence', () => {
  const { home, clean } = fixture();
  try {
    const oldOwner = createNativeTurnAdmission(home, 'owner-a');
    const pending = oldOwner.admit(first, traceA); // A tool batch or failed request is still incomplete.
    oldOwner.admit(first, traceB).complete();
    expect(() => createNativeTurnAdmission(home, 'owner-b').admit(first, 'trace_c003')).toThrow(NativeTurnReconciliationError);
    pending.complete();
    expect(() => createNativeTurnAdmission(home, 'owner-b').admit(first, 'trace_c003')).toThrow(NativeTurnReconciliationError);
    expect(() => createNativeTurnAdmission(home, 'owner-b').admit({ threadId: first.threadId, turnId: 'turn-two' }, 'trace_d004')).toThrow(NativeTurnReconciliationError);
  } finally { clean(); }
});

test('a new owner cannot resend an exact completed trace without persisted response replay', () => {
  const { home, clean } = fixture();
  try {
    const oldOwner = createNativeTurnAdmission(home, 'owner-a');
    oldOwner.admit(first, traceA).complete();
    const directory = join(home, 'runtime', 'native-turn-admission');
    const tracePath = join(directory, `trace-${traceA}.json`);
    const before = readFileSync(tracePath, 'utf8');
    const restarted = createNativeTurnAdmission(home, 'owner-b');
    expect(() => restarted.admit(first, traceA)).toThrow('exact replay of completed browser trace');
    expect(readFileSync(tracePath, 'utf8')).toBe(before);
    // A different trace cannot reopen the same native turn after a restart.
    expect(() => restarted.admit(first, traceB)).toThrow(NativeTurnReconciliationError);
  } finally { clean(); }
});

test('the same owner cannot resend a completed trace or change its revision into a new trace', () => {
  const { home, clean } = fixture();
  try {
    const admission = createNativeTurnAdmission(home, 'owner-a');
    admission.admit(first, traceA).complete();
    expect(() => admission.admit(first, traceA)).toThrow('exact replay of completed browser trace');
    expect(() => admission.admit(first, traceB)).toThrow('completed browser final');
  } finally { clean(); }
});

test('an incomplete same-owner trace reattaches only while its canonical browser round survives', () => {
  const { home, clean } = fixture();
  try {
    let canonical = true;
    const admission = createNativeTurnAdmission(home, 'owner-a', undefined,
      (threadId, turnId, traceId) => canonical && threadId === first.threadId && turnId === first.turnId && traceId === traceA);
    expect(admission.admit(first, traceA).replayOnly).toBe(false);
    expect(admission.admit(first, traceA).replayOnly).toBe(true); // In-memory canonical reconnect only.
    canonical = false; // Explicit stop, retirement or TTL eviction.
    expect(() => admission.admit(first, traceA)).toThrow('no longer available for replay');
  } finally { clean(); }
});

test('same-owner tool continuation does not depend on listing its historical archive', () => {
  const {home,clean}=fixture();
  try {
    const admission=createNativeTurnAdmission(home,'owner-a',undefined,()=>true);
    admission.admit(first,traceA);
    // Enumerating the archive now fails with ENOTDIR. The cold admission path
    // needs that audit; this already admitted tool loop needs its current owner.
    writeFileSync(join(home,'turn-sources'),'archive listing unavailable');
    expect(admission.admit(first,traceA).replayOnly).toBe(true);
    admission.admit(first,traceB);
    // A replacement owner still has to reconcile the original unfinished turn.
    expect(()=>createNativeTurnAdmission(home,'owner-b').admit(first,traceA)).toThrow();
  } finally {clean();}
});

test('the same owner cannot begin a different native turn while an earlier turn in that thread is unsettled', () => {
  const { home, clean } = fixture();
  try {
    const admission = createNativeTurnAdmission(home, 'owner-a');
    const pending = admission.admit(first, traceA);
    expect(() => admission.admit({ threadId: first.threadId, turnId: 'turn-two' }, traceB))
      .toThrow('Another native turn in this thread has not settled');
    pending.complete();
    admission.admit({ threadId: first.threadId, turnId: 'turn-two' }, traceB);
  } finally { clean(); }
});

test('a native turn without its thread identity cannot acquire browser-send admission', () => {
  const { home, clean } = fixture();
  try {
    const admission = createNativeTurnAdmission(home, 'owner-a');
    expect(() => admission.admit({ turnId: first.turnId }, traceA)).toThrow('Native thread or turn identity is unavailable');
    expect(() => admission.admit({ threadId: first.threadId }, traceA)).toThrow('Native thread or turn identity is unavailable');
    expect(readdirSync(home)).toEqual([]);
  } finally { clean(); }
});

test('a new owner admits a different turn only after the exact native Session final matches its saved review', () => {
  const { home, clean } = fixture();
  const original = { threadId: '01a0dcff-2a0c-7e60-a585-428fc2e1a661', turnId: '01a0dcff-2aee-7053-ac1b-d07b5421e3d4' };
  const next = { threadId: original.threadId, turnId: '01a0dcff-2aee-7053-ac1b-d07b5421e3d5' };
  try {
    createNativeTurnAdmission(home, 'owner-a').admit(original, traceA).complete();
    const restarted = createNativeTurnAdmission(home, 'owner-b', join(home, 'sessions'));
    expect(() => restarted.admit(next, traceB)).toThrow(NativeTurnReconciliationError);
    nativeTerminal(home, traceA, original);
    const reviewFile = join(home, 'turn-reviews', `${traceA}.json`);
    const exactReview = readFileSync(reviewFile, 'utf8');
    writeFileSync(reviewFile, JSON.stringify({ ...JSON.parse(exactReview), finalSha256: '0'.repeat(64) }));
    expect(() => restarted.admit(next, traceB)).toThrow(NativeTurnReconciliationError);
    writeFileSync(reviewFile, exactReview);
    restarted.admit(next, traceB).complete();
    const terminalKey = createHash('sha256').update(JSON.stringify([original.threadId, original.turnId])).digest('hex');
    const terminalFile = join(home, 'runtime', 'native-turn-admission', `native-terminal-${terminalKey}.json`);
    const cached = JSON.parse(readFileSync(terminalFile, 'utf8'));
    expect(cached).toMatchObject({ version: 1, identityKey: terminalKey, traceId: traceA,
      threadId: original.threadId, turnId: original.turnId, finalSha256: JSON.parse(exactReview).finalSha256 });
    expect(() => restarted.admit(original, 'trace_c003')).toThrow(NativeTurnReconciliationError);
  } finally { clean(); }
});

test('loss of the thread index cannot turn a prior gated browser final into permission for a new turn', () => {
  const { home, clean } = fixture();
  const original = { threadId: '01a0dcff-2a0c-7e60-a585-428fc2e1a661', turnId: '01a0dcff-2aee-7053-ac1b-d07b5421e3d4' };
  try {
    createNativeTurnAdmission(home, 'owner-a').admit(original, traceA).complete();
    nativeTerminal(home, traceA, original);
    const threadKey = createHash('sha256').update(original.threadId).digest('hex');
    rmSync(join(home, 'runtime', 'native-turn-admission', `thread-${threadKey}.json`));
    const restarted = createNativeTurnAdmission(home, 'owner-b', join(home, 'sessions'));
    expect(() => restarted.admit({ threadId: original.threadId, turnId: '01a0dcff-2aee-7053-ac1b-d07b5421e3d5' }, traceB))
      .toThrow('Native thread admission index is missing');
  } finally { clean(); }
});

test('structured compaction can finish under a different physical browser trace and still unlock the next native turn', () => {
  const { home, clean } = fixture();
  const original = { threadId: '01a0dcff-2a0c-7e60-a585-428fc2e1a661', turnId: '01a0dcff-2aee-7053-ac1b-d07b5421e3d4' };
  const next = { threadId: original.threadId, turnId: '01a0dcff-2aee-7053-ac1b-d07b5421e3d5' };
  try {
    createNativeTurnAdmission(home, 'owner-a').admit(original, traceA).complete();
    nativeTerminal(home, traceA, original, 'compacted context');
    rmSync(join(home, 'turns', `${traceA}.json`)); // The logical trace is not the physical handoff Send.
    const restarted = createNativeTurnAdmission(home, 'owner-b', join(home, 'sessions'));
    expect(() => restarted.admit(next, traceB)).toThrow(NativeTurnReconciliationError);
    const sourceFile = join(home, 'turn-sources', `${traceA}.json`);
    writeFileSync(sourceFile, JSON.stringify({ ...JSON.parse(readFileSync(sourceFile, 'utf8')), purpose: 'compaction' }));
    restarted.admit(next, traceB);
  } finally { clean(); }
});

test('a missing trace file cannot erase completed ownership recorded for that native turn', () => {
  const { home, clean } = fixture();
  try {
    createNativeTurnAdmission(home, 'owner-a').admit(first, traceA).complete();
    rmSync(join(home, 'runtime', 'native-turn-admission', `trace-${traceA}.json`));
    expect(() => createNativeTurnAdmission(home, 'owner-b').admit(first, traceA))
      .toThrow('exact replay of completed browser trace');
  } finally { clean(); }
});

test('legacy not-observed send and missing native final evidence remain ambiguous', () => {
  const { home, clean } = fixture();
  try {
    legacy(home, traceA, first, 'needs_reconciliation', 'not-observed');
    const restarted = createNativeTurnAdmission(home, 'owner-b');
    expect(() => restarted.admit(first, traceA)).toThrow('replay of historical browser trace');
    expect(() => restarted.admit(first, traceB)).toThrow(NativeTurnReconciliationError);
    expect(() => restarted.admit({ threadId: first.threadId, turnId: 'turn-two' }, 'trace_d004')).toThrow(NativeTurnReconciliationError);
    restarted.admit(other, 'trace_c003');
    legacy(home, traceA, first, 'completed', 'not-observed', true);
    expect(() => restarted.admit(first, traceA)).toThrow(NativeTurnReconciliationError);
    legacy(home, traceA, first, 'completed', 'confirmed');
    expect(() => restarted.admit(first, traceA)).toThrow(NativeTurnReconciliationError);
    legacy(home, traceA, first, 'completed', 'confirmed', true);
    expect(() => restarted.admit(first, traceA)).toThrow('replay of historical browser trace');
    expect(() => restarted.admit({ threadId: first.threadId, turnId: 'turn-two' }, traceB)).toThrow(NativeTurnReconciliationError);
  } finally { clean(); }
});

test('a historical browser final releases a different native turn only after CLI import and exact Session proof', () => {
  const { home, clean } = fixture();
  const legacyTrace = 'a1b2c3d4e5f6';
  const original = { threadId: '01a0dcff-2a0c-7e60-a585-428fc2e1a661', turnId: '01a0dcff-2aee-7053-ac1b-d07b5421e3d4' };
  const next = { threadId: original.threadId, turnId: '01a0dcff-2aee-7053-ac1b-d07b5421e3d5' };
  try {
    legacy(home, legacyTrace, original, 'completed', 'confirmed', true);
    const restarted = createNativeTurnAdmission(home, 'owner-b', join(home, 'sessions'));
    expect(() => restarted.admit(next, traceB)).toThrow(NativeTurnReconciliationError);
    nativeTerminal(home, legacyTrace, original);
    const sourceFile = join(home, 'turn-sources', `${legacyTrace}.json`);
    writeFileSync(sourceFile, JSON.stringify({ traceId: legacyTrace, ...original, model: 'chatgpt-web/extra-high' }));
    writeFileSync(join(home, 'turns', `${legacyTrace}.json`), JSON.stringify({ traceId: legacyTrace,
      status: 'completed', submission: 'confirmed', startedAt: '2026-09-26T09:00:01Z' }));
    expect(() => restarted.admit(next, traceB)).toThrow(NativeTurnReconciliationError); // Session alone is insufficient.
    const packet = join(home, 'packet');
    mkdirSync(packet);
    writeFileSync(join(packet, 'execution.json'), JSON.stringify({ state: 'turn_completed', exitCode: 0,
      model: 'chatgpt-web/extra-high', sourceThread: original.threadId,
      startedAt: '2026-09-26T09:00:00Z', endedAt: '2026-09-26T09:00:04Z' }));
    writeFileSync(join(packet, 'final.md'), 'native final');
    writeFileSync(join(packet, 'events.jsonl'), [
      { type: 'thread.started', thread_id: original.threadId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'native final' } },
      { type: 'turn.completed' },
    ].map(row => JSON.stringify(row)).join('\n'));
    expect(historicalReview.importReview(home, legacyTrace, packet, { sessionsRoot: join(home, 'sessions') }).exactNativeTurn).toBe(true);
    restarted.admit(next, traceB).complete();
    expect(() => restarted.admit(original, legacyTrace)).toThrow('replay of historical browser trace');
  } finally { clean(); }
});

test('a source-only historical trace is also permanently ineligible for exact replay', () => {
  const { home, clean } = fixture();
  try {
    mkdirSync(join(home, 'turn-sources'), { recursive: true });
    writeFileSync(join(home, 'turn-sources', `${traceA}.json`), JSON.stringify({ traceId: traceA, ...first }));
    const restarted = createNativeTurnAdmission(home, 'owner-b');
    expect(() => restarted.admit(first, traceA)).toThrow('replay of historical browser trace');
    expect(() => restarted.admit({ threadId: first.threadId, turnId: 'turn-two' }, traceB))
      .toThrow(NativeTurnReconciliationError);
  } finally { clean(); }
});

test('exclusive admission lock prevents competing owners from racing the first write', () => {
  const { home, clean } = fixture();
  try {
    const directory = join(home, 'runtime', 'native-turn-admission');
    const threadKey = createHash('sha256').update(first.threadId).digest('hex');
    const lock = join(directory, `lock-owner-${threadKey}`);
    mkdirSync(lock, { recursive: true });
    expect(() => createNativeTurnAdmission(home, 'owner-b').admit(first, traceA)).toThrow(NativeTurnReconciliationError);
    expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([]);
    rmSync(lock, { recursive: true });
    createNativeTurnAdmission(home, 'owner-a').admit(first, traceA);
    expect(() => createNativeTurnAdmission(home, 'owner-b').admit(first, traceB)).toThrow(NativeTurnReconciliationError);
  } finally { clean(); }
});

test('an unreadable matching admission record fails closed without overwriting evidence', () => {
  const { home, clean } = fixture();
  try {
    const oldOwner = createNativeTurnAdmission(home, 'owner-a');
    oldOwner.admit(first, traceA);
    const directory = join(home, 'runtime', 'native-turn-admission');
    const identityName = readdirSync(directory).find(name => name.startsWith('identity-'))!;
    writeFileSync(join(directory, identityName), '{broken');
    expect(() => createNativeTurnAdmission(home, 'owner-b').admit(first, traceA)).toThrow(NativeTurnReconciliationError);
    expect(readFileSync(join(directory, identityName), 'utf8')).toBe('{broken');
    createNativeTurnAdmission(home, 'owner-b').admit(other, traceB);
  } finally { clean(); }
});

test('CLW wrapper rejects a restarted turn before delegating to broker or browser work', async () => {
  const { home, clean } = fixture();
  const nativeTurn = '01a0dc7b-2a50-7140-a55b-eed50ff96b03';
  const parsed: any = {
    modelId: 'gpt-5.6-pro', context: { messages: [] }, options: { reasoning: 'max' },
    _rawBody: {
      model: 'chatgpt-web/pro', client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: '01a0dc7b-2a50-7140-a55b-eed50ff96b02', turn_id: nativeTurn }) },
      input: [{ type: 'message', role: 'user', id: 'message-1', content: 'fixture', internal_chat_message_metadata_passthrough: { turn_id: nativeTurn } }],
    },
  };
  let delegated = 0;
  const factory = () => ({ name: 'fixture', async runTurn() { delegated += 1; } });
  try {
    await observedAdapter({ adapter: 'chatgpt-web', baseUrl: 'http://127.0.0.1:1' }, home, factory as any, 'owner-a')
      .runTurn(parsed, { headers: new Headers() }, () => {});
    const events: any[] = [];
    await observedAdapter({ adapter: 'chatgpt-web', baseUrl: 'http://127.0.0.1:1' }, home, factory as any, 'owner-b')
      .runTurn(parsed, { headers: new Headers() }, event => events.push(event));
    expect(delegated).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required', retryable: false });
  } finally { clean(); }
});

test('a done marker settles only a saved public final from a resolved adapter run', async () => {
  const { home, clean } = fixture();
  const parsedFor = (turnId: string, threadId = '01a0dc7b-2a50-7140-a55b-eed50ff96b02'): any => ({
    modelId: 'gpt-5.6-pro', context: { messages: [] }, options: { reasoning: 'max' },
    _rawBody: {
      model: 'chatgpt-web/pro', client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
      input: [{ type: 'message', role: 'user', id: 'message-1', content: 'fixture', internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
    },
  });
  const provider: any = { adapter: 'chatgpt-web', baseUrl: 'http://127.0.0.1:1' };
  const incoming = { headers: new Headers() };
  const interruptedTurn = parsedFor('01a0dc7b-2a50-7140-a55b-eed50ff96b04');
  const thrownTurn = parsedFor('01a0dc7b-2a50-7140-a55b-eed50ff96b05', '01a0dc7b-2a50-7140-a55b-eed50ff96b09');
  const completedTurn = parsedFor('01a0dc7b-2a50-7140-a55b-eed50ff96b06', '01a0dc7b-2a50-7140-a55b-eed50ff96b07');
  let delegated = 0;
  const restartedFactory = () => ({ name: 'fixture', async runTurn() { delegated += 1; } });
  try {
    await observedAdapter(provider, home, (() => ({ name: 'fixture', async runTurn(_p: any, _i: any, emit: any) {
      emit({ type: 'error', message: 'earlier failure' });
      emit({ type: 'text_delta', phase: 'final_answer', text: 'reported final' });
      emit({ type: 'done', endTurn: true });
    } })) as any, 'owner-a').runTurn(interruptedTurn, incoming, () => {});
    await expect(observedAdapter(provider, home, (() => ({ name: 'fixture', async runTurn(_p: any, _i: any, emit: any) {
      emit({ type: 'text_delta', phase: 'final_answer', text: 'reported final' });
      emit({ type: 'done', endTurn: true });
      throw new Error('delivery failed after final event');
    } })) as any, 'owner-a').runTurn(thrownTurn, incoming, () => {})).rejects.toThrow('delivery failed after final event');
    await observedAdapter(provider, home, (() => ({ name: 'fixture', async runTurn(_p: any, _i: any, emit: any) {
      emit({ type: 'text_delta', phase: 'final_answer', text: 'observed final' });
      emit({ type: 'done', endTurn: true });
    } })) as any, 'owner-a').runTurn(completedTurn, incoming, () => {});

    for (const parsed of [interruptedTurn, thrownTurn]) {
      const events: any[] = [];
      await observedAdapter(provider, home, restartedFactory as any, 'owner-b').runTurn(parsed, incoming, event => events.push(event));
      expect(events[0]).toMatchObject({ type: 'error', code: 'native_turn_reconciliation_required' });
    }
    expect(delegated).toBe(0);
    const completedReplay: any[] = [];
    await observedAdapter(provider, home, restartedFactory as any, 'owner-b').runTurn(completedTurn, incoming, event => completedReplay.push(event));
    expect(completedReplay[0]).toMatchObject({ type: 'error', code: 'native_turn_reconciliation_required' });
    const nextTurn = parsedFor('01a0dc7b-2a50-7140-a55b-eed50ff96b08', '01a0dc7b-2a50-7140-a55b-eed50ff96b07');
    const nextEvents: any[] = [];
    await observedAdapter(provider, home, restartedFactory as any, 'owner-b').runTurn(nextTurn, incoming, event => nextEvents.push(event));
    expect(nextEvents[0]).toMatchObject({ type: 'error', code: 'native_turn_reconciliation_required' });
    expect(delegated).toBe(0);
  } finally { clean(); }
});
