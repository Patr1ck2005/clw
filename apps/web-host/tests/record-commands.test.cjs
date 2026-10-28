'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {readRecords,actions}=require('../record-commands.cjs');

function fixture({ready=true,pageKind='task'}={}){
  const calls=[],pages=new Map([['page-A',{id:'page-A',kind:pageKind}],['account-A',{id:'account-A',kind:'account'}]]);
  const runtime={ready,call:async(action,payload)=>{calls.push({route:'runtime',action,payload});return {result:'read'};}};
  const source={traceId:'123456abcdef',threadId:'thread-A',turnId:'turn-A'};
  const nativeBridge={turn:async traceId=>{calls.push({route:'turn',traceId});return {traceId,source};},history:async payload=>{calls.push({route:'history',payload});return {rows:[]};},recordIndex:async payload=>{calls.push({route:'index',payload});return {items:[]};}};
  return {calls,pages,runtime,nativeBridge,resolvePage:id=>pages.get(id)};
}
const webPayload={mode:'web',id:'page-A'},nativePayload={mode:'codex',task_key:'thread-A'};

test('the dispatcher exposes exactly the three record reads and rejects lifecycle or write actions',async()=>{
  assert.deepEqual([...actions].sort(),['record-body','record-history','record-index']);
  for(const action of ['wire','artifact','send','stop','resume','hide','delete','record-history-extra']){
    const f=fixture();await assert.rejects(readRecords(action,webPayload,f),/record_action_invalid/);assert.deepEqual(f.calls,[]);
  }
});

test('web reads resolve the owned task page and forward only bounded read arguments',async()=>{
  for(const [action,extra,expected]of [
    ['record-history',{before_seq:50,limit:40},{before_seq:50,limit:40}],
    ['record-history',{around_seq:50},{around_seq:50}],
    ['record-index',{query:'literal [x] .*',after_seq:50,limit:20},{query:'literal [x] .*',after_seq:50,limit:20}],
    ['record-body',{seq:50},{seq:50}],
  ]){
    const f=fixture(),result=await readRecords(action,{...webPayload,...extra,op:'send',page_id:'other',source_path:'private.md',write:true,secret:'unused'},f);
    assert.deepEqual(result,{result:'read'});assert.deepEqual(f.calls,[{route:'runtime',action,payload:{page_id:'page-A',...expected}}]);
  }
});

test('native reads use the selected task key and exact trace cursors without calling runtime',async()=>{
  for(const [action,extra,route,expected]of [
    ['record-history',{position:'first',limit:40},'history',{position:'first',limit:40,task_key:'thread-A'}],
    ['record-history',{before_trace:'123456abcdef'},'history',{task_key:'thread-A',before_trace:'123456abcdef'}],
    ['record-index',{query:'answer',after_trace:'123456abcdef'},'index',{query:'answer',task_key:'thread-A',after_trace:'123456abcdef'}],
  ]){
    const f=fixture();await readRecords(action,{...nativePayload,...extra,op:'resume',thread_id:'other',path:'private.jsonl',write:true},f);
    assert.deepEqual(f.calls,[{route,payload:expected}]);
  }
});

test('native body read verifies returned trace and task source before returning the saved row',async()=>{
  const f=fixture();const result=await readRecords('record-body',{...nativePayload,traceId:'123456abcdef'},f);
  assert.equal(result.task_key,'thread-A');assert.equal(result.row.traceId,'123456abcdef');assert.deepEqual(f.calls,[{route:'turn',traceId:'123456abcdef'}]);
  for(const row of [null,{traceId:'different',source:{threadId:'thread-A'}},{traceId:'123456abcdef',source:{threadId:'thread-B'}}]){
    const denied=fixture();denied.nativeBridge.turn=async()=>row;
    await assert.rejects(readRecords('record-body',{...nativePayload,traceId:'123456abcdef'},denied),/record_body_identity_mismatch/);assert.deepEqual(denied.calls,[]);
  }
});

test('unmapped native bodies can be read only through their exact unmapped task identity',async()=>{
  const f=fixture();f.nativeBridge.turn=async traceId=>({traceId});
  const result=await readRecords('record-body',{mode:'codex',task_key:'unmapped:123456abcdef',traceId:'123456abcdef'},f);assert.equal(result.row.traceId,'123456abcdef');
  await assert.rejects(readRecords('record-body',{mode:'codex',task_key:'thread-A',traceId:'123456abcdef'},f),/record_body_identity_mismatch/);
});

test('invalid pages, accounts, modes and malformed payloads do not reach a runtime or native read',async()=>{
  const cases=[
    [null,'record_request_invalid'],[[],'record_request_invalid'],['text','record_request_invalid'],
    [{mode:'other',id:'page-A'},'record_mode_invalid'],[{mode:'web'},'record_page_required'],
    [{mode:'web',id:'missing'},'record_page_invalid'],[{mode:'web',id:'account-A'},'record_page_invalid'],
    [{mode:'web',id:'page-A\u0000'},'record_page_required'],[{mode:'web',id:'x'.repeat(257)},'record_page_required'],
    [{mode:'codex'},'record_task_required'],[{mode:'codex',task_key:'thread-A\n'},'record_task_required'],
  ];
  for(const [payload,error]of cases){const f=fixture();await assert.rejects(readRecords('record-history',payload,f),new RegExp(error));assert.deepEqual(f.calls,[]);}
  const mismatched=fixture();mismatched.pages.set('page-A',{id:'different',kind:'task'});
  await assert.rejects(readRecords('record-history',webPayload,mismatched),/record_page_invalid/);assert.deepEqual(mismatched.calls,[]);
});

test('read limits, positions, literal query size and sequence cursors are validated before dispatch',async()=>{
  for(const [extra,error]of [
    [{position:'middle'},'record_position_invalid'],[{limit:0},'record_limit_invalid'],[{limit:81},'record_limit_invalid'],[{limit:1.5},'record_limit_invalid'],[{limit:'40'},'record_limit_invalid'],
    [{before_seq:0},'record_cursor_invalid'],[{after_seq:-1},'record_cursor_invalid'],[{around_seq:1.5},'record_cursor_invalid'],[{before_seq:Number.MAX_SAFE_INTEGER+1},'record_cursor_invalid'],[{seq:'2'},'record_cursor_invalid'],
  ]){const f=fixture();await assert.rejects(readRecords('record-history',{...webPayload,...extra},f),new RegExp(error));assert.deepEqual(f.calls,[]);}
  for(const query of [1,'x'.repeat(201)]){const f=fixture();await assert.rejects(readRecords('record-index',{...webPayload,query},f),/record_query_invalid/);assert.deepEqual(f.calls,[]);}
  const f=fixture();await readRecords('record-index',{...webPayload,query:'',limit:80,position:'latest'},f);
  assert.deepEqual(f.calls[0].payload,{page_id:'page-A',position:'latest',limit:80,query:''});
});

test('native cursor strings cannot carry paths, controls or unbounded identities',async()=>{
  for(const key of ['before_trace','after_trace','around_trace'])for(const value of ['','../saved','bad\ntrace','x'.repeat(129),7]){
    const f=fixture();await assert.rejects(readRecords('record-history',{...nativePayload,[key]:value},f),/record_cursor_invalid/);assert.deepEqual(f.calls,[]);
  }
  for(const payload of [{...webPayload},{...nativePayload},{...nativePayload,traceId:'../saved'}]){
    const f=fixture();await assert.rejects(readRecords('record-body',payload,f),/record_cursor_required/);assert.deepEqual(f.calls,[]);
  }
});

test('unavailable read providers fail without falling back to another execution route',async()=>{
  const web=fixture({ready:false});await assert.rejects(readRecords('record-history',webPayload,web),/runtime_not_connected/);assert.deepEqual(web.calls,[]);
  for(const action of ['record-history','record-index']){const f=fixture();delete f.nativeBridge[action==='record-history'?'history':'recordIndex'];await assert.rejects(readRecords(action,nativePayload,f),/record_history_unavailable/);assert.deepEqual(f.calls,[]);}
  const native=fixture();native.nativeBridge=null;await assert.rejects(readRecords('record-body',{...nativePayload,traceId:'123456abcdef'},native),/record_body_identity_mismatch/);assert.deepEqual(native.calls,[]);
});
