'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {assertCurrentFaultPlan, evaluateCandidate, evaluateStopSnapshot,
  fixtureWorker, fixtureVerifier, fixturePrompt, statusReady,
  bridgeIdentityReady} = require('../../../evidence/NATIVE-COMPLETION-RECEIPT-20260927/live-owner-result-fault.cjs');

const nonce = '1234567890ABCDEF';
const traceId = 'c47de5d7c957';
const callId = 'call_j1fHpAvXx2QLWSSZH-0zJ4qcXohzilUH';
const plan = {preparedAt: '2026-09-27T04:00:00.000Z', expectedResult: `SUM=20\nNONCE=${nonce}\n`};
const source = {traceId, threadId: '01a0e0e5-340e-7351-b9b8-8d613428415a',
  turnId: '01a0e0e5-351b-76c3-959e-32f6b14acb0a'};
const atMs = Date.parse('2026-09-27T04:01:00.000Z');
const events = ['queued', 'delivered', 'result'].map((phase, index) =>
  ({eventId: index + 10, atMs: atMs + index, traceId, callId, phase, tool: 'exec_command'}));
const good = {plan, source, events,
  submissionMarkers: [`${traceId}-one/18-submission-accepted.json`],
  assistantMarkers: [`${traceId}-one/19-send-accepted.json`],
  receipts: [{file: 'a'.repeat(64) + '.json', resultDigest: 'b'.repeat(64)}],
  actualResult: plan.expectedResult, activeHttp: 1, activeBrowser: 1};

test('candidate requires one original call, one Send, one durable receipt and a live original turn', () => {
  assert.deepEqual(evaluateCandidate(good), {traceId, threadId: source.threadId, turnId: source.turnId,
    callId, resultEventId: 12, receiptFile: good.receipts[0].file,
    resultDigest: 'b'.repeat(64), submissionMarker: good.submissionMarkers[0],
    assistantMarker: good.assistantMarkers[0]});
  for (const change of [
    {submissionMarkers: []}, {assistantMarkers: []},
    {assistantMarkers: [good.assistantMarkers[0], good.assistantMarkers[0]]}, {receipts: []},
    {activeHttp: 0}, {activeBrowser: 0}, {actualResult: 'SUM=20\nNONCE=other\n'},
    {events: events.slice(0, 2)},
    {events: [...events, {...events[2], eventId: 13, callId: callId + '_other', phase: 'queued'}]},
    {events: events.map(item => ({...item, traceId: '000000000000'}))},
    {events: events.map(item => ({...item, atMs: Date.parse(plan.preparedAt) - 1}))},
    {events: events.map(item => ({...item, tool: 'other'}))},
    {events: [...events, {eventId: 13, atMs: atMs + 3, traceId: '000000000000',
      callId: 'call_abcdefghijklmnop', phase: 'queued', tool: 'exec_command'}]},
  ]) assert.equal(evaluateCandidate({...good, ...change}), null);
});

test('final guard rechecks original call and sole recorded browser turn after slow checks', () => {
  const runningTurns = [{traceId, status: 'running', startedAt: '2026-09-27T04:00:30.000Z'}];
  const expected = evaluateCandidate(good);
  const snapshot = {...good, runningTurns};
  assert.deepEqual(evaluateStopSnapshot(snapshot, expected), expected);
  const lateSecondCall = {eventId: 13, atMs: atMs + 3, traceId,
    callId: 'call_abcdefghijklmnop', phase: 'queued', tool: 'exec_command'};
  assert.equal(evaluateStopSnapshot({...snapshot, events: [...events, lateSecondCall]}, expected), null);
  assert.equal(evaluateStopSnapshot({...snapshot, runningTurns: [
    {traceId: '000000000000', status: 'running', startedAt: runningTurns[0].startedAt}]}, expected), null);
  assert.equal(evaluateStopSnapshot({...snapshot, runningTurns: [runningTurns[0],
    {traceId: '000000000000', status: 'running', startedAt: runningTurns[0].startedAt}]}, expected), null);
  assert.equal(evaluateStopSnapshot({...snapshot, activeHttp: 1, activeBrowser: 1,
    runningTurns: [{...runningTurns[0], status: 'completed'}]}, expected), null);
  assert.equal(evaluateStopSnapshot({...snapshot, source: {...source, turnId: '00000000-0000-0000-0000-000000000000'}}, expected), null);
  assert.equal(evaluateStopSnapshot({...snapshot, events: events.map(event =>
    event.phase === 'result' ? {...event, eventId: 15} : event)}, expected), null);
});

test('a plan prepared before the final stop guard cannot arm', () => {
  assert.throws(() => assertCurrentFaultPlan({version: 1}), /prepared_fixture_predates_stop_guard/);
  assert.doesNotThrow(() => assertCurrentFaultPlan({version: 1, faultGuardVersion: 2}));
});

test('live fault stop stays disabled until an atomic execution-owner hook exists', () => {
  const fixture = path.resolve(__dirname, '../../../evidence/NATIVE-COMPLETION-RECEIPT-20260927/live-owner-result-fault.cjs');
  const run = spawnSync(process.execPath, [fixture, 'watch', path.join(os.tmpdir(), 'unused-clw-fixture'),
    '123', 'STOP_EXACT_OWNER_AFTER_FIRST_RESULT'], {encoding: 'utf8', timeout: 10000});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /atomic_stop_guard_unavailable/);
});

test('watch may accept a busy browser while preparation still requires a ready browser', () => {
  const status = {state: 'ready', account: 'B', connector: 'Local-MCP-B', transport: 'shared-mcp',
    proxy: 'http://127.0.0.1:17890', tools: {ready: true}, browser: {status: 'ready'},
    listenerState: 'ready', pid: 1, runtimePid: 2, listenerPid: 3,
    endpoint: 'http://127.0.0.1:60505/v1'};
  assert.equal(statusReady(status), true);
  assert.equal(bridgeIdentityReady({...status, browser: {status: 'working'}}), true);
  assert.equal(statusReady({...status, browser: {status: 'working'}}), false);
  assert.equal(bridgeIdentityReady({...status, proxy: 'direct'}), false);
});

test('isolated PowerShell worker writes once, verifies, and refuses replay without changing the result', t => {
  if (process.platform !== 'win32') { t.skip('Windows PowerShell fixture'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clw-p6-worker-'));
  t.after(() => fs.rmSync(work, {recursive: true, force: true}));
  fs.writeFileSync(path.join(work, 'INPUT.txt'), '4 7 9\n');
  fs.writeFileSync(path.join(work, 'WORK.ps1'), fixtureWorker(nonce));
  fs.writeFileSync(path.join(work, 'VERIFY.ps1'), fixtureVerifier(nonce));
  const run = script => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    {cwd: work, windowsHide: true, encoding: 'utf8', timeout: 10000});
  const first = run('WORK.ps1');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /SUM=20/);
  const result = fs.readFileSync(path.join(work, 'RESULT.txt'));
  assert.equal(result.toString('utf8'), plan.expectedResult);
  const verify = run('VERIFY.ps1');
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /RESULT_EXACT=1/);
  const second = run('WORK.ps1');
  assert.notEqual(second.status, 0);
  assert.deepEqual(fs.readFileSync(path.join(work, 'RESULT.txt')), result);
  assert.doesNotMatch(fixturePrompt(nonce), /WORK\.ps1 \./);
});
