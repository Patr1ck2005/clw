const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {calls,label}=require('../mcp-activity.js');

test('tool timeline groups one call without assigning it to a Codex turn',()=>{
  const activity={source:'mcp_union_metadata',turnAttribution:'unavailable',events:[
    {callId:'one',event:'mcp_call_started',tool:'codex_exec',route:'native',at:'2026-09-26T20:00:00Z'},
    {callId:'one',event:'native_result',tool:'codex_exec',route:'native',at:'2026-09-26T20:00:03Z',applicationSuccess:true,durationMs:3000},
    {callId:'one',event:'mcp_response_sent',tool:'codex_exec',route:'native',at:'2026-09-26T20:00:04Z',httpStatus:200}
  ]};
  const rows=calls(activity);
  assert.equal(rows.length,1);
  assert.equal(rows[0].phase,'native_result');
  assert.equal(rows[0].delivered,true);
  assert.equal(label(rows[0]),'工具回包报告成功');
  assert.equal(rows[0].threadId,undefined);
});

test('HTTP success and unknown application result never become task success',()=>{
  const activity={source:'mcp_union_metadata',events:[
    {callId:'failed',event:'mcp_call_finished',tool:'read_files',route:'webcodex',at:'2026-09-26T20:00:01Z',httpStatus:200,applicationSuccess:false},
    {callId:'unknown',event:'mcp_call_finished',tool:'read_files',route:'webcodex',at:'2026-09-26T20:00:02Z',httpStatus:200},
    {callId:'lost',event:'mcp_client_disconnected',tool:'run_process',route:'webcodex',at:'2026-09-26T20:00:03Z'}
  ]};
  assert.deepEqual(calls(activity).map(label),[
    '本次工具通信中断 · 执行结果待核对','工具已返回 · 业务结果待核验','工具回包报告失败'
  ]);
  assert.deepEqual(calls({...activity,source:'untrusted'}),[]);
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.match(html,/mcp-activity\.js/);
  assert.match(html,/尚未关联到具体对话/);
});

test('batch failure count overrides a successful outer envelope in both activity views',()=>{
  const row={callId:'partial',event:'mcp_call_finished',tool:'read_files',route:'webcodex',
    at:'2026-09-26T20:00:01Z',httpStatus:200,applicationSuccess:true,itemFailureCount:1};
  assert.equal(label(calls({source:'mcp_union_metadata',events:[row]})[0]),'部分条目失败 · 查看原回包');
});
test('many calls remain available for expansion instead of silently truncating at twelve',()=>{
 const rows=calls({source:'mcp_union_metadata',events:Array.from({length:35},(_,i)=>({callId:String(i),tool:'read_files',event:'mcp_call_finished',at:new Date(1000*i).toISOString()}))});
 assert.equal(rows.length,35);assert.equal(rows[0].callId,'34');assert.equal(rows.at(-1).callId,'0');
});
