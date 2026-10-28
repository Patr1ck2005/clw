'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createResultStore, ResultStoreError, DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES } = require('../apps/codex-web-bridge/result-store.cjs');

const principal = 'fixture-authorization-value-not-for-storage';
const day = 24 * 60 * 60 * 1000;
const tempParent = path.resolve(__dirname, '../.local');

async function fixture(t, options = {}) {
  await fs.mkdir(tempParent, { recursive: true });
  const home = await fs.mkdtemp(path.join(tempParent, 'result-store-tests-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, store: createResultStore({ home, ...options }) };
}

async function completeRead(store, resultId, format = 'text', maxBytes = 4096) {
  let offset = 0;
  const pieces = [];
  for (;;) {
    const page = await store.read({ result_id: resultId, offset, max_bytes: maxBytes, format }, principal);
    pieces.push(format === 'base64' ? Buffer.from(page.data, 'base64') : Buffer.from(page.data, 'utf8'));
    assert.ok(page.bytes_returned <= maxBytes);
    assert.equal(page.next_offset, offset + page.bytes_returned);
    if (page.eof) break;
    assert.ok(page.next_offset > offset, 'pagination must make progress');
    offset = page.next_offset;
  }
  return Buffer.concat(pieces);
}

const coded = code => error => error instanceof ResultStoreError && error.code === code;

test('durable raw bytes, digest, immutable metadata, principal hashing, and restart read', async t => {
  const { home, store } = await fixture(t);
  const raw = Buffer.from(JSON.stringify({ result: { content: [{ type: 'text', text: '任务完整结果\n😀' }] } }));
  const ref = await store.put(raw, { principal, contentType: 'application/json', status: 200, tool: 'command_status' });
  assert.match(ref.result_id, /^result_[a-f0-9]{32}$/);
  assert.equal(ref.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(ref.raw_bytes, raw.length);
  assert.equal(ref.text_bytes, raw.length);
  assert.equal(ref.complete, true);
  assert.equal(ref.tool, 'command_status');
  assert.equal(ref.status, 200);
  const directory = path.join(home, ref.result_id);
  const originalMeta = await fs.readFile(path.join(directory, 'meta.json'), 'utf8');
  assert.ok(!originalMeta.includes(principal));
  assert.match(JSON.parse(originalMeta).principal_hash, /^[a-f0-9]{64}$/);
  assert.ok(!(await fs.readdir(directory)).includes('text.utf8'), 'raw UTF8 does not duplicate disk usage');
  const restarted = createResultStore({ home });
  assert.deepEqual(await completeRead(restarted, ref.result_id), raw);
  assert.equal(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'), originalMeta);
});

test('UTF8 byte pagination never splits characters and reconstructs exact Unicode', async t => {
  const { store } = await fixture(t);
  const text = 'a中😀e\u0301\u0000\n汉字🧬xyz'.repeat(7);
  const ref = await store.put(text, { principal });
  const reconstructed = await completeRead(store, ref.result_id, 'text', 4);
  assert.equal(reconstructed.toString('utf8'), text);
  await assert.rejects(store.read({ result_id: ref.result_id, offset: 2, max_bytes: 4 }, principal), coded('RESULT_INVALID_ARGUMENT'));
});

test('base64 pages preserve arbitrary binary bytes and exact SHA256', async t => {
  const { store } = await fixture(t);
  const raw = crypto.randomBytes(9999);
  const ref = await store.put(raw, { principal, contentType: 'application/octet-stream' });
  assert.deepEqual(await completeRead(store, ref.result_id, 'base64', 127), raw);
  assert.equal(ref.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
});

test('provided projection has independent UTF8 paging while retaining exact original', async t => {
  const { home, store } = await fixture(t);
  const raw = crypto.randomBytes(1000);
  const ref = await store.put(raw, { principal, projection: '可读摘要 😀\n完整元数据' });
  assert.equal((await completeRead(store, ref.result_id, 'text', 4)).toString('utf8'), '可读摘要 😀\n完整元数据');
  let state = JSON.parse(await fs.readFile(path.join(home, ref.result_id, 'read.json'), 'utf8'));
  assert.equal(state.fully_read, false, 'summary consumption does not discard unread original bytes');
  assert.deepEqual(await completeRead(store, ref.result_id, 'base64'), raw);
  state = JSON.parse(await fs.readFile(path.join(home, ref.result_id, 'read.json'), 'utf8'));
  assert.equal(state.fully_read, true);
});

test('read defaults64KiB and rejects requests above hard512KiB rather than silently expanding', async t => {
  const { store } = await fixture(t);
  const ref = await store.put('x'.repeat(MAX_PAGE_BYTES + 100), { principal });
  const page = await store.read({ result_id: ref.result_id }, principal);
  assert.equal(page.bytes_returned, DEFAULT_PAGE_BYTES);
  assert.equal(page.eof, false);
  assert.equal((await store.read({ result_id: ref.result_id, max_bytes: MAX_PAGE_BYTES }, principal)).bytes_returned, MAX_PAGE_BYTES);
  await assert.rejects(store.read({ result_id: ref.result_id, max_bytes: MAX_PAGE_BYTES + 1 }, principal), coded('RESULT_INVALID_ARGUMENT'));
});

test('unknown references, another principal, invalid offsets, and invalid formats are bounded errors', async t => {
  const { store } = await fixture(t);
  const ref = await store.put('known result', { principal });
  await assert.rejects(store.read({ result_id: ref.result_id }, 'another-account'), coded('RESULT_NOT_FOUND'));
  await assert.rejects(store.read({ result_id: '../../CURRENT.md' }, principal), coded('RESULT_NOT_FOUND'));
  await assert.rejects(store.read({ result_id: 'result_' + 'f'.repeat(32) }, principal), coded('RESULT_NOT_FOUND'));
  for (const query of [{ offset: -1 }, { offset: 0.5 }, { offset: 99999 }, { max_bytes: 0 }, { max_bytes: 3 }, { format: 'json' }]) {
    await assert.rejects(store.read({ result_id: ref.result_id, ...query }, principal), coded('RESULT_INVALID_ARGUMENT'));
  }
  await assert.rejects(store.put('no binding'), coded('RESULT_INVALID_PRINCIPAL'));
});

test('entry limit removes partial staging and preserves already retained result', async t => {
  const { home, store } = await fixture(t, { maxEntryBytes: 10 });
  const existing = await store.put('keep', { principal });
  await assert.rejects(store.put('x'.repeat(11), { principal }), coded('RESULT_TOO_LARGE'));
  assert.equal((await store.read({ result_id: existing.result_id }, principal)).data, 'keep');
  assert.ok(!(await fs.readdir(home)).some(name => name.startsWith('.pending-')));
});

test('fresh unread entry capacity rejects new result, never silently evicting it', async t => {
  const { store } = await fixture(t, { maxEntries: 2 });
  const first = await store.put('first-unread', { principal });
  const second = await store.put('second-unread', { principal });
  await assert.rejects(store.put('third', { principal }), coded('RESULT_STORE_FULL'));
  assert.equal((await store.read({ result_id: first.result_id }, principal)).data, 'first-unread');
  assert.equal((await store.read({ result_id: second.result_id }, principal)).data, 'second-unread');
});

test('last page alone does not acknowledge skipped bytes; all pages permit oldest consumed eviction', async t => {
  const { store } = await fixture(t, { maxEntries: 1 });
  const ref = await store.put('0123456789abcdef', { principal });
  const last = await store.read({ result_id: ref.result_id, offset: 12, max_bytes: 4 }, principal);
  assert.equal(last.eof, true);
  await assert.rejects(store.put('new', { principal }), coded('RESULT_STORE_FULL'));
  await completeRead(store, ref.result_id, 'text', 4);
  const next = await store.put('new', { principal });
  await assert.rejects(store.read({ result_id: ref.result_id }, principal), coded('RESULT_NOT_FOUND'));
  assert.equal((await store.read({ result_id: next.result_id }, principal)).data, 'new');
});

test('unread entries survive24h then become eligible for oldest-first quota cleanup', async t => {
  let clock = 1000000;
  const { store } = await fixture(t, { maxEntries: 1, now: () => clock });
  const old = await store.put('retained24h', { principal });
  clock += day - 1;
  await assert.rejects(store.put('early', { principal }), coded('RESULT_STORE_FULL'));
  clock++;
  const fresh = await store.put('new after24h', { principal });
  await assert.rejects(store.read({ result_id: old.result_id }, principal), coded('RESULT_NOT_FOUND'));
  assert.equal((await store.read({ result_id: fresh.result_id }, principal)).data, 'new after24h');
});

test('disk quota applies during stream spool and does not remove fresh unread result', async t => {
  const { home, store } = await fixture(t, { maxBytes: 28000, maxEntryBytes: 20000 });
  const ref = await store.put('a'.repeat(5000), { principal });
  async function* incoming() { for (let i = 0; i < 10; i++) yield Buffer.alloc(2000, 98); }
  let partial;
  await assert.rejects(store.putStream(incoming(), { principal }), error => {
    partial = error.details.result;
    return error.code === 'RESULT_STORE_FULL' && partial?.complete === false;
  });
  assert.equal(partial.incomplete_reason, 'store_capacity_reached');
  assert.ok((await store.read({ result_id: partial.result_id }, principal)).data.startsWith('b'));
  assert.equal((await store.read({ result_id: ref.result_id }, principal)).data.length, 5000);
  assert.ok(!(await fs.readdir(home)).some(name => name.startsWith('.pending-')));
});

test('concurrent independent store instances serialize quota and unique result publication', async t => {
  const { home, store } = await fixture(t, { maxEntries: 6 });
  const second = createResultStore({ home, maxEntries: 6 });
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? second : store).put(`value-${i}`, { principal })));
  const accepted = attempts.filter(value => value.status === 'fulfilled').map(value => value.value);
  assert.equal(accepted.length, 6);
  assert.equal(new Set(accepted.map(ref => ref.result_id)).size, 6);
  assert.ok(attempts.filter(value => value.status === 'rejected').every(value => value.reason.code === 'RESULT_STORE_FULL'));
  for (const ref of accepted) assert.match((await store.read({ result_id: ref.result_id }, principal)).data, /^value-\d$/);
});

test('stream spool stores successive chunks exactly without concatenating complete raw input', async t => {
  const { home, store } = await fixture(t);
  const raw = Buffer.from('研究 😀\n'.repeat(20000));
  let chunks = 0;
  async function* incoming() {
    for (let offset = 0; offset < raw.length; offset += 137) { chunks++; yield raw.subarray(offset, offset + 137); }
  }
  const ref = await store.putStream(incoming(), { principal, tool: 'resources/read' });
  assert.ok(chunks > 1000);
  assert.equal(ref.raw_bytes, raw.length);
  assert.deepEqual(await completeRead(store, ref.result_id, 'base64'), raw);
  assert.deepEqual(await fs.readFile(path.join(home, ref.result_id, 'raw.bin')), raw);
});

test('interrupted upstream preserves prefix after restart with completefalse and typed result reference', async t => {
  const { home, store } = await fixture(t, { maxEntries: 1 });
  async function* interrupted() {
    yield Buffer.from('original response prefix');
    const error = new Error('fixture upstream disconnected'); error.code = 'ECONNRESET'; throw error;
  }
  let ref;
  await assert.rejects(store.putStream(interrupted(), { principal }), error => {
    assert.equal(error.code, 'RESULT_INCOMPLETE');
    ref = error.details.result;
    return ref.complete === false;
  });
  const restarted = createResultStore({ home, maxEntries: 1 });
  const page = await restarted.read({ result_id: ref.result_id }, principal);
  assert.equal(page.data, 'original response prefix');
  assert.equal(page.eof, true);
  assert.equal(page.complete, false, 'eof is only the end of retained bytes');
  await assert.rejects(restarted.put('replacement', { principal }), coded('RESULT_STORE_FULL'));
});

test('explicit incomplete buffer remains incomplete and is not purged as fully read', async t => {
  const { store } = await fixture(t, { maxEntries: 1 });
  const ref = await store.put('received prefix', { principal, complete: false });
  assert.equal(ref.complete, false);
  const page = await store.read({ result_id: ref.result_id }, principal);
  assert.equal(page.eof, true);
  assert.equal(page.complete, false);
  await assert.rejects(store.put('replacement', { principal }), coded('RESULT_STORE_FULL'));
});

test('a paused incoming stream never blocks reads of already published results', async t => {
  const { store } = await fixture(t);
  const original = await store.put('published and available', { principal });
  let release, started;
  const paused = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  async function* incoming() { yield Buffer.from('prefix'); started(); await paused; yield Buffer.from('tail'); }
  const pending = store.putStream(incoming(), { principal });
  await entered;
  try {
    const page = await Promise.race([
      store.read({ result_id: original.result_id }, principal),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('published read blocked on network spool')), 1000); timer.unref(); }),
    ]);
    assert.equal(page.data, 'published and available');
  } finally { release(); await pending; }
});

test('queued writes have bounded wait and a timed-out waiter never poisons later writes', async t => {
  const { store } = await fixture(t, { lockTimeoutMs: 50 });
  let release, started;
  const paused = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  async function* incoming() { yield Buffer.from('prefix'); started(); await paused; yield Buffer.from('tail'); }
  const pending = store.putStream(incoming(), { principal });
  await entered;
  try { await assert.rejects(store.put('queued response', { principal }), coded('RESULT_STORE_BUSY')); }
  finally { release(); await pending; }
  const next = await store.put('next after timeout', { principal });
  assert.equal((await store.read({ result_id: next.result_id }, principal)).data, 'next after timeout');
});

test('stream entry cap preserves received prefix with explicit incomplete result reference', async t => {
  const { home, store } = await fixture(t, { maxEntryBytes: 10 });
  async function* incoming() { yield Buffer.from('first6'); yield Buffer.from('second6'); }
  let ref;
  await assert.rejects(store.putStream(incoming(), { principal }), error => {
    ref = error.details.result;
    return error.code === 'RESULT_TOO_LARGE' && ref?.complete === false;
  });
  assert.equal(ref.incomplete_reason, 'result_limit_reached');
  const restarted = createResultStore({ home, maxEntryBytes: 10 });
  const page = await restarted.read({ result_id: ref.result_id }, principal);
  assert.equal(page.data, 'first6'); assert.equal(page.complete, false);
});

test('a fresh abandoned staging prefix is retained and counted against disk quota', async t => {
  let clock = 1000000;
  const { home, store } = await fixture(t, { maxBytes: 20000, maxEntryBytes: 15000, now: () => clock });
  const staging = path.join(home, '.pending-' + 'c'.repeat(32));
  await fs.mkdir(staging);
  await fs.writeFile(path.join(staging, 'owner.json'), JSON.stringify({ pid: 999999999, created_at_ms: clock }));
  await fs.writeFile(path.join(staging, 'raw.bin'), Buffer.alloc(15000));
  await assert.rejects(store.put('new', { principal }), coded('RESULT_STORE_FULL'));
  assert.equal((await fs.stat(path.join(staging, 'raw.bin'))).size, 15000);
  clock += day;
  await store.put('new after retention', { principal });
  await assert.rejects(fs.stat(staging), error => error.code === 'ENOENT');
});

test('empty complete response can be read and acknowledged without a pagination loop', async t => {
  const { store } = await fixture(t, { maxEntries: 1 });
  const empty = await store.put('', { principal });
  const page = await store.read({ result_id: empty.result_id }, principal);
  assert.equal(page.data, ''); assert.equal(page.eof, true); assert.equal(page.bytes_returned, 0);
  await store.put('next', { principal });
});

test('dead writer lock is recovered without changing existing result data', async t => {
  const { home, store } = await fixture(t);
  await fs.mkdir(path.join(home, '.write-lock'));
  await fs.writeFile(path.join(home, '.write-lock', 'owner.json'), JSON.stringify({ pid: 999999999, nonce: 'a'.repeat(32) }));
  const ref = await store.put('after dead writer', { principal });
  assert.equal((await store.read({ result_id: ref.result_id }, principal)).data, 'after dead writer');
  assert.ok(!(await fs.readdir(home)).includes('.write-lock'));
});

test('missing payload and corrupt immutable metadata report corruption, not fake complete results', async t => {
  const { home, store } = await fixture(t);
  const ref = await store.put('durable', { principal });
  await fs.truncate(path.join(home, ref.result_id, 'raw.bin'), 2);
  await assert.rejects(store.read({ result_id: ref.result_id }, principal), coded('RESULT_CORRUPT'));
  await fs.writeFile(path.join(home, ref.result_id, 'meta.json'), 'invalid');
  await assert.rejects(store.read({ result_id: ref.result_id }, principal), coded('RESULT_CORRUPT'));
});

test('disk setup failure becomes a typed storage error', async t => {
  const { home } = await fixture(t);
  const occupied = path.join(home, 'not-directory');
  await fs.writeFile(occupied, 'fixture');
  const store = createResultStore({ home: occupied });
  await assert.rejects(store.put('value', { principal }), coded('RESULT_STORAGE_ERROR'));
});

test('coverage metadata stays bounded with fragmented out-of-order reads and cannot falsely acknowledge gaps', async t => {
  const { home, store } = await fixture(t, { maxEntries: 1 });
  const ref = await store.put('x'.repeat(4000), { principal });
  for (let index = 0; index < 150; index++) await store.read({ result_id: ref.result_id, offset: index * 20, max_bytes: 4 }, principal);
  const stateBytes = await fs.readFile(path.join(home, ref.result_id, 'read.json'));
  assert.ok(stateBytes.length < 8192);
  const state = JSON.parse(stateBytes.toString());
  assert.equal(state.coverage_limited, true);
  assert.equal(state.fully_read, false);
  await assert.rejects(store.put('replacement', { principal }), coded('RESULT_STORE_FULL'));
});

test('invalid store configuration and invalid stream chunk are rejected without publishing', async t => {
  const { home, store } = await fixture(t);
  for (const options of [{ home: 'relative' }, { home, retentionMs: day - 1 }, { home, maxEntries: 0 }, { home, maxBytes: 1 }]) {
    assert.throws(() => createResultStore(options), coded('RESULT_INVALID_ARGUMENT'));
  }
  async function* invalid() { yield Buffer.from('prefix'); yield { invalid: true }; }
  await assert.rejects(store.putStream(invalid(), { principal }), coded('RESULT_INVALID_ARGUMENT'));
  await assert.rejects(store.putStream(Buffer.from('not a stream'), { principal }), coded('RESULT_INVALID_ARGUMENT'));
  assert.ok(!(await fs.readdir(home)).some(name => name.startsWith('result_')));
});
