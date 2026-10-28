'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {capabilities,taskIdentity,assertControlIdentity,commandPayload}=require('../app-control-identity.cjs');
const {readRecords}=require('../record-commands.cjs');
function fixture(){
  const identity=taskIdentity({id:'original',root:'D:/project',account:'A',documentGeneration:3},
    {thread_id:'thread-original',latest_request:{id:'request-original',phase:'processing'}},4);
  const state={app_instance_id:'original-instance',root:'D:/clw',runtime_generation:4,selected:'original',
    tasks:[{id:'original',identity}],native_tasks:[{trace_id:'trace-original',task_key:'thread-native',account:'A',turn_id:'turn-original'}]};
  return {state,expected:{app_instance_id:state.app_instance_id,root:state.root,runtime_generation:4,selected:'original',task:{...identity}}};
}
test('every original task identity field fences application control before any dispatch',()=>{
  const {state,expected}=fixture();assertControlIdentity('pause',{id:'original'},expected,state);
  for(const key of Object.keys(expected.task)){
    const changed={...expected,task:{...expected.task,[key]:'foreign'}};
    assert.throws(()=>assertControlIdentity('start',{id:'original'},changed,state),e=>e.code==='app_control_task_changed'&&e.accepted===false,key);
  }
  assert.throws(()=>assertControlIdentity('select',{id:'other'},expected,state),/task_changed/);
});
test('application, root and connection changes fence even global UI commands',()=>{
  const {state,expected}=fixture();
  for(const key of ['app_instance_id','root','runtime_generation'])
    assert.throws(()=>assertControlIdentity('theme',{}, {...expected,[key]:'foreign'},state),/owner_changed/);
  for(const action of ['reload-shell','capture-shell','inspect-ui','ui-view'])
    assert.throws(()=>assertControlIdentity(action,{}, {...expected,selected:'different'},state),/selection_changed/);
  assert.throws(()=>assertControlIdentity('evaluate-js',{},expected,state),/action_unavailable/);
});
test('connection reads and saves use the formal owner-pinned dispatcher',()=>{
  const {state,expected}=fixture();
  for(const action of ['connection-read','connection-save']){
    assert.equal(capabilities.includes(action),true);
    assertControlIdentity(action,{},expected,state);
    assert.throws(()=>assertControlIdentity(action,{}, {...expected,runtime_generation:5},state),/owner_changed/);
  }
  assert.throws(()=>assertControlIdentity('connection-read',{account:'B'},expected,state),/connection_request_invalid/);
  assert.equal(capabilities.includes('connection-pick-file'),false);
});
test('exit status is read-only and reconciliation pins the original exit context',()=>{
 const {state,expected}=fixture(),id='11111111-2222-4333-8444-555555555555';state.exit={exit_id:id};assertControlIdentity('exit-status',{},expected,state);assertControlIdentity('reconcile-exit',{exit_id:id},expected,state);
 assert.throws(()=>assertControlIdentity('reconcile-exit',{exit_id:'11111111-2222-4333-8444-555555555556'},expected,state),/context_changed/);
 assert.throws(()=>assertControlIdentity('exit-status',{extra:true},expected,state),/context_changed/);assert.throws(()=>assertControlIdentity('quit',{force:true},expected,state),/payload_invalid/);
});
test('task payload cannot override pinned request or connection; goal schema is preserved',()=>{
  const {state,expected}=fixture();
  for(const payload of [{id:'original',expected_connection_generation:5},{id:'original',expected_request_id:'foreign'}])
    assert.throws(()=>assertControlIdentity('start',payload,expected,state),/payload_identity_conflict/);
  assert.deepEqual(commandPayload('pause',{id:'original'},expected),{id:'original',expected_connection_generation:4,expected_request_id:'request-original'});
  assert.deepEqual(commandPayload('goal-save',{id:'original',expected_goal_request_id:'request-original'},expected),
    {id:'original',expected_goal_request_id:'request-original',expected_connection_generation:4});
});
test('native records and continuation require original trace, thread, turn and account',()=>{
  const {state,expected}=fixture();expected.native_task={...state.native_tasks[0]};
  assertControlIdentity('codex-view-turn',{traceId:'trace-original'},expected,state);
  for(const key of Object.keys(expected.native_task))
    assert.throws(()=>assertControlIdentity('codex-view-turn',{traceId:'trace-original'},
      {...expected,native_task:{...expected.native_task,[key]:'foreign'}},state),/native_task_changed/);
  assert.equal(new Set(capabilities).size,capabilities.length);
});
test('new task, login and Web Codex allocation require an explicit original Web account',()=>{
  const {state,expected}=fixture();
  for(const action of ['new','login','codex-start']){
    assertControlIdentity(action,{account:'A'},expected,state);
    assert.throws(()=>assertControlIdentity(action,{},expected,state),/account_required/);
    assert.throws(()=>assertControlIdentity(action,{account:'C'},expected,state),/account_required/);
  }
  assertControlIdentity('native-codex-start',{},expected,state);
  expected.native_task={...state.native_tasks[0]};
  assertControlIdentity('codex-resume-turn',{traceId:'trace-original'},expected,state);
  assert.throws(()=>assertControlIdentity('codex-resume-turn',{traceId:'trace-original'},
    {...expected,native_task:{...expected.native_task,turn_id:'later-turn'}},state),/native_task_changed/);
});

test('Native body reads bind the exact older trace within a multi-turn thread regardless of recent ordering',async()=>{
  const {state,expected}=fixture();
  const older={...state.native_tasks[0],thread_id:'thread-native',status:'completed',body_revision:'original-revision'};
  const newer={...older,trace_id:'trace-newer',turn_id:'turn-newer',body_revision:'newer-revision'};
  expected.native_task={...older};
  const payload={mode:'codex',task_key:'thread-native',traceId:'trace-original'};
  const bodies=new Map([
    ['trace-original',{traceId:'trace-original',source:{threadId:'thread-native',turnId:'turn-original'},body:'Older original reply'}],
    ['trace-newer',{traceId:'trace-newer',source:{threadId:'thread-native',turnId:'turn-newer'},body:'Newer reply'}],
  ]);
  for(const rows of [[newer,older],[older,newer]]){
    state.native_tasks=rows;
    assertControlIdentity('record-body',payload,expected,state);
    const result=await readRecords('record-body',payload,{nativeBridge:{turn:async trace=>bodies.get(trace)}});
    assert.equal(result.row.traceId,'trace-original');
    assert.equal(result.row.source.turnId,'turn-original');
    assert.equal(result.row.body,'Older original reply');
  }
  for(const changed of [
    {...payload,traceId:'trace-newer'}, {...payload,traceId:'missing-trace'},
    {...payload,task_key:'different-thread'}, {mode:'codex',task_key:payload.task_key},
  ]) assert.throws(()=>assertControlIdentity('record-body',changed,expected,state),/native_task_changed/);
  for(const key of Object.keys(older)){
    assert.throws(()=>assertControlIdentity('record-body',payload,
      {...expected,native_task:{...older,[key]:'changed'}},state),/native_task_changed/,key);
  }
});

test('Native history and index preserve the thread entry contract while body rows keep their own source revision',()=>{
  const {state,expected}=fixture();
  const older={...state.native_tasks[0],thread_id:'thread-native',status:'completed',body_revision:'original-revision'};
  const newer={...older,trace_id:'trace-newer',turn_id:'turn-newer',body_revision:'newer-revision'};
  state.native_tasks=[newer,older];expected.native_task={...newer};
  for(const action of ['record-history','record-index']){
    assertControlIdentity(action,{mode:'codex',task_key:'thread-native'},expected,state);
    assert.throws(()=>assertControlIdentity(action,{mode:'codex',task_key:'thread-native'},
      {...expected,native_task:{...older}},state),/native_task_changed/);
  }
  for(const action of ['codex-view-turn','codex-resume-turn']){
    assertControlIdentity(action,{traceId:'trace-original'},{...expected,native_task:{...older}},state);
    assert.throws(()=>assertControlIdentity(action,{traceId:'trace-original'},expected,state),/native_task_changed/);
  }
});

test('expanded allocation, window and task commands retain their existing identities and capabilities',()=>{
  const {state,expected}=fixture();
  for(const action of ['budget-continue','task-status']){
    assert.equal(capabilities.includes(action),true);
    assertControlIdentity(action,{id:'original'},expected,state);
    assert.throws(()=>assertControlIdentity(action,{id:'original'},
      {...expected,task:{...expected.task,request_id:'later-request'}},state),/task_changed/);
  }
  for(const action of ['new','login','codex-start','native-codex-start','window-size'])
    assert.equal(capabilities.includes(action),true);
  assertControlIdentity('window-size',{width:800,height:600},expected,state);
  assert.throws(()=>assertControlIdentity('window-size',{width:800,height:600},
    {...expected,app_instance_id:'other-instance'},state),/owner_changed/);
});


test('goal-stop is an original task action, never a generic application-wide stop',()=>{
 const {state,expected}=fixture();
 assert.ok(capabilities.includes('goal-stop'));
 assertControlIdentity('goal-stop',{id:'original'},expected,state);
 assert.throws(()=>assertControlIdentity('goal-stop',{id:'foreign'},expected,state),/task_changed/);
 assert.deepEqual(commandPayload('goal-stop',{id:'original',operation_id:'stop-original',expected_goal_request_id:'request-original'},expected),
  {id:'original',operation_id:'stop-original',expected_goal_request_id:'request-original',expected_connection_generation:expected.runtime_generation});
});

test('history usage is an explicit account-scoped read rather than a task send or Codex quota operation',()=>{
 const {state,expected}=fixture();assert.ok(capabilities.includes('quota-history'));
 for(const account of ['A','B'])assertControlIdentity('quota-history',{account},expected,state);
 for(const payload of [{},{account:'C'},{account:'A',url:'https://elsewhere.example'},{account:'B',token:'external'}])
  assert.throws(()=>assertControlIdentity('quota-history',payload,expected,state),/quota_history_payload_invalid/);
});

test('browser verification is account scoped and cannot receive a supplied address or credential',()=>{
 const {state,expected}=fixture();assert.ok(capabilities.includes('quota-verify'));
 for(const account of ['A','B'])assertControlIdentity('quota-verify',{account},expected,state);
 for(const payload of [{},{account:'C'},{account:'A',url:'https://chatgpt.com/'},{account:'B',token:'external'}])
  assert.throws(()=>assertControlIdentity('quota-verify',payload,expected,state),/quota_history_payload_invalid/);
 assert.throws(()=>assertControlIdentity('quota-verify',{account:'A'},{...expected,app_instance_id:'other'},state),/owner_changed/);
});
