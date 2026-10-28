const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {verifyNativeTerminalReceipt,verifyNativeCompletedToolsReceipt,verifyNativeCompactionFailureReceipt,verifyNativeFailureReceipt,nativeTurnStateForDisplay} = require('../native-terminal-receipt.cjs');

const threadId = '01a0dc7b-2a50-7140-a55b-eed50ff96b02';
const turnId = '01a0dc7b-2a50-7140-a55b-eed50ff96b03';
const otherTurnId = '01a0dc7b-2a50-7140-a55b-eed50ff96b04';
const final = 'A complete, checked result.\n';
const hash = crypto.createHash('sha256').update(final.trim()).digest('hex');
const startedAt = '2026-09-26T10:00:00Z';
const endedAt = '2026-09-26T10:00:03Z';
const meta = {timestamp: startedAt, type: 'session_meta', payload: {id: threadId}};
const start = {timestamp: startedAt, type: 'event_msg', payload: {type: 'task_started', turn_id: turnId}};
const answer = {timestamp: '2026-09-26T10:00:01Z', type: 'response_item', payload: {type: 'message', role: 'assistant', phase: 'final_answer', content: [{type: 'output_text', text: final}]}};
const complete = {timestamp: '2026-09-26T10:00:02Z', type: 'event_msg', payload: {type: 'task_complete', turn_id: turnId, last_agent_message: final}};

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clw-native-terminal-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const sessionsRoot = path.join(home, 'sessions');
  const directory = path.join(sessionsRoot, '2026', '09', '26');
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, `rollout-2026-09-26T10-00-00-${threadId}.jsonl`);
  const write = (rows, target = file) => fs.writeFileSync(target, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const input = {threadId, turnId, expectedFinalSha256: hash, sessionsRoot};
  write([meta, start, answer, complete]);
  return {file, directory, write, input};
}

test('a prior assistant final followed by the same no-tool native error remains an immutable failure', t => {
  const f = fixture(t), end = {...complete, payload: {type: 'task_complete', turn_id: turnId,
    last_agent_message: null, error: {message: 'stream disconnected before completion: original error'}}};
  f.write([meta, start, answer, end]); const before = fs.readFileSync(f.file);
  const proof = verifyNativeFailureReceipt(f.input);
  assert.equal(proof.kind, 'native_failed_without_tools'); assert.equal(proof.priorFinalSha256, hash);
  assert.equal(proof.nativeTurnState, 'failed'); assert.equal(proof.taskAcceptance, 'unverified'); assert.equal(proof.automaticReplay, false);
  assert.equal(proof.finalSha256, undefined); assert.match(proof.failureSha256, /^[a-f0-9]{64}$/);
  assert.equal(proof.sessionSha256, crypto.createHash('sha256').update(before).digest('hex'));
  assert.equal(proof.receiptSha256, crypto.createHash('sha256').update(JSON.stringify([start, answer, end])).digest('hex'));
  assert.deepEqual(fs.readFileSync(f.file), before);
  const changed = structuredClone(answer); changed.payload.content[0].text = 'different prior final';
  f.write([meta, start, changed, end]);
  assert.notEqual(verifyNativeFailureReceipt(f.input).receiptSha256, proof.receiptSha256);
  assert.throws(() => verifyNativeTerminalReceipt(f.input));
  f.write([meta, start, end]);
  assert.equal(verifyNativeFailureReceipt(f.input).receiptSha256, crypto.createHash('sha256').update(JSON.stringify([start, end])).digest('hex'),
    'existing no-final failure receipts keep their original hash');
});

test('a prior final cannot conceal tools, ambiguous terminals, wrong native identities or time boundaries', t => {
  const f = fixture(t), end = {...complete, payload: {type: 'task_complete', turn_id: turnId,
    last_agent_message: null, error: {message: 'original error'}}};
  const originals = [meta, start, answer, end];
  for (const mutate of [
    rows => { rows.splice(3, 0, structuredClone(answer)); },
    rows => { rows[2].timestamp = '2026-09-26T09:59:59Z'; },
    rows => { rows[2].timestamp = '2026-09-26T10:00:04Z'; },
    rows => { rows.push(structuredClone(end)); },
    rows => { rows[3].payload.turn_id = otherTurnId; },
    rows => { rows[3].payload.error = null; rows[3].payload.last_agent_message = final; },
    rows => { rows.splice(2, 0, {...answer, type: 'turn_context', payload: {turn_id: otherTurnId}}); },
    rows => { rows.splice(2, 0, {...answer, type: 'event_msg', payload: {type: 'turn_aborted', turn_id: turnId}}); },
    rows => { rows.splice(2, 0, {...answer, type: 'event_msg', payload: {type: 'item_completed', thread_id: threadId,
      turn_id: turnId, item: {type: 'CommandExecution', id: 'unknown-command', status: 'completed', exit_code: 0}}}); },
    rows => { rows.splice(2, 0, {...answer, type: 'event_msg', payload: {type: 'item_completed', thread_id: otherTurnId,
      turn_id: turnId, item: {type: 'AgentMessage', id: 'foreign-message'}}}); },
  ]) {
    const rows = structuredClone(originals); mutate(rows); f.write(rows);
    assert.throws(() => verifyNativeFailureReceipt(f.input));
  }
  for (const type of ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'tool_search_call', 'future_action']) {
    const rows = structuredClone(originals); rows.splice(2, 0, {...answer, payload: {type, call_id: 'action'}}); f.write(rows);
    assert.throws(() => verifyNativeFailureReceipt(f.input), /requires_tool_reconciliation/);
  }
});

// Matches the original High QA's native shape: function/custom call, canonical
// item_completed with a begin/end interval, then the full native tool output.
function workFixture(t) {
  const original = fixture(t), base = Date.parse(startedAt), rows = [meta, start];
  const timestamp = ms => new Date(base + ms).toISOString();
  for (let index = 0; index < 7; index++) {
    const patch = index === 1 || index === 5, at = 100 + index * 220;
    const callId = `call_QA_${index}`, body = `PRIVATE_TOOL_BODY_${index}\n`, command = `node qa-${index}.cjs PRIVATE_COMMAND`;
    rows.push({timestamp: timestamp(at), type: 'response_item', payload: patch ?
      {type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: 'PRIVATE_PATCH'} :
      {type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({cmd: command, workdir: 'D:/fixture/project'})}});
    const item = patch ? {type: 'FileChange', id: callId, changes: {'D:/fixture/project/qa.cjs': {type: 'add', content: 'PRIVATE_PATCH'}}, status: 'completed', stdout: body, stderr: ''} :
      {type: 'CommandExecution', id: callId, process_id: String(40000 + index), command: ['powershell.exe', '-Command', command],
        cwd: 'file:///D:/fixture/project', status: 'completed', stdout: body, stderr: '', aggregated_output: body, exit_code: 0};
    rows.push({timestamp: timestamp(at + 40), type: 'event_msg', payload: {type: 'item_completed', thread_id: threadId, turn_id: turnId,
      item, started_at_ms: base + at + 20, completed_at_ms: base + at + 40}});
    rows.push({timestamp: timestamp(at + 60), type: 'response_item', payload: {type: patch ? 'custom_tool_call_output' : 'function_call_output', call_id: callId,
      output: patch ? `Exit code: 0\nWall time: 0 seconds\nOutput:\n${body}` :
        `Chunk ID: qa${index}\nWall time: 0.04 seconds\nProcess exited with code 0\nOriginal token count: 8\nOutput:\n${body}`}});
  }
  rows.push({...answer, timestamp: timestamp(2000)}, {...complete, timestamp: timestamp(2500)});
  original.write(rows);
  return {...original, rows, input: {...original.input, startedAt, endedAt}};
}

function truncatedWorkFixture(t, omitted = '中间省略的内容\r\n') {
  const fixture = workFixture(t), {rows, write} = fixture;
  const prefix = '保留的开头😀\r\n', suffix = '\r\n保留的结尾🌕\r\n', original = prefix + omitted + suffix;
  const lines = original.split('\n').length - 1;
  const body = `Warning: truncated output (original token count: 2707)\nTotal output lines: ${lines}\n\n${prefix}…${[...omitted].length} chars truncated…${suffix}`;
  rows[3].payload.item.aggregated_output = original;
  rows[4].payload.output = `Chunk ID: qa0\nWall time: 0.04 seconds\nProcess exited with code 0\nOriginal token count: 2707\nOutput:\n${body}`;
  write(rows);
  return {...fixture, original, body, omitted};
}

function polledImageFixture(t) {
  const original = fixture(t), base = Date.parse(startedAt), timestamp = ms => new Date(base + ms).toISOString();
  const row = (ms, type, payload) => ({timestamp: timestamp(ms), type, payload});
  const call = (ms, id, name, args) => row(ms, 'response_item', {type: 'function_call', call_id: id, name, arguments: JSON.stringify(args)});
  const output = (ms, id, body) => row(ms, 'response_item', {type: 'function_call_output', call_id: id, output: body});
  const item = (ms, item, began = ms) => row(ms, 'event_msg', {type: 'item_completed', thread_id: threadId, turn_id: turnId,
    started_at_ms: base + began, completed_at_ms: base + ms, item});
  const rows = [meta, start,
    call(100, 'original-build', 'exec_command', {cmd: 'node build.cjs', workdir: 'D:/fixture/project'}),
    output(200, 'original-build', 'Chunk ID: build\nWall time: 0.1 seconds\nProcess running with session ID 77\nOutput:\nstart\n'),
    call(300, 'original-poll1', 'write_stdin', {session_id: 77, chars: ''}),
    output(400, 'original-poll1', 'Chunk ID: poll1\nWall time: 0.1 seconds\nProcess running with session ID 77\nOutput:\nprogress\n'),
    call(500, 'original-poll2', 'write_stdin', {session_id: 77, chars: ''}),
    item(600, {type: 'CommandExecution', id: 'original-build', process_id: '77', command: ['powershell.exe', '-Command', 'node build.cjs'],
      cwd: 'file:///D:/fixture/project', status: 'completed', exit_code: 0, aggregated_output: 'start\nprogress\ndone\n'}, 100),
    output(700, 'original-poll2', 'Chunk ID: poll2\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\ndone\n'),
    call(800, 'original-image', 'view_image', {path: 'D:/fixture/project/render.png'}),
    item(900, {type: 'ImageView', id: 'original-image', path: 'file:///D:/fixture/project/render.png'}, 800),
    output(1000, 'original-image', [{type: 'input_image', image_url: 'data:image/png;base64,YQ=='}]),
    {...answer, timestamp: timestamp(2000)}, {...complete, timestamp: timestamp(2500)}];
  original.write(rows);
  return {...original, rows, input: {...original.input, startedAt, endedAt}};
}

test('one original yielded command closes through its own repeated write_stdin calls and completed ImageView', t => {
  const {rows, write, input} = polledImageFixture(t);
  const proof = verifyNativeCompletedToolsReceipt(input);
  assert.equal(proof.returnedTools, 4);
  assert.deepEqual(proof.tools, {exec_command: {invocations: 1, terminal: 1}, apply_patch: {invocations: 0, terminal: 0},
    write_stdin: {invocations: 2, terminal: 2}, view_image: {invocations: 1, terminal: 1}});
  assert.equal(proof.taskAcceptance, 'unverified'); assert.equal(proof.workflowJobAbsenceProven, false);
  assert.equal(/build\.cjs|render\.png|YQ==|session_id/.test(JSON.stringify(proof)), false);
  const changed = structuredClone(rows);
  changed[7].payload.item.status = 'failed'; changed[7].payload.item.exit_code = 7;
  changed[8].payload.output = changed[8].payload.output.replace('code 0', 'code 7'); write(changed);
  assert.equal(verifyNativeCompletedToolsReceipt(input).returnedTools, 4, 'A failed command may be fully terminal; task acceptance stays separate');
});

test('polling and image receipts cannot borrow another session, call, returned body or canonical item', t => {
  const {rows, write, input} = polledImageFixture(t);
  const cases = [
    changed => { changed.splice(8, 1); },
    changed => { changed.splice(7, 1); },
    changed => { changed[8].payload.call_id = 'another-poll'; },
    changed => { changed[4].payload.arguments = JSON.stringify({session_id: 88}); },
    changed => { changed[5].payload.output = changed[5].payload.output.replace('session ID 77', 'session ID 88'); },
    changed => { changed[7].payload.item.process_id = '88'; },
    changed => { changed[7].payload.item.aggregated_output += 'foreign output'; },
    changed => { changed[8].payload.output = changed[8].payload.output.replace('code 0', 'code 7'); },
    changed => { changed.splice(10, 1); },
    changed => { changed[10].payload.item.id = 'another-image'; },
    changed => { changed[10].payload.item.path = 'file:///D:/other.png'; },
    changed => { changed[11].payload.output[0].image_url = 'not-an-image'; },
    changed => { changed[11].payload.call_id = 'another-image'; },
    changed => { changed[10].payload.turn_id = otherTurnId; },
  ];
  for (const change of cases) {
    const changed = structuredClone(rows); change(changed); write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /native_work_(?:tools_incomplete|tool_output|command_session|tool_item|image_not_terminal|tool_identity)/);
  }
});

function failedWorkFixture(t, factory = polledImageFixture) {
  const f = factory(t);
  const end = {...f.rows.at(-1), payload: {type: 'task_complete', turn_id: turnId, last_agent_message: null,
    error: {message: 'Error running remote compact task: original replay unavailable'}}};
  f.rows = f.rows.slice(0, -2).concat(end); f.write(f.rows);
  return f;
}

test('failed compaction reuses exact polled commands and images while retaining the native error', t => {
  const f = failedWorkFixture(t), before = fs.readFileSync(f.file);
  const proof = verifyNativeCompactionFailureReceipt(f.input);
  assert.equal(proof.kind, 'native_compaction_failed_with_terminal_tools');
  assert.equal(proof.returnedTools, 4); assert.equal(proof.uncollectedCommandOutputs, 0);
  assert.equal(proof.taskAcceptance, 'unverified'); assert.equal(proof.workflowJobAbsenceProven, false);
  assert.match(proof.failureSha256, /^[a-f0-9]{64}$/); assert.equal(proof.finalSha256, undefined);
  assert.deepEqual(fs.readFileSync(f.file), before);
  for (const mutate of [
    rows => { rows.splice(7, 1); },
    rows => { rows[7].payload.item.status = 'in_progress'; },
    rows => { rows[7].payload.item.process_id = '88'; },
    rows => { rows[8].payload.output += 'foreign output'; },
    rows => { rows[4].payload.arguments = '{"session_id":88}'; },
    rows => { rows.splice(-1, 0, answer, structuredClone(answer)); },
    rows => { rows.at(-1).payload.error.message = 'an unrelated failure'; },
  ]) {
    const rows = structuredClone(f.rows); mutate(rows); f.write(rows);
    assert.throws(() => verifyNativeCompactionFailureReceipt(f.input));
  }
});

test('a final followed by native failure uses the same full tool reconciliation without accepting the final', t => {
  const f = polledImageFixture(t), rows = structuredClone(f.rows);
  rows.at(-1).payload = {type: 'task_complete', turn_id: turnId, last_agent_message: null,
    error: {message: 'stream disconnected before completion: exact replay of completed browser trace blocked'}};
  f.write(rows); const original = fs.readFileSync(f.file);
  const proof = verifyNativeCompactionFailureReceipt(f.input);
  assert.equal(proof.kind, 'native_failed_with_terminal_tools'); assert.equal(proof.returnedTools, 4);
  assert.equal(proof.priorFinalSha256, hash); assert.equal(proof.nativeTurnState, 'failed');
  assert.equal(proof.taskAcceptance, 'unverified'); assert.equal(proof.automaticReplay, false); assert.equal(proof.finalSha256, undefined);
  assert.deepEqual(fs.readFileSync(f.file), original);
  const checkpoint = {timestamp: '2026-09-26T10:00:01.500Z', type: 'compacted', payload: {replacement_history: [
    {type: 'message', role: 'user', content: [{type: 'input_text', text: 'same original turn'}]},
    {type: 'compaction', encrypted_content: 'ocx1:' + Buffer.from('original checkpoint summary').toString('base64')}]}};
  const checkpointItem = {timestamp: '2026-09-26T10:00:01.501Z', type: 'event_msg', payload: {type: 'item_completed', thread_id: threadId,
    turn_id: turnId, started_at_ms: Date.parse('2026-09-26T10:00:01.400Z'), completed_at_ms: Date.parse('2026-09-26T10:00:01.501Z'),
    item: {type: 'ContextCompaction', id: '01a0dc7b-2a50-7140-a55b-eed50ff96b05'}}};
  const checkpointRows = structuredClone(rows); checkpointRows.splice(-2, 0, checkpoint, checkpointItem); f.write(checkpointRows);
  assert.equal(verifyNativeCompactionFailureReceipt(f.input).returnedTools, 4);
  for (const mutate of [
    changed => { changed.at(-4).payload.replacement_history.push({type: 'function_call', call_id: 'hidden-action'}); },
    changed => { changed.at(-4).payload.replacement_history.push(structuredClone(checkpoint.payload.replacement_history[1])); },
    changed => { changed.at(-4).payload.replacement_history[1].encrypted_content = 'ocx1:bad!'; },
    changed => { const compacted = changed.splice(-4, 1)[0]; compacted.timestamp = '2026-09-26T10:00:02.200Z'; changed.splice(-1, 0, compacted); },
    changed => { changed.splice(-3, 1); },
    changed => { changed.at(-3).payload.completed_at_ms = Date.parse('2026-09-26T10:00:01.450Z'); },
  ]) { const changed = structuredClone(checkpointRows); mutate(changed); f.write(changed); assert.throws(() => verifyNativeCompactionFailureReceipt(f.input)); }
  for (const mutate of [
    changed => { changed.splice(7, 1); },
    changed => { changed[7].payload.item.status = 'in_progress'; },
    changed => { changed[8].payload.output += 'foreign output'; },
    changed => { changed.splice(-1, 0, {...changed[2], timestamp: '2026-09-26T10:00:02.200Z',
      payload: {...changed[2].payload, call_id: 'after-final-call'}}); },
    changed => { const item = changed.splice(7, 1)[0]; item.timestamp = '2026-09-26T10:00:02.200Z'; changed.splice(-1, 0, item); },
    changed => { const output = changed.splice(8, 1)[0]; output.timestamp = '2026-09-26T10:00:02.200Z'; changed.splice(-1, 0, output); },
    changed => { changed.splice(-1, 0, structuredClone(changed.at(-2))); },
    changed => { changed.at(-2).timestamp = '2026-09-26T10:00:04Z'; },
  ]) {
    const changed = structuredClone(rows); mutate(changed); f.write(changed);
    assert.throws(() => verifyNativeCompactionFailureReceipt(f.input));
  }
  const noFinal = rows.filter((_, i) => i !== rows.length - 2);
  noFinal.at(-1).payload.error.message = 'Error running remote compact task: original failure'; f.write(noFinal);
  const old = verifyNativeCompactionFailureReceipt(f.input);
  const boundary = crypto.createHash('sha256').update(JSON.stringify([noFinal[1], noFinal.at(-1)])).digest('hex');
  assert.equal(old.receiptSha256, crypto.createHash('sha256').update(`CLW native failed tools terminal v1\0${boundary}\0${old.toolEventSha256}`).digest('hex'));
});

test('a yielded failure needs the same canonical process terminal even if its last output was never collected', t => {
  const f = failedWorkFixture(t);
  f.rows = f.rows.filter((_, index) => ![4, 5, 6, 8].includes(index)); f.write(f.rows);
  const proof = verifyNativeCompactionFailureReceipt(f.input);
  assert.equal(proof.returnedTools, 2); assert.equal(proof.uncollectedCommandOutputs, 1);
  for (const mutate of [
    rows => { rows.splice(4, 1); },
    rows => { rows[4].payload.item.status = 'in_progress'; },
    rows => { rows[4].payload.item.process_id = '88'; },
    rows => { rows[4].payload.item.exit_code = null; },
  ]) {
    const rows = structuredClone(f.rows); mutate(rows); f.write(rows);
    assert.throws(() => verifyNativeCompactionFailureReceipt(f.input));
  }
});

test('a terminal failed-turn poll can match a fully counted truncated body from its same native process', t => {
  const f = failedWorkFixture(t), rows = f.rows.filter((_, index) => ![4, 5].includes(index));
  rows[3].payload.output = rows[3].payload.output.replace('Output:\nstart\n', 'Output:\n');
  rows[5].payload.item.aggregated_output = 'head' + 'x'.repeat(1000) + 'tail';
  rows[6].payload.output = 'Chunk ID: poll\nWall time: 1 seconds\nProcess exited with code 0\nOriginal token count: 2000\nOutput:\n' +
    'Warning: truncated output (original token count: 2000)\nTotal output lines: 1\n\nhead…1000 chars truncated…tail';
  f.write(rows); assert.equal(verifyNativeCompactionFailureReceipt(f.input).returnedTools, 3);
  rows[6].payload.output = rows[6].payload.output.replace('1000 chars', '999 chars'); f.write(rows);
  assert.throws(() => verifyNativeCompactionFailureReceipt(f.input));
});

test('failed native MCP calls require original arguments, terminal status and exact or counted truncated result', t => {
  const f = failedWorkFixture(t), base = Date.parse(startedAt), stamp = ms => new Date(base + ms).toISOString();
  const original = 'visible head ' + '🙂'.repeat(100) + ' visible tail';
  const returned = 'visible head …100 chars truncated… visible tail';
  const call = {timestamp: stamp(1500), type: 'response_item', payload: {type: 'function_call', call_id: 'mcp-call', name: 'js', arguments: '{"code":"original JS"}'}};
  const item = {timestamp: stamp(1600), type: 'event_msg', payload: {type: 'item_completed', thread_id: threadId, turn_id: turnId,
    started_at_ms: base + 1500, completed_at_ms: base + 1600, item: {type: 'McpToolCall', id: 'mcp-call', server: 'node_repl', tool: 'js',
      arguments: {code: 'original JS'}, status: 'failed', result: {isError: true, content: [{type: 'text', text: original}]}}}};
  const output = {timestamp: stamp(1700), type: 'response_item', payload: {type: 'function_call_output', call_id: 'mcp-call',
    output: [{type: 'input_text', text: 'Wall time: 1 seconds\nOutput:'}, {type: 'input_text', text: returned}]}};
  f.rows.splice(-1, 0, call, item, output); f.write(f.rows);
  assert.equal(verifyNativeCompactionFailureReceipt(f.input).tools.mcp.terminal, 1);
  for (const mutate of [
    rows => { rows.at(-3).payload.item.status = 'in_progress'; },
    rows => { rows.at(-3).payload.item.result.isError = false; },
    rows => { rows.at(-3).payload.item.arguments.code = 'foreign JS'; },
    rows => { rows.at(-3).payload.item.tool = 'another'; },
    rows => { rows.at(-2).payload.output[1].text = returned.replace('100 chars', '101 chars'); },
    rows => { rows.at(-2).payload.output[1].text += 'foreign tail'; },
    rows => { rows.at(-2).payload.output[1].text += '…1 chars truncated…'; },
    rows => { rows.splice(-3, 1); },
  ]) {
    const rows = structuredClone(f.rows); mutate(rows); f.write(rows);
    assert.throws(() => verifyNativeCompactionFailureReceipt(f.input));
  }
  const empty = structuredClone(f.rows);
  empty.at(-3).payload.item.result.content = [{type: 'text', text: ''}];
  empty.at(-2).payload.output = [empty.at(-2).payload.output[0]];
  f.write(empty); assert.equal(verifyNativeCompactionFailureReceipt(f.input).tools.mcp.terminal, 1);
  empty.at(-3).payload.item.result.content[0].text = 'a missing nonempty result'; f.write(empty);
  assert.throws(() => verifyNativeCompactionFailureReceipt(f.input), /mcp_output_mismatch/);
});

test('native process creation failure binds the exact rejected OS message and never fabricates a process', t => {
  const f = failedWorkFixture(t, workFixture), rows = f.rows.slice(0, 5).concat(f.rows.at(-1));
  const item = rows[3].payload.item, message = 'Failed to create unified exec process: OS error 206';
  item.status = 'failed'; item.exit_code = -1; delete item.process_id; item.aggregated_output = message;
  rows[4].payload.output = 'exec_command failed: CreateProcess { message: ' + JSON.stringify('Rejected(' + JSON.stringify(message) + ')') + ' }';
  f.write(rows); assert.equal(verifyNativeCompactionFailureReceipt(f.input).returnedTools, 1);
  for (const mutate of [
    changed => { changed[4].payload.output = changed[4].payload.output.replace('206', '207'); },
    changed => { changed[3].payload.item.process_id = '123'; },
    changed => { changed[3].payload.item.exit_code = 1; },
    changed => { changed[3].payload.item.aggregated_output = 'policy refused'; },
  ]) { const changed = structuredClone(rows); mutate(changed); f.write(changed); assert.throws(() => verifyNativeCompactionFailureReceipt(f.input)); }
});

test('failed command output supports exact token budgets and the explicit canonical 64 KiB persistence envelope', t => {
  const f = failedWorkFixture(t, workFixture), rows = f.rows.slice(0, 5).concat(f.rows.at(-1));
  rows[2].payload.arguments = JSON.stringify({cmd: JSON.parse(rows[2].payload.arguments).cmd, workdir: 'D:/fixture/project', max_output_tokens: 1800});
  const wrap = (text, lines = 1) => `Chunk ID: x\nWall time: 1 seconds\nProcess exited with code 0\nOriginal token count: 2000\nOutput:\nWarning: truncated output (original token count: 2000)\nTotal output lines: ${lines}\n\n${text}`;
  rows[3].payload.item.aggregated_output = 'head' + 'x'.repeat(1000) + 'tail';
  rows[4].payload.output = wrap('head…200 tokens truncated…tail'); f.write(rows);
  assert.equal(verifyNativeCompactionFailureReceipt(f.input).returnedTools, 1);
  rows[4].payload.output = wrap('head…201 tokens truncated…tail'); f.write(rows);
  assert.throws(() => verifyNativeCompactionFailureReceipt(f.input));
  rows[3].payload.item.aggregated_output = 'a'.repeat(32743) + '\n... command output truncated for persistence ...\n' + 'z'.repeat(32743);
  rows[4].payload.output = wrap('a'.repeat(100) + '…80000 chars truncated…' + 'z'.repeat(100)); f.write(rows);
  assert.equal(verifyNativeCompactionFailureReceipt(f.input).returnedTools, 1);
  rows[3].payload.item.aggregated_output = 'a'.repeat(32739) + '中' + '\n... command output truncated for persistence ...\n' + 'z'.repeat(32743);
  f.write(rows); assert.equal(verifyNativeCompactionFailureReceipt(f.input).returnedTools, 1, 'UTF-8 clipping may leave at most three bytes unused per side');
  for (const mutate of [
    changed => { changed[3].payload.item.aggregated_output += 'z'; },
    changed => { changed[4].payload.output = changed[4].payload.output.replace('80000 chars', '5 chars'); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace(/z$/, 'q'); },
    changed => { changed[3].payload.item.status = 'in_progress'; },
  ]) { const changed = structuredClone(rows); mutate(changed); f.write(changed); assert.throws(() => verifyNativeCompactionFailureReceipt(f.input)); }
});

test('seven original-shape native tools produce a content-free terminal proof without granting Job absence or task acceptance', t => {
  const {file, input, rows} = workFixture(t), before = fs.readFileSync(file), terminal = verifyNativeTerminalReceipt(input);
  const proof = verifyNativeCompletedToolsReceipt(input);
  assert.equal(proof.version, 1); assert.equal(proof.kind, 'native_completed_tools_terminal');
  assert.equal(proof.threadId, threadId); assert.equal(proof.turnId, turnId); assert.equal(proof.finalSha256, hash);
  assert.equal(proof.receiptSha256, terminal.receiptSha256); assert.equal(proof.returnedTools, 7);
  assert.deepEqual(proof.tools, {exec_command: {invocations: 5, terminal: 5}, apply_patch: {invocations: 2, terminal: 2}});
  assert.match(proof.toolEventSha256, /^[a-f0-9]{64}$/);
  const originalEvidence=rows.filter(row=>row.type==='response_item'&&['function_call','custom_tool_call','function_call_output','custom_tool_call_output'].includes(row.payload.type)||row.type==='event_msg'&&row.payload.type==='item_completed').map(row=>JSON.stringify(row));
  assert.equal(proof.toolEventSha256,crypto.createHash('sha256').update('CLW native tools terminal v1\0'+JSON.stringify(originalEvidence)).digest('hex'));
  assert.equal(proof.sessionSha256, crypto.createHash('sha256').update(before).digest('hex'));
  assert.equal(proof.executionScope, 'tracked_native_turn_tools'); assert.equal(proof.workflowJobAbsenceProven, false);
  assert.equal(proof.taskAcceptance, 'unverified'); assert.equal(/PRIVATE|D:\/fixture|call_QA/.test(JSON.stringify(proof)), false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => verifyNativeCompletedToolsReceipt({...input, startedAt: undefined}), /window_required/);
});

test('standard middle-truncated output matches the canonical command without certifying task acceptance', t => {
  const {file, input} = truncatedWorkFixture(t), before = fs.readFileSync(file);
  const proof = verifyNativeCompletedToolsReceipt(input);
  assert.equal(proof.returnedTools, 7);
  assert.equal(proof.taskAcceptance, 'unverified');
  assert.equal(proof.workflowJobAbsenceProven, false);
  assert.equal(/保留|truncated|2707/.test(JSON.stringify(proof)), false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('truncation requires matching native token counts, one exact marker, line count and both original fragments', t => {
  const {rows, write, input, omitted} = truncatedWorkFixture(t);
  const scenarios = [
    changed => { changed[4].payload.output = changed[4].payload.output.replace('(original token count: 2707)', '(original token count: 2708)'); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace('Original token count: 2707', 'Original token count: 2708'); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace('Original token count: 2707\n', ''); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace(`…${[...omitted].length} chars truncated…`, `…${[...omitted].length + 1} chars truncated…`); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace(/…\d+ chars truncated…/, '…0 chars truncated…'); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace(/…\d+ chars truncated…/, '…9007199254740992 chars truncated…'); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace(/…\d+ chars truncated…/, '...12 chars truncated...'); },
    changed => { changed[4].payload.output += '…1 chars truncated…'; },
    changed => { changed[4].payload.output = changed[4].payload.output.replace(/Total output lines: (\d+)/, (_, count) => `Total output lines: ${Number(count) + 1}`); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace('保留的开头', '篡改的开头'); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace('保留的结尾', '篡改的结尾'); },
    changed => { changed[4].payload.output = changed[4].payload.output.replace('Warning: truncated output', 'Warning: unknown truncation'); },
  ];
  for (const change of scenarios) {
    const changed = structuredClone(rows); change(changed); write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_output_not_terminal/);
  }
});

test('omitted character count uses Unicode codepoints rather than UTF-16 units', t => {
  const {rows, write, input, omitted} = truncatedWorkFixture(t, '😀中🧪\r\n');
  assert.equal(verifyNativeCompletedToolsReceipt(input).returnedTools, 7);
  assert.notEqual(omitted.length, [...omitted].length);
  const changed = structuredClone(rows);
  changed[4].payload.output = changed[4].payload.output.replace(/…\d+ chars truncated…/, `…${omitted.length} chars truncated…`);
  write(changed);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_output_not_terminal/);
});

test('truncated command output retains terminal failure, identity, directory and time requirements', t => {
  const {rows, write, input} = truncatedWorkFixture(t), failed = structuredClone(rows);
  failed[3].payload.item.status = 'failed'; failed[3].payload.item.exit_code = 1;
  failed[4].payload.output = failed[4].payload.output.replace('code 0', 'code 1'); write(failed);
  const proof = verifyNativeCompletedToolsReceipt(input);
  assert.equal(proof.returnedTools, 7); assert.equal(proof.taskAcceptance, 'unverified');
  for (const change of [
    changed => { changed[3].payload.item.exit_code = 1; },
    changed => { changed[3].payload.item.status = 'in_progress'; },
    changed => { changed[3].payload.item.cwd = 'file:///D:/other'; },
    changed => { changed[3].payload.item.command[2] = 'another command'; },
    changed => { changed[3].payload.turn_id = otherTurnId; },
    changed => { changed[3].payload.completed_at_ms += 1000; },
    changed => { changed.splice(3, 1); },
  ]) {
    const changed = structuredClone(rows); change(changed); write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /native_work_(tool_output|command_not_terminal|tool_identity|tool_window|tools_incomplete)/);
  }
});

test('truncation compatibility does not extend to yielded command output assembled by polling', t => {
  const {rows, write, input} = polledImageFixture(t);
  const original = 'prefixHIDDENsuffix\n';
  const body = 'Warning: truncated output (original token count: 2707)\nTotal output lines: 1\n\nprefix…6 chars truncated…suffix\n';
  rows[7].payload.item.aggregated_output = original;
  rows[3].payload.output = rows[3].payload.output.replace('Output:\nstart\n', `Original token count: 2707\nOutput:\n${body}`);
  rows[5].payload.output = rows[5].payload.output.replace('progress\n', '');
  rows[8].payload.output = rows[8].payload.output.replace('Output:\ndone\n', 'Original token count: 2707\nOutput:\n');
  write(rows);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_output_not_terminal/);
});

test('current CLI thread settings are metadata and cannot replace terminal tool receipts', t => {
  const {rows, write, input} = workFixture(t), base = structuredClone(rows);
  base[0].payload.cwd = 'D:/fixture/project';
  const settings = {timestamp: base[2].timestamp, type: 'event_msg', payload: {
    type: 'thread_settings_applied', thread_id: threadId,
    thread_settings: {cwd: 'D:\\fixture\\project', model: 'chatgpt-web/extra-high', model_provider_id: 'openai'},
  }};
  base.splice(2, 0, settings); write(base);
  assert.equal(verifyNativeCompletedToolsReceipt(input).returnedTools, 7);
  for (const change of [
    value => { value.payload.thread_id = otherTurnId; },
    value => { value.payload.thread_settings.cwd = 'D:/other'; },
    value => { value.payload.thread_settings.model = ''; },
    value => { value.payload.thread_settings.model_provider_id = null; },
  ]) {
    const changed = structuredClone(base); change(changed[2]); write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /settings_invalid/);
  }
  const missing = structuredClone(base); missing.splice(4, 1); write(missing);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tools_incomplete/);
});

test('yielded native sessions and canonically running or unfinished commands cannot provide a tools-terminal proof', t => {
  const {rows, write, input} = workFixture(t);
  const scenarios = [
    changed => { changed[4].payload.output = 'Chunk ID: qa0\nWall time: 0.04 seconds\nProcess running with session ID 40000\nOutput:\n'; },
    changed => { changed[3].payload.item.status = 'in_progress'; },
    changed => { changed[3].payload.item.exit_code = null; },
    changed => { changed.splice(3, 1); },
    changed => { changed.splice(4, 1); },
  ];
  for (const change of scenarios) {
    const changed = structuredClone(rows); change(changed); write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /native_work_(tool_output|command_not_terminal|tools_incomplete)/);
  }
});

test('MCP, tool-search, nested tools and future action kinds remain unsupported even if a final and output exist', t => {
  const {rows, write, input} = workFixture(t);
  for (const payload of [
    {...rows[2].payload, name: 'mcp__local__run_command'}, {...rows[2].payload, name: 'functions.exec'},
    {...rows[2].payload, name: 'write_stdin'}, {...rows[2].payload, type: 'tool_search_call'}, {type: 'future_action'},
  ]) {
    const changed = structuredClone(rows); changed[2].payload = payload; write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_requires_review/);
  }
  const changed = structuredClone(rows); changed[3].payload.item.type = 'McpToolCall'; write(changed);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_requires_review/);
});

test('unmatched, duplicate, wrong-kind, body-tampered and exit-tampered outputs cannot borrow another receipt', t => {
  const {rows, write, input} = workFixture(t);
  const scenarios = [
    changed => { changed[4].payload.call_id = 'call_orphan'; },
    changed => { changed.splice(5, 0, structuredClone(changed[4])); },
    changed => { changed[4].payload.type = 'custom_tool_call_output'; },
    changed => { changed[4].payload.output += 'tampered'; },
    changed => { changed[4].payload.output = changed[4].payload.output.replace('code 0', 'code 1'); },
    changed => { changed[4].payload.output = 'Tool echoed a pretend receipt:\n' + changed[4].payload.output; },
    changed => { changed[4].payload.output = [{type: 'input_text', text: changed[4].payload.output}]; },
    changed => { changed[7].payload.output += 'tampered patch output'; },
  ];
  for (const change of scenarios) {
    const changed = structuredClone(rows); change(changed); write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_output_(unmatched|not_terminal)/);
  }
});

test('canonical tool identity, command, directory and begin/end interval must match the exact original call', t => {
  const {rows, write, input} = workFixture(t);
  const scenarios = [
    changed => { changed[3].payload.turn_id = otherTurnId; },
    changed => { changed[3].payload.thread_id = otherTurnId; },
    changed => { changed[3].payload.item.id = 'call_other'; },
    changed => { changed[3].payload.item.command[2] = 'different command'; },
    changed => { changed[3].payload.item.cwd = 'file:///D:/another/project'; },
    changed => { changed[3].payload.started_at_ms = Date.parse(startedAt) - 1; },
    changed => { changed[3].payload.completed_at_ms = changed[3].payload.started_at_ms - 1; },
    changed => { changed[3].payload.completed_at_ms += 1000; },
    changed => { changed[3].payload.completed_at_ms = String(changed[3].payload.completed_at_ms); },
    changed => { changed.splice(4, 0, structuredClone(changed[3])); },
    changed => { changed[6].payload.item.status = 'in_progress'; },
  ];
  for (const change of scenarios) {
    const changed = structuredClone(rows); change(changed); write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /native_work_(tool_identity|tool_item|tool_window|command_not_terminal|patch_not_terminal)/);
  }
});

test('a matching final does not hide unknown events, compaction, an abort or tools dispatched after that final', t => {
  const {rows, write, input} = workFixture(t);
  for (const row of [
    {type: 'event_msg', payload: {type: 'future_tool_event'}},
    {type: 'event_msg', payload: {type: 'turn_aborted', turn_id: turnId}},
    {type: 'compacted', payload: {}}, {type: 'future_record', payload: {}},
  ]) {
    const changed = structuredClone(rows); changed.splice(2, 0, {...row, timestamp: rows[2].timestamp}); write(changed);
    assert.throws(() => verifyNativeCompletedToolsReceipt(input), /event_requires_review/);
  }
  const changed = structuredClone(rows);
  changed.splice(changed.length - 1, 0, {...structuredClone(changed[2]), timestamp: '2026-09-26T10:00:02.100Z'}); write(changed);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_requires_review/);
  changed.pop(); write(changed); assert.throws(() => verifyNativeCompletedToolsReceipt(input), /terminal_missing/);
});

test('a sibling turn cannot supply missing tools and foreign tool boundaries fail closed', t => {
  const {rows, write, input} = workFixture(t), changed = structuredClone(rows);
  changed[3].payload.turn_id = otherTurnId; changed[4].payload.call_id = 'call_other_turn'; write(changed);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_identity_mismatch/);
  const missing = structuredClone(rows); missing.splice(3, 2); write(missing);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tools_incomplete/);
  const late = structuredClone(rows); late.push({...structuredClone(late[4]), timestamp: endedAt}); write(late);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_outside_turn/);
  const lateItem = structuredClone(rows); lateItem.push({...structuredClone(lateItem[3]), timestamp: endedAt}); write(lateItem);
  assert.throws(() => verifyNativeCompletedToolsReceipt(input), /tool_outside_turn/);
});

test('terminal command failure remains separate from task acceptance and arbitrary detached code grants no absence proof', t => {
  const {rows, write, input} = workFixture(t), changed = structuredClone(rows);
  changed[3].payload.item.status = 'failed'; changed[3].payload.item.exit_code = 1;
  changed[4].payload.output = changed[4].payload.output.replace('code 0', 'code 1'); write(changed);
  const failure = verifyNativeCompletedToolsReceipt(input);
  assert.equal(failure.taskAcceptance, 'unverified'); assert.equal(failure.workflowJobAbsenceProven, false);
  const detached = structuredClone(rows), args = JSON.parse(detached[2].payload.arguments);
  args.cmd = 'Start-Process detached-worker.exe'; detached[2].payload.arguments = JSON.stringify(args); detached[3].payload.item.command[2] = args.cmd;
  write(detached); const tracked = verifyNativeCompletedToolsReceipt(input);
  assert.equal(tracked.workflowJobAbsenceProven, false, 'A synchronous executor exit does not prove a detached worker or Workflow Job ended');
  assert.equal(tracked.executionScope, 'tracked_native_turn_tools');
});

test('tool hashes detect altered canonical evidence and a Session changed during verification is rejected', t => {
  const {rows, file, write, input} = workFixture(t), original = verifyNativeCompletedToolsReceipt(input), changed = structuredClone(rows);
  changed[3].payload.item.process_id = '90000'; write(changed);
  const updated = verifyNativeCompletedToolsReceipt(input);
  assert.equal(updated.receiptSha256, original.receiptSha256);
  assert.notEqual(updated.toolEventSha256, original.toolEventSha256); assert.notEqual(updated.sessionSha256, original.sessionSha256);
  write(rows); const read = fs.readSync; let reads = 0;
  fs.readSync = function (target, ...args) {
    const result = read.call(this, target, ...args);
    if (++reads === 1) fs.appendFileSync(file, '\n');
    return result;
  };
  try { assert.throws(() => verifyNativeCompletedToolsReceipt(input), /session_changed/); }
  finally { fs.readSync = read; }
});

test('exact native terminal proof is small, content-free, read-only, and window-bound when supplied', t => {
  const {file, input} = fixture(t);
  const before = fs.readFileSync(file);
  const proof = verifyNativeTerminalReceipt({...input, startedAt, endedAt});
  assert.deepEqual(Object.keys(proof), ['version', 'threadId', 'turnId', 'status', 'finalSha256', 'receiptSha256', 'windowVerified']);
  assert.equal(proof.threadId, threadId);
  assert.equal(proof.turnId, turnId);
  assert.equal(proof.status, 'completed');
  assert.equal(proof.finalSha256, hash);
  assert.match(proof.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(proof.windowVerified, true);
  assert.equal(JSON.stringify(proof).includes(final.trim()), false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(verifyNativeTerminalReceipt(input).windowVerified, false);
});

test('missing, duplicate and mismatched Session identities fail closed', t => {
  const {file, directory, write, input} = fixture(t);
  assert.throws(() => verifyNativeTerminalReceipt({...input, threadId: otherTurnId}), /session_not_unique/);
  assert.throws(() => verifyNativeTerminalReceipt({...input, turnId: threadId}), /identity_invalid/);
  assert.throws(() => verifyNativeTerminalReceipt({...input, expectedFinalSha256: 'not-a-sha'}), /identity_invalid/);
  write([{...meta, payload: {id: otherTurnId}}, start, answer, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /identity_mismatch/);
  write([meta, start, answer, complete]);
  fs.copyFileSync(file, path.join(directory, `rollout-2026-09-26T10-00-01-${threadId}.jsonl`));
  assert.throws(() => verifyNativeTerminalReceipt(input), /session_not_unique/);
});

test('the exact start, final answer and completion must be unique and ordered', t => {
  const {write, input} = fixture(t);
  write([meta, start, answer]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /terminal_missing/);
  write([meta, start, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /terminal_missing/);
  write([meta, answer, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /boundary_mismatch/);
  write([meta, start, answer, answer, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /terminal_missing/);
  write([meta, start, answer, complete, start, answer, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /terminal_missing/);
  write([meta, start, {...start, payload: {type: 'task_started', turn_id: otherTurnId}}, answer, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /turn_overlap/);
  write([meta, start, answer, {...complete, payload: {...complete.payload, turn_id: otherTurnId}}, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /turn_overlap/);
  write([meta, start, {...answer, timestamp: '2026-09-26T09:59:59Z'}, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /terminal_missing/);
});

test('both native final records must match the expected SHA256 and optional window', t => {
  const {write, input} = fixture(t);
  assert.throws(() => verifyNativeTerminalReceipt({...input, expectedFinalSha256: crypto.createHash('sha256').update('different').digest('hex')}), /final_mismatch/);
  write([meta, start, {...answer, payload: {...answer.payload, content: [{type: 'output_text', text: 'different'}]}}, complete]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /final_mismatch/);
  write([meta, start, answer, {...complete, payload: {...complete.payload, last_agent_message: 'different'}}]);
  assert.throws(() => verifyNativeTerminalReceipt(input), /final_mismatch/);
  write([meta, start, answer, complete]);
  assert.throws(() => verifyNativeTerminalReceipt({...input, startedAt: '2026-09-26T11:00:00Z', endedAt: '2026-09-26T11:00:03Z'}), /window_mismatch/);
  assert.throws(() => verifyNativeTerminalReceipt({...input, startedAt}), /window_invalid/);
  assert.throws(() => verifyNativeTerminalReceipt({...input, startedAt: endedAt, endedAt: startedAt}), /window_invalid/);
});

test('malformed Session files and oversized individual records fail without a proof', t => {
  const {file, write, input} = fixture(t);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => verifyNativeTerminalReceipt(input), /session_unreadable/);
  write([meta, start, answer, complete]);
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  assert.throws(() => verifyNativeTerminalReceipt(input), /record_size_invalid/);
});

test('native status displays the exact failed turn after browser completion without exposing transcript or granting settlement',t=>{
  const {write,input,file}=fixture(t);
  const failed={...complete,payload:{type:'task_complete',turn_id:turnId,error:{message:'Error running remote compact task: PRIVATE_DETAIL'},last_agent_message:null}};
  const action={timestamp:startedAt,type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'PRIVATE_COMMAND'}};
  write([meta,start,action,failed]);const before=fs.readFileSync(file);
  const status=nativeTurnStateForDisplay(input);
  assert.equal(status.state,'failed');assert.equal(status.reason,'compaction_failed');assert.equal(status.turnId,turnId);
  assert.equal(status.source,'native_session_terminal');assert.equal(JSON.stringify(status).includes('PRIVATE'),false);
  assert.equal('receiptSha256' in status,false);assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'unavailable');
  const {turnView}=require('../../web-host/codex-turns.js');
  const view=turnView({status:'completed',submission:'confirmed',nativeState:status});
  assert.equal(view.needsAttention,true);assert.equal(view.step,null);assert.match(view.status,/执行失败/);assert.match(view.note,/压缩失败退出/);
});

test('unfinished and ambiguous native records remain unknown; a subsequently saved exact terminal updates display',t=>{
  const {write,input}=fixture(t);write([meta,start]);
  assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');
  write([meta,start,answer,complete]);assert.equal(nativeTurnStateForDisplay(input).state,'completed');
  const {turnView}=require('../../web-host/codex-turns.js');
  assert.equal(turnView({status:'completed',nativeState:nativeTurnStateForDisplay(input)}).step,3);
  write([meta,start,{...complete,payload:{...complete.payload,turn_id:otherTurnId}}]);
  assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');
  write([meta,start,start,complete]);assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');
  write([{...meta,payload:{id:otherTurnId}},start,complete]);assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');
});

test('status parses one real Session revision for all exact turns and refreshes the active terminal on append',t=>{
  const {file,write,input}=fixture(t),thirdTurnId='01a0dc7b-2a50-7140-a55b-eed50ff96b05';
  const event=(type,id,extra={})=>({timestamp:endedAt,type:'event_msg',payload:{type,turn_id:id,...extra}});
  const rows=[meta,start,answer,complete,event('task_started',otherTurnId),event('turn_aborted',otherTurnId),event('task_started',thirdTurnId)];
  write(rows);const original=fs.openSync;let reads=0;
  fs.openSync=function(target,...args){if(String(target)===file)reads++;return original.call(this,target,...args);};
  try{
    for(let iteration=0;iteration<4;iteration++){
      assert.equal(nativeTurnStateForDisplay(input).state,'completed');
      assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'aborted');
      assert.equal(nativeTurnStateForDisplay({...input,turnId:thirdTurnId}).state,'unavailable');
    }
    assert.equal(reads,2);
    fs.appendFileSync(file,JSON.stringify(event('task_complete',thirdTurnId,{error:{message:'Error running remote compact task: PRIVATE'},last_agent_message:null}))+'\n');
    assert.equal(nativeTurnStateForDisplay({...input,turnId:thirdTurnId}).state,'failed');
    assert.equal(nativeTurnStateForDisplay({...input,turnId:thirdTurnId}).reason,'compaction_failed');
    assert.equal(nativeTurnStateForDisplay(input).state,'completed');
    assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'aborted');
    assert.equal(reads,4);assert.equal(JSON.stringify(nativeTurnStateForDisplay({...input,turnId:thirdTurnId})).includes('PRIVATE'),false);
  }finally{fs.openSync=original;}
});

test('status revision cache rejects replaced identity and malformed revisions even with restored mtime and size',t=>{
  const {file,input,write}=fixture(t);assert.equal(nativeTurnStateForDisplay(input).state,'completed');
  const before=fs.statSync(file),original=fs.readFileSync(file,'utf8');
  const changed=original.replace(threadId,otherTurnId);assert.equal(Buffer.byteLength(changed),before.size);
  fs.writeFileSync(file,changed);fs.utimesSync(file,before.atime,before.mtime);
  assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');
  write([meta,start,answer,complete]);assert.equal(nativeTurnStateForDisplay(input).state,'completed');
  fs.writeFileSync(file,'{invalid');const originalRead=fs.openSync;let reads=0;
  fs.openSync=function(target,...args){if(String(target)===file)reads++;return originalRead.call(this,target,...args);};
  try{assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'unavailable');assert.equal(reads,2);}
  finally{fs.openSync=originalRead;}
});

test('active Session display reads only the appended bytes and small anchors, including a partial UTF-8 line',t=>{
  const {file,write,input}=fixture(t),filler=Array.from({length:500},()=>({timestamp:endedAt,type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'context '+ 'x'.repeat(1000)}]}}));
  const active={timestamp:endedAt,type:'event_msg',payload:{type:'task_started',turn_id:otherTurnId}};
  write([meta,start,answer,complete,active,...filler]);const originalSize=fs.statSync(file).size;
  assert.equal(nativeTurnStateForDisplay(input).state,'completed');assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'unavailable');
  const originalRead=fs.readFileSync,originalOpen=fs.openSync,originalChunk=fs.readSync,originalClose=fs.closeSync;
  const watched=new Set();let fullReads=0,bytes=0;
  fs.readFileSync=function(target,...args){const result=originalRead.call(this,target,...args);if(String(target)===file){fullReads++;bytes+=Buffer.byteLength(result);}return result;};
  fs.openSync=function(target,...args){const fd=originalOpen.call(this,target,...args);if(String(target)===file)watched.add(fd);return fd;};
  fs.readSync=function(fd,...args){const count=originalChunk.call(this,fd,...args);if(watched.has(fd))bytes+=count;return count;};
  fs.closeSync=function(fd,...args){watched.delete(fd);return originalClose.call(this,fd,...args);};
  try{
    const terminal=Buffer.from(JSON.stringify({timestamp:endedAt,type:'event_msg',payload:{type:'task_complete',turn_id:otherTurnId,last_agent_message:'Finished 🙂 exact turn'}})+'\n');
    const split=terminal.indexOf(Buffer.from('🙂'))+2;
    fs.appendFileSync(file,terminal.subarray(0,split));assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'unavailable');
    fs.appendFileSync(file,terminal.subarray(split));assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'completed');
    assert.equal(nativeTurnStateForDisplay(input).state,'completed');assert.equal(fullReads,0);assert.ok(bytes<=2*8192+terminal.length);assert.ok(bytes<originalSize/8);
    const afterRead=bytes;assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'completed');assert.equal(bytes,afterRead);
  }finally{fs.readFileSync=originalRead;fs.openSync=originalOpen;fs.readSync=originalChunk;fs.closeSync=originalClose;}
});

test('active-tail cache rebuilds after identity rewrite with growth, replacement and truncation',t=>{
  const {file,write,input}=fixture(t),filler={timestamp:endedAt,type:'response_item',payload:{type:'reasoning',summary:'x'.repeat(12000)}};
  write([meta,start,answer,complete,filler]);assert.equal(nativeTurnStateForDisplay(input).state,'completed');
  write([{...meta,payload:{id:otherTurnId}},start,answer,complete,filler,filler]);
  assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');
  write([meta,start,answer,complete,filler]);assert.equal(nativeTurnStateForDisplay(input).state,'completed');
  const replacement=file+'.new',rows=[meta,{...start,payload:{type:'task_started',turn_id:otherTurnId}},
    {...complete,payload:{type:'task_complete',turn_id:otherTurnId,error:{message:'replacement failed'}}},filler];
  write(rows,replacement);fs.renameSync(replacement,file);
  assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'failed');
  write([meta,start]);assert.equal(nativeTurnStateForDisplay({...input,turnId:otherTurnId}).state,'unavailable');assert.equal(nativeTurnStateForDisplay(input).state,'unavailable');
});


test('success and failed-compaction canonical proofs stream an actual multi-turn Session beyond 64 MiB',t=>{
 const f=workFixture(t),fd=fs.openSync(f.file,'w'),padding=JSON.stringify({timestamp:startedAt,type:'token_usage_record',payload:{detail:'x'.repeat(8192)}})+'\n';
 try{
  fs.writeSync(fd,JSON.stringify(meta)+'\n');
  for(const row of [{timestamp:startedAt,type:'event_msg',payload:{type:'task_started',turn_id:otherTurnId}},{timestamp:startedAt,type:'event_msg',payload:{type:'task_complete',turn_id:otherTurnId,error:{message:'historical failure'},last_agent_message:null}}])fs.writeSync(fd,JSON.stringify(row)+'\n');
  for(let n=0;n<8400;n++)fs.writeSync(fd,padding);
  for(const row of f.rows.slice(1))fs.writeSync(fd,JSON.stringify(row)+'\n');
 }finally{fs.closeSync(fd);}
 assert.ok(fs.statSync(f.file).size>64*1024*1024);
 const original=fs.readFileSync;fs.readFileSync=function(target,...args){if(typeof target==='number'||target===f.file)throw Error('whole Session read forbidden');return original.call(this,target,...args);};
 try{const proof=verifyNativeCompletedToolsReceipt(f.input);assert.equal(proof.returnedTools,7);assert.equal(nativeTurnStateForDisplay(f.input).state,'completed');assert.match(proof.sessionSha256,/^[a-f0-9]{64}$/);}
 finally{fs.readFileSync=original;}
 // Preserve the large history prefix and change only the original turn's
 // terminal, using the existing compaction contract and returned tool shapes.
 const rawTail=f.rows.slice(1).map(row=>JSON.stringify(row)+'\n').join(''),size=fs.statSync(f.file).size;
 fs.truncateSync(f.file,size-Buffer.byteLength(rawTail));
 const failed={...complete,payload:{type:'task_complete',turn_id:turnId,error:{message:'Error running remote compact task: fixture'},last_agent_message:null}};
 fs.appendFileSync(f.file,f.rows.slice(1,-2).concat(failed).map(row=>JSON.stringify(row)+'\n').join(''));
 const {verifyNativeCompactionFailureReceipt}=require('../native-terminal-receipt.cjs');
 fs.readFileSync=function(target,...args){if(typeof target==='number'||target===f.file)throw Error('whole Session read forbidden');return original.call(this,target,...args);};
 try{const proof=verifyNativeCompactionFailureReceipt(f.input);assert.equal(proof.returnedTools,7);assert.equal(proof.kind,'native_compaction_failed_with_terminal_tools');}
 finally{fs.readFileSync=original;}
});
