import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { observedAdapter } from '../observed-adapter';
import { finalReplayBinding } from '../final-replay-journal';
import { chatGptWebTraceId } from '../upstream/src/adapters/chatgpt-web';
import { parseRequest } from '../upstream/src/responses/parser';
import { responseRequest } from '../upstream/src/server';
import { defaultConfig } from '../upstream/src/config';

const threadId = '01a0dc7b-2a50-7140-a55b-eed50ff96b02';
const turnId = '01a0dc7b-2a50-7140-a55b-eed50ff96b03';
const provider: any = { adapter: 'chatgpt-web', baseUrl: 'http://127.0.0.1:1' };
const incoming = { headers: new Headers() };

function raw(overrides: Record<string, unknown> = {}) {
  return {
    model: 'chatgpt-web/high', stream: true,
    reasoning: { effort: 'max', summary: 'none' },
    instructions: 'Keep the fixture private and answer the user.',
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
    input: [{ type: 'message', role: 'user', id: 'message-1',
      content: [{ type: 'input_text', text: 'Answer this fixture.' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
    ...overrides,
  };
}
function historicalRequest(output = 'prior completed') {
  return raw({ previous_response_id: 'resp_complete_prior', input: [
    { type: 'function_call', call_id: 'call_prior', name: 'exec_command', arguments: '{"cmd":"echo prior"}' },
    { type: 'function_call_output', call_id: 'call_prior', output },
    ...raw().input,
  ] });
}
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'clw-final-replay-'));
  const clean = () => rmSync(home, { recursive: true, force: true });
  return { home, clean };
}
function eventsRun(events: any[], counters: { factories: number; sends: number }) {
  return () => {
    counters.factories++;
    return { name: 'offline-fixture', async runTurn(_parsed: any, _incoming: any, emit: (event: any) => void) {
      counters.sends++;
      for (const event of events) emit(event);
    } };
  };
}
const finalEvents = [
  { type: 'text_delta', text: 'The final answer.', phase: 'final_answer' },
  { type: 'done', stopReason: 'stop', endTurn: true },
];
const journalPath = (home: string, parsed: any) => join(home, 'runtime', 'native-final-replay', `${chatGptWebTraceId(provider, parsed)}.json`);

test('real parser binds full canonical body, model and effort with optional undefined fields', () => {
  const parsed = parseRequest(raw());
  parsed.options.temperature = undefined;
  const trace = chatGptWebTraceId(provider, parsed);
  const first = finalReplayBinding(parsed, { threadId, turnId }, trace);
  const reordered = parseRequest({ ...raw(), instructions: raw().instructions });
  expect(finalReplayBinding(reordered, { threadId, turnId }, trace).requestSha256).toBe(first.requestSha256);
  expect(finalReplayBinding(parseRequest(raw({ instructions: 'Changed full-body field.' })), { threadId, turnId }, trace).requestSha256).not.toBe(first.requestSha256);
  expect(finalReplayBinding(parseRequest(raw({ reasoning: { effort: 'high' } })), { threadId, turnId }, trace).requestSha256).not.toBe(first.requestSha256);
  const toolHistory = parseRequest(historicalRequest());
  toolHistory._replayPrefixLen = 2;
  const historicalBinding = finalReplayBinding(toolHistory, { threadId, turnId }, trace);
  expect(historicalBinding.requestSha256).not.toBe(first.requestSha256);
  const changedHistory = parseRequest(historicalRequest('different tool result'));
  changedHistory._replayPrefixLen = 2;
  expect(finalReplayBinding(changedHistory, { threadId, turnId }, trace).requestSha256).not.toBe(historicalBinding.requestSha256);
});

test('partial previous_response_id is rejected before admission or adapter construction', async () => {
  const { home, clean } = harness();
  const parsed = parseRequest(raw({ previous_response_id: 'resp_missing_history' }));
  let factories = 0;
  try {
    const events: any[] = [];
    await observedAdapter(provider, home, (() => { factories++; return eventsRun(finalEvents, { factories: 0, sends: 0 })(); }) as any, 'owner-a')
      .runTurn(parsed, incoming, event => events.push(event));
    expect(events[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required' });
    expect(factories).toBe(0);
    expect(() => readdirSync(join(home, 'runtime', 'native-turn-admission'))).toThrow();
  } finally { clean(); }
});

test('completed final with expanded previous_response_id tool history is journaled and replayed exactly', async () => {
  const { home, clean } = harness();
  const counters = { factories: 0, sends: 0 };
  const expanded = historicalRequest();
  const parsed = parseRequest(expanded);
  parsed._replayPrefixLen = 2;
  try {
    const first: any[] = [];
    await observedAdapter(provider, home, eventsRun(finalEvents, counters) as any, 'owner-a')
      .runTurn(parsed, incoming, event => first.push(event));
    expect(first).toEqual(finalEvents);
    expect(counters).toEqual({ factories: 1, sends: 1 });
    expect(JSON.parse(readFileSync(journalPath(home, parsed), 'utf8')).events).toEqual(finalEvents);

    const retry = parseRequest(expanded);
    retry._replayPrefixLen = 2;
    const second: any[] = [];
    await observedAdapter(provider, home, eventsRun([], counters) as any, 'owner-b')
      .runTurn(retry, incoming, event => second.push(event));
    expect(second).toEqual(finalEvents);
    expect(counters).toEqual({ factories: 1, sends: 1 });
  } finally { clean(); }
});

test('initial final is committed before its terminal event and another process owner replays without constructing a Web adapter', async () => {
  const { home, clean } = harness();
  const counters = { factories: 0, sends: 0 };
  const parsed = parseRequest(raw());
  const seen: any[] = [];
  try {
    const first = observedAdapter(provider, home, eventsRun(finalEvents, counters) as any, 'owner-a');
    await first.runTurn(parsed, incoming, event => {
      if (event.type === 'done') {
        expect(JSON.parse(readFileSync(journalPath(home, parsed), 'utf8')).events.at(-1).type).toBe('done');
      }
      seen.push(event);
    });
    expect(counters).toEqual({ factories: 1, sends: 1 });
    expect(seen).toEqual(finalEvents);
    const replayed: any[] = [];
    await observedAdapter(provider, home, eventsRun([], counters) as any, 'owner-b').runTurn(parseRequest(raw()), incoming, event => replayed.push(event));
    expect(replayed).toEqual(finalEvents);
    expect(counters).toEqual({ factories: 1, sends: 1 });
  } finally { clean(); }
});

test('separate Bun processes replay exact historical tool input but reject changed tool output', () => {
  const { home, clean } = harness();
  const adapterUrl = pathToFileURL(join(import.meta.dir, '..', 'observed-adapter.ts')).href;
  const parserUrl = pathToFileURL(join(import.meta.dir, '..', 'upstream', 'src', 'responses', 'parser.ts')).href;
  const marker = join(home, 'send-count.txt');
  const run = (owner: string, output = 'prior completed') => {
    const script = `
      import { observedAdapter } from ${JSON.stringify(adapterUrl)};
      import { parseRequest } from ${JSON.stringify(parserUrl)};
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      const marker = ${JSON.stringify(marker)};
      const factory = () => ({ name: 'offline-child', async runTurn(_p, _i, emit) {
        const count = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
        writeFileSync(marker, String(count + 1));
        emit({ type: 'text_delta', text: 'The final answer.', phase: 'final_answer' });
        emit({ type: 'done', stopReason: 'stop', endTurn: true });
      } });
      const seen = [];
      const parsed = parseRequest(${JSON.stringify(historicalRequest(output))});
      parsed._replayPrefixLen = 2;
      await observedAdapter({ adapter: 'chatgpt-web', baseUrl: 'http://127.0.0.1:1' }, ${JSON.stringify(home)}, factory, ${JSON.stringify(owner)})
        .runTurn(parsed, { headers: new Headers() }, event => seen.push(event));
      process.stdout.write(JSON.stringify(seen));
    `;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15_000 });
    if (child.status !== 0) throw new Error(`offline child failed: ${child.stderr}`);
    return JSON.parse(child.stdout);
  };
  try {
    expect(run('child-owner-a')).toEqual(finalEvents);
    expect(run('child-owner-b')).toEqual(finalEvents);
    const journal = journalPath(home, parseRequest(historicalRequest()));
    const originalJournal = readFileSync(journal, 'utf8');
    expect(run('child-owner-c', 'changed prior output')).toEqual([expect.objectContaining({
      type: 'error', status: 409, code: 'native_turn_reconciliation_required', retryable: false,
      message: expect.stringContaining('completed native response replay journal'),
    })]);
    expect(readFileSync(journal, 'utf8')).toBe(originalJournal);
    expect(readFileSync(marker, 'utf8')).toBe('1');
  } finally { clean(); }
});

test('same trace with changed canonical request fails 409 and keeps the original journal', async () => {
  const { home, clean } = harness();
  const counters = { factories: 0, sends: 0 };
  try {
    const original = parseRequest(raw());
    await observedAdapter(provider, home, eventsRun(finalEvents, counters) as any, 'owner-a').runTurn(original, incoming, () => {});
    const before = readFileSync(journalPath(home, original), 'utf8');
    const changed = parseRequest(raw({ instructions: 'A different developer instruction.' }));
    expect(chatGptWebTraceId(provider, changed)).toBe(chatGptWebTraceId(provider, original));
    const events: any[] = [];
    await observedAdapter(provider, home, eventsRun([], counters) as any, 'owner-b').runTurn(changed, incoming, event => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required', retryable: false });
    expect(counters).toEqual({ factories: 1, sends: 1 });
    expect(readFileSync(journalPath(home, original), 'utf8')).toBe(before);
  } finally { clean(); }
});

test('tool-call branch remains a gated non-replayable trace', async () => {
  const { home, clean } = harness();
  const counters = { factories: 0, sends: 0 };
  const parsed = parseRequest(raw());
  const toolEvents = [
    { type: 'tool_call_start', id: 'call_1', name: 'exec_command' },
    { type: 'tool_call_delta', arguments: '{"cmd":"echo fixture"}' },
    { type: 'tool_call_end' },
    { type: 'done', stopReason: 'tool_use', endTurn: false },
  ];
  try {
    await observedAdapter(provider, home, eventsRun(toolEvents, counters) as any, 'owner-a').runTurn(parsed, incoming, () => {});
    expect(readdirSync(join(home, 'runtime', 'native-turn-admission')).some(name => name.startsWith('trace-'))).toBe(true);
    expect(() => readFileSync(journalPath(home, parsed), 'utf8')).toThrow();
    const retry: any[] = [];
    await observedAdapter(provider, home, eventsRun([], counters) as any, 'owner-b').runTurn(parseRequest(raw()), incoming, event => retry.push(event));
    expect(retry[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required' });
    expect(counters).toEqual({ factories: 1, sends: 1 });
  } finally { clean(); }
});

test('compaction final keeps the original gate and has no final-only journal', async () => {
  const { home, clean } = harness();
  const counters = { factories: 0, sends: 0 };
  const parsed = parseRequest(raw());
  parsed._compactionRequest = true;
  try {
    await observedAdapter(provider, home, eventsRun(finalEvents, counters) as any, 'owner-a').runTurn(parsed, incoming, () => {});
    expect(() => readFileSync(journalPath(home, parsed), 'utf8')).toThrow();
    const retry: any[] = [];
    const again = parseRequest(raw());
    again._compactionRequest = true;
    await observedAdapter(provider, home, eventsRun([], counters) as any, 'owner-b').runTurn(again, incoming, event => retry.push(event));
    expect(retry[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required' });
    expect(counters).toEqual({ factories: 1, sends: 1 });
  } finally { clean(); }
});

test('incomplete and failed terminals keep their original output but never become replayable', async () => {
  for (const terminal of [
    { type: 'done', stopReason: 'max_tokens', endTurn: true },
    { type: 'incomplete', reason: 'max_output_tokens' },
    { type: 'error', message: 'offline fixture failure' },
  ]) {
    const { home, clean } = harness();
    const counters = { factories: 0, sends: 0 };
    const parsed = parseRequest(raw());
    const original = [{ type: 'text_delta', text: 'Partial answer', phase: 'final_answer' }, terminal];
    try {
      const seen: any[] = [];
      await observedAdapter(provider, home, eventsRun(original, counters) as any, 'owner-a').runTurn(parsed, incoming, event => seen.push(event));
      expect(seen).toEqual(original);
      expect(() => readFileSync(journalPath(home, parsed), 'utf8')).toThrow();
      const retry: any[] = [];
      await observedAdapter(provider, home, eventsRun([], counters) as any, 'owner-b').runTurn(parseRequest(raw()), incoming, event => retry.push(event));
      expect(retry[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required' });
      expect(counters).toEqual({ factories: 1, sends: 1 });
    } finally { clean(); }
  }
});

test('adapter crash after a proposed done cannot expose terminal or make a replay journal', async () => {
  const { home, clean } = harness();
  const parsed = parseRequest(raw());
  let sends = 0;
  const seen: any[] = [];
  try {
    const crashing = () => ({ name: 'crash-fixture', async runTurn(_p: any, _i: any, emit: (event: any) => void) {
      sends++;
      finalEvents.forEach(emit);
      throw new Error('crash after proposed terminal');
    } });
    await expect(observedAdapter(provider, home, crashing as any, 'owner-a').runTurn(parsed, incoming, event => seen.push(event)))
      .rejects.toThrow('crash after proposed terminal');
    expect(seen.map(event => event.type)).toEqual(['text_delta']);
    expect(() => readFileSync(journalPath(home, parsed), 'utf8')).toThrow();
    const retry: any[] = [];
    await observedAdapter(provider, home, (() => ({ name: 'no-send', async runTurn() { sends++; } })) as any, 'owner-b')
      .runTurn(parseRequest(raw()), incoming, event => retry.push(event));
    expect(retry[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required' });
    expect(sends).toBe(1);
  } finally { clean(); }
});

test('an error after a proposed done suppresses that terminal and cannot journal it', async () => {
  const { home, clean } = harness();
  const parsed = parseRequest(raw());
  const seen: any[] = [];
  try {
    const faulty = [...finalEvents, { type: 'error', message: 'late adapter failure' }];
    await observedAdapter(provider, home, eventsRun(faulty, { factories: 0, sends: 0 }) as any, 'owner-a')
      .runTurn(parsed, incoming, event => seen.push(event));
    expect(seen.map(event => event.type)).toEqual(['text_delta', 'error']);
    expect(() => readFileSync(journalPath(home, parsed), 'utf8')).toThrow();
  } finally { clean(); }
});

test('journal write failure after admission completion emits an error before terminal and remains blocked on restart', async () => {
  const { home, clean } = harness();
  const counters = { factories: 0, sends: 0 };
  const parsed = parseRequest(raw());
  try {
    mkdirSync(join(home, 'runtime'), { recursive: true });
    writeFileSync(join(home, 'runtime', 'native-final-replay'), 'block the journal directory');
    const events: any[] = [];
    await observedAdapter(provider, home, eventsRun(finalEvents, counters) as any, 'owner-a').runTurn(parsed, incoming, event => events.push(event));
    expect(events.map(event => event.type)).toEqual(['text_delta', 'error']);
    expect(events[1]).toMatchObject({ status: 409, code: 'native_turn_reconciliation_required' });
    const retry: any[] = [];
    await observedAdapter(provider, home, eventsRun([], counters) as any, 'owner-b').runTurn(parseRequest(raw()), incoming, event => retry.push(event));
    expect(retry[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required' });
    expect(counters).toEqual({ factories: 1, sends: 1 });
  } finally { clean(); }
});

test('corrupt or missing final journal does not bypass the admission gate', async () => {
  for (const corruption of ['{broken', null]) {
    const { home, clean } = harness();
    const counters = { factories: 0, sends: 0 };
    try {
      const parsed = parseRequest(raw());
      await observedAdapter(provider, home, eventsRun(finalEvents, counters) as any, 'owner-a').runTurn(parsed, incoming, () => {});
      if (corruption === null) rmSync(journalPath(home, parsed));
      else writeFileSync(journalPath(home, parsed), corruption);
      const retry: any[] = [];
      await observedAdapter(provider, home, eventsRun([], counters) as any, 'owner-b').runTurn(parseRequest(raw()), incoming, event => retry.push(event));
      expect(retry[0]).toMatchObject({ type: 'error', status: 409, code: 'native_turn_reconciliation_required' });
      expect(counters).toEqual({ factories: 1, sends: 1 });
    } finally { clean(); }
  }
});

test('Responses SSE retry retains response and item IDs while doing one offline adapter run', async () => {
  const { home, clean } = harness();
  const counters = { factories: 0, sends: 0 };
  const send = async (owner: string) => {
    const response = await responseRequest(new Request('http://127.0.0.1/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(raw()),
    }), defaultConfig('full'), provider => observedAdapter(provider, home, eventsRun(finalEvents, counters) as any, owner), { rememberState: false });
    expect(response.status).toBe(200);
    const wire = await response.text();
    const completed = JSON.parse(wire.split('\n').find(line => line.startsWith('data: {"type":"response.completed"'))!.slice(6));
    return { wire, completed };
  };
  try {
    const initial = await send('owner-a');
    const replay = await send('owner-b');
    expect(counters).toEqual({ factories: 1, sends: 1 });
    expect(replay.completed.response.id).toBe(initial.completed.response.id);
    expect(replay.completed.response.output).toEqual(initial.completed.response.output);
    expect(replay.completed.response.created_at).toBe(initial.completed.response.created_at);
    const semantic = (wire: string) => wire.split('\n\n').filter(frame => frame.startsWith('event: response.') && !frame.startsWith('event: response.heartbeat'));
    expect(semantic(replay.wire)).toEqual(semantic(initial.wire));
  } finally { clean(); }
});
