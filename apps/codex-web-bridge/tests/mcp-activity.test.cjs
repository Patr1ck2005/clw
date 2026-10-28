'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createActivityProjection}=require('../mcp-activity.cjs');
const {journal}=require('../union-journal.cjs');
const CALLS=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
const sessionHash='a'.repeat(64);
function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-mcp-projection-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  return {home,file:path.join(home,'mcp-activity.jsonl')};
}
function row(callId,event='mcp_call_started',extra={}){
  return {at:'2026-09-26T12:00:00.000Z',callId,event,tool:'read_files',route:'webcodex',...extra};
}

test('projection shows only union metadata and never invents a Codex turn',t=>{
  const {home,file}=fixture(t);
  fs.writeFileSync(file,JSON.stringify(row(CALLS[0],'mcp_call_started',{
    sessionHash,turnHash:'b'.repeat(64),traceId:'private-trace',arguments:{password:'secret'},
    result:{text:'private-output'},error:'private-error',prompt:'private-prompt'}))+'\n');
  fs.appendFileSync(file,JSON.stringify(row(CALLS[0],'mcp_call_finished',{
    sessionHash,httpStatus:200,durationMs:47,bodyInspected:true,rpcError:false,
    isError:false,applicationSuccess:true,itemFailureCount:1,bytes:123456,error:'private-error'}))+'\n');
  const result=createActivityProjection(home)();
  assert.equal(result.turnAttribution,'unavailable');
  assert.equal(result.history,'bounded_rotating_journal');
  assert.deepEqual(result.events.map(x=>x.event),['mcp_call_started','mcp_call_finished']);
  assert.equal(result.events[0].sessionHash,sessionHash);
  assert.equal(result.sessionAttribution,'request_argument_hash_unverified');
  assert.equal(result.events[0].attribution,'session_argument_hash');
  assert.equal(result.events[1].route,'webcodex');
  assert.equal(result.events[1].durationMs,47);
  assert.equal(result.events[1].applicationSuccess,true);
  assert.equal(result.events[1].itemFailureCount,1);
  const publicText=JSON.stringify(result);
  for(const secret of ['turnHash','traceId','password','private-output','private-error','private-prompt','bytes'])
    assert.equal(publicText.includes(secret),false,secret);
});

test('all MCP calls including discovery, status and runtime gateways remain visible',t=>{
  const {home,file}=fixture(t),write=journal(file);
  for(const [index,tool] of ['tool_manifest','runtime_status','call_runtime_tool'].entries())
    write({event:'mcp_call_started',callId:CALLS[index],tool,route:'webcodex',sessionHash});
  write({event:'mcp_call_started',callId:CALLS[3],tool:'codex_exec',route:'native',turnHash:'c'.repeat(64)});
  write({event:'native_result',callId:CALLS[3],tool:'codex_exec',route:'native',isError:false});
  const result=createActivityProjection(home)();
  assert.deepEqual(result.events.map(x=>x.tool),['tool_manifest','runtime_status','call_runtime_tool','codex_exec','codex_exec']);
  assert.ok(result.events.slice(0,3).every(x=>x.attribution==='session_argument_hash'&&x.route==='webcodex'));
  assert.ok(result.events.slice(3).every(x=>x.attribution==='unattributed'&&x.sessionHash===undefined&&x.route==='native'));
});

test('unchanged snapshots are cached and new complete rows refresh the bounded window',t=>{
  const {home,file}=fixture(t),read=createActivityProjection(home,{maxEvents:2,maxReadBytes:1024});
  const empty=read();assert.equal(empty.events.length,0);assert.strictEqual(read(),empty);
  fs.writeFileSync(file,JSON.stringify(row(CALLS[0]))+'\n');
  const first=read();assert.notStrictEqual(first,empty);assert.equal(first.events.length,1);
  assert.strictEqual(read(),first);
  fs.appendFileSync(file,JSON.stringify(row(CALLS[1],'mcp_call_started'))+'\n');
  fs.appendFileSync(file,JSON.stringify(row(CALLS[2],'mcp_call_started'))+'\n');
  const latest=read();assert.equal(latest.events.length,2);assert.equal(latest.windowTruncated,true);
  assert.equal(latest.events[1].callId,CALLS[2]);
});

test('rotation duplicates are idempotent and incomplete or invalid rows are ignored',t=>{
  const {home,file}=fixture(t),valid=JSON.stringify(row(CALLS[3]));
  fs.writeFileSync(file+'.previous',valid+'\n');
  fs.writeFileSync(file,valid+'\n'+JSON.stringify(row('invalid-call'))+'\n'+valid.slice(0,40));
  const read=createActivityProjection(home),first=read();
  assert.equal(first.events.length,1);
  fs.appendFileSync(file,valid.slice(40)+'\n');
  const second=read();assert.equal(second.events.length,1);
  assert.equal(new Set(second.events.map(x=>x.id)).size,second.events.length);
});

test('tail projection never scans or returns the entire large journal',t=>{
  const {home,file}=fixture(t);
  const rows=Array.from({length:40},(_,i)=>JSON.stringify(row(
    `${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`))+'\n');
  fs.writeFileSync(file,rows.join(''));
  const result=createActivityProjection(home,{maxEvents:3,maxReadBytes:1024})();
  assert.equal(result.windowTruncated,true);
  assert.ok(result.events.length<=3);
  assert.equal(result.events.at(-1).callId,'00000039-1111-4111-8111-111111111111');
});

test('call details expose original references and distinguish missing or failed capture',t=>{
  const {home,file}=fixture(t),reference='result_'+'a'.repeat(32),resultHome=path.join(home,'result-cache');
  fs.mkdirSync(path.join(resultHome,reference),{recursive:true});
  fs.writeFileSync(path.join(resultHome,reference,'meta.json'),'{}');
  const write=journal(file);
  write(row(CALLS[0]));
  write(row(CALLS[0],'mcp_call_details',{part:'arguments',resultId:reference,complete:true}));
  write(row(CALLS[0],'mcp_call_details',{part:'response',code:'call_details_observer_busy'}));
  const events=createActivityProjection(home)().events;
  const details=events[0].details;
  assert.equal(details.available,true);assert.equal(details.arguments.available,true);
  assert.equal(details.arguments.result_id,reference);
  assert.equal(details.response.available,false);assert.equal(details.response.reason,'call_details_observer_busy');
  assert.equal(new Set(events.map(row=>row.id)).size,3);
});
