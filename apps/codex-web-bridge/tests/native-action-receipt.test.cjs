'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createNativeActionReadBatch} = require('../native-action-receipt.cjs');

const threadId = '01a0dc7b-2a50-7140-a55b-eed50ff96b02';
const first = '01a0dc7b-2a50-7140-a55b-eed50ff96b03';
const second = '01a0dc7b-2a50-7140-a55b-eed50ff96b04';
const third = '01a0dc7b-2a50-7140-a55b-eed50ff96b05';
const stamp = tick => new Date(Date.parse('2026-09-26T10:00:00Z') + tick * 1000).toISOString();
const event = (tick, type, turnId, extra = {}) => ({timestamp: stamp(tick), type: 'event_msg', payload: {type, turn_id: turnId, ...extra}});
const answer = (tick, text = 'PRIVATE final result') => ({timestamp: stamp(tick), type: 'response_item',
  payload: {type: 'message', role: 'assistant', phase: 'final_answer', content: [{type: 'output_text', text}]}});
const completed = (id = first, tick = 1) => [event(tick, 'task_started', id), answer(tick + 1),
  event(tick + 2, 'task_complete', id, {last_agent_message: 'PRIVATE final result'})];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clw-native-action-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const sessionsRoot = path.join(home, 'sessions'), directory = path.join(sessionsRoot, '2026', '09', '26');
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, `rollout-2026-09-26T10-00-00-${threadId}.jsonl`);
  const meta = {timestamp: stamp(0), type: 'session_meta', payload: {id: threadId, cwd: home, private: 'PRIVATE_METADATA'}};
  const rows = [meta, ...completed()];
  const write = (value = rows, target = file) => fs.writeFileSync(target, value.map(row => JSON.stringify(row)).join('\n') + '\n');
  const source = {traceId: 'abcdef123456', model: 'chatgpt-web/high', account: 'A', threadId, turnId: first, workingDirectory: home};
  const read = (value = source) => createNativeActionReadBatch({sessionsRoot}).read(value);
  write();
  return {home, sessionsRoot, directory, file, meta, rows, source, write, read};
}
function denied(value, code) {
  assert.equal(value.state, 'unavailable'); assert.equal(value.nativeProof, null);
  assert.equal(value.threadActive, null); assert.equal(value.activeTurnId, null);
  assert.equal(value.workflowJobAbsenceProven, false); assert.equal(value.claimReleaseAuthorized, false);
  assert.equal(value.taskAcceptance, 'unverified');
  assert.match(value.reason, code || /^native_action_/);
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
}
function patch(t, name, replacement) {
  const original = fs[name]; fs[name] = replacement(original);
  t.after(() => { fs[name] = original; });
}

test('canonical completion verifies the exact final and publishes only redacted metadata', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file), result = f.read();
  assert.deepEqual(Object.keys(require('../native-action-receipt.cjs')), ['createNativeActionReadBatch']);
  assert.equal(result.threadId, threadId); assert.equal(result.turnId, first);
  assert.equal(result.state, 'completed'); assert.equal(result.endedAt, stamp(3));
  assert.equal(result.threadActive, false); assert.equal(result.activeTurnId, null);
  assert.deepEqual(result.nativeProof, {version: 1, kind: 'canonical_full_session', threadId, turnId: first,
    sessionSha256: digest(bytes), eventSha256: digest('CLW canonical native turn v1\0' +
      f.rows.slice(1).map(row => JSON.stringify(row) + '\n').join('')),
    terminal: 'task_complete_with_matching_final', finalSha256: digest('PRIVATE final result')});
  assert.equal(result.workflowJobAbsenceProven, false); assert.equal(result.taskAcceptance, 'unverified');
  assert.equal(result.claimReleaseAuthorized, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(JSON.stringify(result).includes(f.home), false);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});
test('actual Codex settings metadata is compatible without creating terminal or execution evidence',t=>{
 const f=fixture(t),settings={timestamp:stamp(0),type:'event_msg',payload:{type:'thread_settings_applied',thread_id:threadId,thread_settings:{cwd:f.home,model:'chatgpt-web/high',model_provider_id:'chatgpt-web'}}};
 f.write([f.meta,settings,...f.rows.slice(1)]);assert.equal(f.read().state,'completed');
 for(const payload of [{...settings.payload,thread_id:second},{...settings.payload,thread_settings:{}},{...settings.payload,type:'unknown_metadata'},{...settings.payload,thread_settings:{...settings.payload.thread_settings,cwd:path.dirname(f.home)}}]){
  f.write([f.meta,{...settings,payload},...f.rows.slice(1)]);denied(f.read());
 }
});

test('error and explicit abort are terminal states, never inferred successes', t => {
  const f = fixture(t);
  for (const error of [{message: 'PRIVATE native failure'}, 'PRIVATE native failure']) {
    const rows = [f.meta, event(1, 'task_started', first), event(2, 'task_complete', first, {error, last_agent_message: null})];
    f.write(rows);
    const result = f.read(); assert.equal(result.state, 'failed'); assert.equal(result.endedAt, stamp(2));
    assert.equal(result.nativeProof.terminal, 'task_complete_with_error'); assert.equal(result.threadActive, false);
    assert.deepEqual(result.nativeProof, {version: 1, kind: 'canonical_full_session', threadId, turnId: first,
      sessionSha256: digest(fs.readFileSync(f.file)), eventSha256: digest('CLW canonical native turn v1\0' +
        rows.slice(1).map(row => JSON.stringify(row) + '\n').join('')), terminal: 'task_complete_with_error'});
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
  f.write([f.meta, event(1, 'task_started', first), event(2, 'turn_aborted', first, {reason: 'PRIVATE user stop'})]);
  const result = f.read(); assert.equal(result.state, 'aborted'); assert.equal(result.endedAt, stamp(2));
  assert.equal(result.nativeProof.terminal, 'turn_aborted'); assert.equal(result.claimReleaseAuthorized, false);
});

test('a later active native turn without a Web trace remains visible on the old completed turn', t => {
  const f = fixture(t); f.write([...f.rows, event(4, 'task_started', second),
    {timestamp: stamp(5), type: 'turn_context', payload: {turn_id: second}}]);
  const batch = createNativeActionReadBatch({sessionsRoot: f.sessionsRoot}), old = batch.read(f.source);
  assert.equal(old.state, 'completed'); assert.equal(old.endedAt, stamp(3));
  assert.equal(old.threadActive, true); assert.equal(old.activeTurnId, second);
  const current = batch.read({...f.source, turnId: second});
  assert.equal(current.state, 'running'); assert.equal(current.endedAt, null);
  assert.equal(current.nativeProof.terminal, 'task_started_without_terminal');
  denied(batch.read({...f.source, turnId: third}), /turn_not_found/);
});

test('every prior and later native turn is checked, including failure and abort boundaries', t => {
  const f = fixture(t);
  f.write([f.meta, event(1, 'task_started', second), event(2, 'turn_aborted', second),
    ...completed(first, 3), event(6, 'task_started', third),
    event(7, 'task_complete', third, {error: {message: 'PRIVATE failure'}, last_agent_message: null})]);
  assert.equal(f.read().state, 'completed'); assert.equal(f.read().threadActive, false);
  assert.equal(f.read({...f.source, turnId: third}).state, 'failed');
  const rows = [f.meta, ...completed(), ...completed(second, 4)];
  rows.at(-1).payload.last_agent_message = 'different'; f.write(rows);
  denied(f.read(), /final_mismatch/);
});

test('source identity and absolute cwd are revalidated on every read, even after a good cached parse', t => {
  const f = fixture(t), batch = createNativeActionReadBatch({sessionsRoot: f.sessionsRoot});
  assert.equal(batch.read(f.source).state, 'completed');
  for (const value of [null, [], {}, {...f.source, threadId: Symbol('invalid')},
    {...f.source, traceId: 'PRIVATE_INVALID'}, {...f.source, traceId: '../abcdef123456'},
    {...f.source, traceId: undefined}, {...f.source, model: 'native/gpt-6'},
    {...f.source, model: 'chatgpt-web/future-model'}, {...f.source, model: undefined},
    {...f.source, turnId: first.replace('-7140-', '-4140-')}, {...f.source, turnId: threadId},
    {...f.source, turnId: threadId.toUpperCase()}, {...f.source, workingDirectory: 'relative'},
    {...f.source, workingDirectory: 'C:relative'}, {...f.source, workingDirectory: 'file:///D:/project'}]) denied(batch.read(value), /source_invalid/);
  denied(batch.read({...f.source, workingDirectory: f.home + '-wrong'}), /cwd_mismatch/);
  const mutable = {...f.source}; assert.equal(batch.read(mutable).state, 'completed');
  mutable.workingDirectory = f.home + '-wrong'; denied(batch.read(mutable), /cwd_mismatch/);
  assert.equal(batch.read(f.source).state, 'completed');
});

test('session metadata must be unique, first, and bind both thread and absolute cwd', t => {
  const f = fixture(t);
  const changes = [rows => {rows[0].payload.id = second;}, rows => {delete rows[0].payload.cwd;},
    rows => {rows[0].payload.cwd = '.';}, rows => {rows[0].payload = null;},
    rows => {rows.splice(1, 0, structuredClone(rows[0]));}, rows => {rows.splice(0, 1);},
    rows => {rows[0].timestamp = null;}];
  for (const change of changes) {const rows = structuredClone(f.rows); change(rows); f.write(rows); denied(f.read());}
  f.write([{...f.meta, payload: {...f.meta.payload, cwd: f.home + '-other'}}, ...f.rows.slice(1)]);
  denied(f.read(), /cwd_mismatch/);
});

test('strict JSON, record objects, payloads and UTF-8 are required throughout the file', t => {
  const f = fixture(t);
  for (const row of [null, [], 7, {type: 'event_msg', timestamp: stamp(4), payload: []},
    {type: 'event_msg', timestamp: stamp(4), payload: null}, {type: 'future_record', timestamp: stamp(4), payload: {}},
    {type: 'event_msg', timestamp: stamp(4), payload: {type: 'future_event'}}]) {
    f.write([...f.rows, row]); denied(f.read());
  }
  f.write(); fs.appendFileSync(f.file, '{"type":'); denied(f.read(), /json_invalid/);
  f.write(); fs.appendFileSync(f.file, '\n'); denied(f.read(), /record_invalid/);
  f.write(); fs.appendFileSync(f.file, Buffer.from([0xc3, 0x28])); denied(f.read(), /utf8_invalid/);
  f.write(); const bytes = fs.readFileSync(f.file); fs.writeFileSync(f.file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
  assert.equal(f.read().state, 'completed');
});

test('all starts and ends require exact UUIDv7 identity, order, timestamps and no overlap or duplicates', t => {
  const f = fixture(t), changes = [
    rows => {rows[1].payload.turn_id = 'not-a-turn';}, rows => {rows[1].payload.turn_id = threadId;},
    rows => {rows[1].payload.thread_id = second;}, rows => {rows[3].payload.turn_id = second;},
    rows => {delete rows[3].payload.turn_id;}, rows => {rows.splice(1, 1);},
    rows => {rows.splice(2, 0, event(1, 'task_started', second));},
    rows => {rows.push(...completed(first, 4));}, rows => {rows.push(structuredClone(rows[3]));},
    rows => {rows[2].timestamp = stamp(0);}, rows => {rows[3].timestamp = 'PRIVATE';},
    rows => {rows[3].timestamp = '2026-02-30T10:00:00Z';}, rows => {rows[3].timestamp = stamp(1);},
    rows => {rows.splice(2, 0, {timestamp: stamp(1), type: 'turn_context', payload: {turn_id: second}});},
  ];
  for (const change of changes) {const rows = structuredClone(f.rows); change(rows); f.write(rows); denied(f.read());}
});

test('completed turns need exactly one well-formed final whose hash matches task_complete', t => {
  const f = fixture(t), changes = [rows => {rows.splice(2, 1);}, rows => {rows.splice(2, 0, structuredClone(rows[2]));},
    rows => {rows[2].payload.content = [];}, rows => {rows[2].payload.content[0].type = 'input_text';},
    rows => {rows[2].payload.content[0].text = '';}, rows => {rows[2].payload.role = 'user';},
    rows => {rows[3].payload.last_agent_message = 'PRIVATE different result';}, rows => {delete rows[3].payload.last_agent_message;},
    rows => {rows[3].payload.last_agent_message = ' ';}, rows => {rows.push({...answer(4)});},
    rows => {rows[2].payload.turn_id = second;}];
  for (const change of changes) {const rows = structuredClone(f.rows); change(rows); f.write(rows); denied(f.read());}
});

test('a prior final followed by the same native error remains failed with original final and full-session hashes', t => {
  const f = fixture(t);
  for (const last_agent_message of [undefined, null, '', 'PRIVATE final result', ' PRIVATE final result\n']) {
    const rows = [...f.rows.slice(0, 3), event(3, 'task_complete', first, {error: {message: 'PRIVATE failure'}, last_agent_message})];
    f.write(rows); const original = fs.readFileSync(f.file), result = f.read();
    assert.equal(result.state, 'failed'); assert.equal(result.endedAt, stamp(3));
    assert.equal(result.threadActive, false); assert.equal(result.activeTurnId, null);
    assert.equal(result.nativeProof.terminal, 'task_complete_with_error');
    assert.equal(result.nativeProof.finalSha256, digest('PRIVATE final result'));
    assert.equal(result.nativeProof.sessionSha256, digest(original));
    assert.equal(result.nativeProof.eventSha256, digest('CLW canonical native turn v1\0' + rows.slice(1).map(row => JSON.stringify(row) + '\n').join('')));
    assert.equal(result.taskAcceptance, 'unverified'); assert.equal(result.claimReleaseAuthorized, false);
    assert.equal(result.workflowJobAbsenceProven, false); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.deepEqual(fs.readFileSync(f.file), original);
  }
  const rows = [...f.rows.slice(0, 3), event(3, 'task_complete', first, {error: {message: 'PRIVATE failure'}, last_agent_message: null})];
  for (const mutate of [
    changed => { changed.at(-1).payload.last_agent_message = 'different final'; },
    changed => { changed.at(-1).payload.last_agent_message = ' '; },
    changed => { changed.at(-1).payload.last_agent_message = false; },
    changed => { changed.at(-1).payload.last_agent_message = 7; },
    changed => { changed.splice(2, 0, structuredClone(changed[2])); },
    changed => { changed.at(-1).payload.turn_id = second; },
    changed => { changed.push(structuredClone(changed.at(-1))); },
    changed => { changed.push(answer(4)); },
  ]) { const changed = structuredClone(rows); mutate(changed); f.write(changed); denied(f.read()); }
});

test('empty or malformed error receipts and nonmatching terminal messages without a final are rejected', t => {
  const f = fixture(t);
  for (const error of ['', ' ', {}, {message: ''}, {message: 9}, [], false]) {
    f.write([f.meta, event(1, 'task_started', first), event(2, 'task_complete', first, {error, last_agent_message: null})]);
    denied(f.read(), /error_invalid/);
  }
  f.write([f.meta, event(1, 'task_started', first), event(3, 'task_complete', first, {error: {message: 'PRIVATE error'}, last_agent_message: 'PRIVATE final result'})]);
  denied(f.read(), /terminal_conflict/);
});

test('only the exact thread UUID day and adjacent days are searched, and duplicates are refused', t => {
  const f = fixture(t), dirs = [], original = fs.readdirSync;
  fs.readdirSync = function(directory, ...args) {dirs.push(String(directory)); return original.call(this, directory, ...args);};
  try {assert.equal(f.read().state, 'completed');} finally {fs.readdirSync = original;}
  assert.deepEqual(dirs.map(directory => path.relative(f.sessionsRoot, directory)), [path.join('2026', '09', '26')]);
  // Missing day directories are tested by lstat without any broad tree traversal.
  const other = path.join(f.sessionsRoot, '2026', '09', '27'); fs.mkdirSync(other, {recursive: true});
  f.write(f.rows, path.join(other, `rollout-other-${threadId}.jsonl`)); denied(f.read(), /session_not_unique/);
  fs.rmSync(other, {recursive: true});
  const outside = path.join(f.sessionsRoot, '2026', '09', '29'); fs.mkdirSync(outside, {recursive: true});
  fs.renameSync(f.file, path.join(outside, path.basename(f.file))); denied(f.read(), /session_not_unique/);
});

test('empty Sessions are refused without opening; one oversized record remains bounded', t => {
  const f = fixture(t); let opens = 0;
  patch(t, 'openSync', original => function(...args) {if (args[0] === f.file && args[1] === 'r') opens++; return original.apply(this, args);});
  fs.truncateSync(f.file, 0); denied(f.read(), /size_invalid/);
  assert.equal(opens, 0);
  fs.writeFileSync(f.file, 'x'.repeat(16 * 1024 * 1024 + 1)); denied(f.read(), /record_size_invalid/);
  assert.equal(opens, 1);
});

test('canonical multi-turn Session above 64 MiB streams bounded fd reads and preserves exact original hashes', t => {
  const f=fixture(t),fd=fs.openSync(f.file,'w'),hash=crypto.createHash('sha256');
  const write=row=>{const raw=JSON.stringify(row)+'\n';fs.writeSync(fd,raw);hash.update(raw);};
  write(f.meta);for(const row of completed())write(row);
  const filler={timestamp:stamp(4),type:'token_usage_record',payload:{padding:'x'.repeat(1024*1024)}};
  for(let n=0;n<66;n++)write(filler);
  for(const row of completed(second,5))write(row);
  fs.closeSync(fd);assert.ok(fs.statSync(f.file).size>64*1024*1024);
  let maxRead=0,reads=0,wholeReads=0;
  patch(t,'readSync',original=>function(...args){maxRead=Math.max(maxRead,args[3]);reads++;return original.apply(this,args);});
  patch(t,'readFileSync',original=>function(...args){if(args[0]===f.file)wholeReads++;return original.apply(this,args);});
  const batch=createNativeActionReadBatch({sessionsRoot:f.sessionsRoot}),one=batch.read(f.source),two=batch.read({...f.source,turnId:second});
  assert.equal(one.state,'completed');assert.equal(two.state,'completed');assert.equal(one.threadActive,false);
  assert.equal(one.nativeProof.sessionSha256,hash.digest('hex'));assert.equal(two.nativeProof.sessionSha256,one.nativeProof.sessionSha256);
  const turnHash=crypto.createHash('sha256').update('CLW canonical native turn v1\0');for(const row of completed())turnHash.update(JSON.stringify(row)).update('\n');
  assert.equal(one.nativeProof.eventSha256,turnHash.digest('hex'));assert.equal(one.claimReleaseAuthorized,false);
  assert.equal(wholeReads,0);assert.ok(reads>1000);assert.ok(maxRead<=64*1024);
});

test('fd and path revisions are checked on both sides of the full bounded read', t => {
  const f = fixture(t), original = fs.fstatSync;
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    for (const when of [1, 2]) {
      let calls = 0;
      fs.fstatSync = function(...args) {const stat = original.apply(this, args); if (++calls === when) stat[key] += 1n; return stat;};
      try {denied(f.read(), /session_changed/);} finally {fs.fstatSync = original;}
    }
  }
  const stat = fs.statSync; let calls = 0;
  fs.statSync = function(...args) {const value = stat.apply(this, args); if (++calls === 2) value.ino += 1n; return value;};
  try {denied(f.read(), /session_changed/);} finally {fs.statSync = stat;}
});

test('a file mutation during read cannot issue a canonical proof, and the descriptor is closed', t => {
  const f = fixture(t); let changed = false, closes = 0;
  patch(t, 'readSync', original => function(...args) {const count = original.apply(this, args);
    if (!changed) {changed = true; fs.appendFileSync(f.file, JSON.stringify(event(4, 'task_started', second)) + '\n');}
    return count;});
  patch(t, 'closeSync', original => function(...args) {closes++; return original.apply(this, args);});
  denied(f.read(), /session_changed/); assert.equal(closes, 1);
});

test('read errors are redacted and never leak the local Session path or underlying exception', t => {
  const f = fixture(t); let closes = 0;
  patch(t, 'readSync', () => function() {throw Error('PRIVATE credential body ' + f.file);});
  patch(t, 'closeSync', original => function(...args) {closes++; return original.apply(this, args);});
  denied(f.read(), /session_unreadable/); assert.equal(closes, 1);
});

test('one batch scans a thread once, checks each cwd again and does not expose mutable cached state', t => {
  const f = fixture(t); f.write([...f.rows, ...completed(second, 4)]); let reads = 0;
  patch(t, 'readSync', original => function(...args) {reads++; return original.apply(this, args);});
  const batch = createNativeActionReadBatch({sessionsRoot: f.sessionsRoot}), one = batch.read(f.source);
  one.nativeProof.kind = 'PRIVATE forged';
  for (let index = 0; index < 5; index++) {
    assert.equal(batch.read(f.source).nativeProof.kind, 'canonical_full_session');
    assert.equal(batch.read({...f.source, turnId: second}).state, 'completed');
    denied(batch.read({...f.source, workingDirectory: f.home + '-wrong'}), /cwd_mismatch/);
  }
  assert.equal(reads, 1);
});

test('the next batch rereads middle mutations despite restored mtime and unchanged head/tail anchors', t => {
  const f = fixture(t), padding = tick => ({timestamp: stamp(tick), type: 'response_item',
    payload: {type: 'reasoning', summary: [{type: 'summary_text', text: 'x'.repeat(20000)}]}});
  f.write([f.meta, event(1, 'task_started', first), padding(2), answer(3), padding(4),
    event(5, 'task_complete', first, {last_agent_message: 'PRIVATE final result'})]);
  const before = fs.statSync(f.file), original = fs.readFileSync(f.file), mutated = Buffer.from(original);
  let reads = 0; patch(t, 'readSync', read => function(...args) {reads++; return read.apply(this, args);});
  assert.equal(f.read().state, 'completed');
  const index = original.indexOf('PRIVATE final result'); assert.ok(index > 4096 && index < original.length - 4096);
  mutated.write('CHANGED final result', index); assert.equal(mutated.length, original.length);
  fs.writeFileSync(f.file, mutated); fs.utimesSync(f.file, before.atime, before.mtime);
  assert.deepEqual(mutated.subarray(0, 4096), original.subarray(0, 4096));
  assert.deepEqual(mutated.subarray(-4096), original.subarray(-4096));
  denied(f.read(), /final_mismatch/); assert.equal(reads, 2);
});

test('a new batch discovers appended activity and independently rereads failed prior scans', t => {
  const f = fixture(t), one = createNativeActionReadBatch({sessionsRoot: f.sessionsRoot});
  assert.equal(one.read(f.source).threadActive, false);
  fs.appendFileSync(f.file, JSON.stringify(event(4, 'task_started', second)) + '\n');
  assert.equal(f.read().activeTurnId, second);
  f.write([...f.rows, null]); denied(f.read());
  f.write(); assert.equal(f.read().state, 'completed');
});
