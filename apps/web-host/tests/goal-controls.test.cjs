'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
const {TaskSubmission}=require('../task-submission.cjs');
const {captureTaskIdentity}=require('../task-action-identity.cjs');
const KEY='12345678-1234-4234-8234-123456789abc',OTHER='22345678-1234-4234-8234-123456789abc';
function fixture({prepared=false,configured=true,manual=true}={}){
 const calls=[],pages=new Map(['A','B'].map(id=>[id,{id,account:'A',view:{webContents:{}}}]));
 const runtime=new EventEmitter();runtime.ready=true;
 const workspace={pendingStarts:{},save(){},tasks:new Map()};
 const driver=new WebDriver({runtime,pool:{pages},onNotice(){},dom:async()=>assert.fail('goal control must not inspect the browser')});
 driver.records=new Map(['A','B'].map(id=>[id,{page_id:id,thread_id:'thread-'+id,account:'A',latest_request:{id:'request-'+id,phase:'completed'}}]));
 driver.recordsLoaded=true;driver.reconcileAll=async()=>{calls.push(['reconcile']);};
 const next={state:'goal_next_prepared',operation_id:KEY,objective:'Full immutable next goal\nOriginal result path and SHA256\nOriginal feedback',source_request_id:'request-A',expected_run_id:'run-A',model_sends:0};
 const goal={configured,objective:'Persistent game objective',mode:manual?'manual':'automatic',state:'paused',etag:'current-etag',revision:1,
  request_id:'request-A',identity_valid:true,next:prepared?next:null};
 const hooks={};let generation=1;
 runtime.call=async(op,p)=>{
  calls.push([op,structuredClone(p)]);
  if(hooks[op])return hooks[op](p);
  if(op==='goal-read')return {goal:structuredClone(goal),model_sends:0};
  if(op==='goal-next'){goal.next={...next,operation_id:p.operation_id};return {...goal.next};}
  if(op==='goal-save'||op==='goal-review')return {state:op==='goal-save'?'goal_saved':'goal_review_saved',goal:structuredClone(goal),model_sends:0};
  if(op==='goal-discard'){goal.next=null;return {state:'goal_next_discarded',original_operation_id:p.expected_pending_id,goal:structuredClone(goal),model_sends:0};}
  if(op==='pause')return {paused:p.paused};
  if(op==='budget-continuation')return {objective:'Original budget continuation'};
  if(op==='start'){driver.records.get(p.page_id).latest_request={id:p.operation_id,phase:'queued'};return {state:'queued_for_web_host',request_id:p.operation_id};}
  if(op==='receipt'){driver.records.get('A').latest_request={id:p.operation_id,phase:'queued'};return {state:'completed',result:{state:'queued_for_web_host',request_id:p.operation_id}};}
  assert.fail('unexpected operation '+op);
 };
 const submissions=new TaskSubmission(runtime,workspace);
 const pageById=(id='B')=>{if(!pages.has(id))throw Error('missing');return pages.get(id);};
 const capture=payload=>captureTaskIdentity({payload,resolvePage:pageById,recordFor:id=>driver.records.get(id),connectionGeneration:()=>generation});
 const payload={id:'A',operation_id:KEY,expected_etag:'current-etag',expected_goal_request_id:'request-A',expected_run_id:'run-A',instructions:'New guidance'};
 return {calls,pages,runtime,workspace,driver,goal,next,hooks,submissions,pageById,capture,payload,reconnect:()=>generation++,generation:()=>generation};
}
function mainCommand(f,{maintenanceChecking=false}={}){
 const source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
 const start=source.indexOf('  const dispatchCommand=async');
 const end=source.indexOf('  shellControl=new ShellControl',start);
 assert.ok(start>=0&&end>start);
 let handle;
 const sandbox={ipcMain:{handle:(_name,fn)=>{handle=fn;}},ownShell(){},recordCommands:{actions:new Set()},maintenanceChecking,isolatedCheck:false,checkActions:[],
  driver:f.driver,runtime:f.runtime,workspace:f.workspace,submissions:f.submissions,pageById:f.pageById,
  captureTaskIdentity,runtimeGeneration:f.generation(),pool:{ensure:async()=>assert.fail('metadata must not hydrate a page')},publish(){}};
 vm.runInNewContext(source.slice(start,end),sandbox,{filename:'main-goal-command.cjs'});
 return (action,payload)=>handle({}, {action,payload});
}
test('actual IPC goal save/review/read forward the frozen page with zero Send, pause or browser hydration',async()=>{
 const f=fixture(),command=mainCommand(f);
 for(const op of ['goal-read','goal-save','goal-review']){
  const result=await command(op,{id:'A',operation_id:KEY,expected_connection_generation:1,objective:'Saved human goal'});
  assert.equal(result.model_sends,0);assert.equal(result.goal.request_id,'request-A');
 }
 const forwarded=f.calls.filter(([op])=>op.startsWith('goal-'));
 assert.deepEqual(forwarded.map(([,p])=>p.page_id),['A','A','A']);
 for(const [,p]of forwarded){assert.equal(p.id,undefined);assert.equal(p.expected_connection_generation,undefined);}
 assert.equal(f.calls.filter(([op])=>['start','pause','receipt'].includes(op)).length,0);
 assert.deepEqual(f.workspace.pendingStarts,{});
});
test('actual IPC rejects absent or invalid goal/budget owner instead of selected-page fallback',async()=>{
 const f=fixture(),command=mainCommand(f);
 for(const op of ['goal-read','goal-save','goal-review','goal-discard','goal-continue','refill-budget','budget-continue'])
  for(const id of [undefined,'missing'])await assert.rejects(command(op,{id}),/managed_task_identity_required/);
 assert.equal(f.calls.length,0);
});
test('an in-progress maintenance check rejects goal and budget operations without mutating the original task',async()=>{
 const f=fixture(),command=mainCommand(f,{maintenanceChecking:true});
 for(const action of ['goal-read','goal-save','goal-review','goal-discard','goal-continue','refill-budget','budget-continue'])
  await assert.rejects(command(action,f.payload),/正在核对原执行/);
 assert.equal(f.calls.length,0);assert.deepEqual(f.workspace.pendingStarts,{});
 assert.equal(f.driver.records.get('A').latest_request.id,'request-A');assert.equal(f.goal.request_id,'request-A');
});
test('late metadata reply after reconnect never reconciles or resumes another task',async()=>{
 const f=fixture(),action=f.capture(f.payload);
 f.hooks['goal-save']=async()=>{f.reconnect();return {goal:f.goal,model_sends:0};};
 await assert.rejects(f.driver.goalOperation(action.page,'goal-save',f.payload,action.assertCurrent),/managed_task_response_stale/);
 assert.deepEqual(f.calls.map(([op])=>op),['goal-save']);assert.deepEqual(f.workspace.pendingStarts,{});
});
test('fresh preparation sends exactly the original prepared key/body, and accepts only its acknowledged request transition',async()=>{
 const f=fixture(),command=mainCommand(f),result=await command('goal-continue',f.payload);
 assert.equal(result.state,'queued_for_web_host');assert.equal(result.request_id,KEY);
 assert.deepEqual(f.calls.filter(([op])=>op!=='reconcile').map(([op])=>op),['goal-read','goal-next','pause','start']);
 const send=f.calls.find(([op])=>op==='start')[1];assert.equal(send.operation_id,KEY);assert.equal(send.objective,f.next.objective);
 assert.equal(send.page_id,'A');assert.equal(f.calls.find(([op])=>op==='pause')[1].expected_request_id,null);
 assert.deepEqual(f.workspace.pendingStarts,{});
});
test('prepared intent survives loss of renderer storage; changed key/guidance cannot replace its canonical body',async()=>{
 const f=fixture({prepared:true}),action=f.capture(f.payload);
 const result=await f.driver.continueGoal(action.page,{...f.payload,operation_id:OTHER,instructions:''},{workspace:f.workspace,submissions:f.submissions,assertCurrent:action.assertCurrent});
 assert.equal(result.request_id,KEY);assert.equal(f.calls.filter(([op])=>op==='goal-next').length,0);
 const send=f.calls.find(([op])=>op==='start')[1];assert.equal(send.objective,f.next.objective);assert.equal(send.operation_id,KEY);
});
test('unknown Send preserves durable original key; retry checks only that receipt and never prepares/resumes/sends again',async()=>{
 const f=fixture({prepared:true}),action=f.capture(f.payload);
 f.hooks.start=async()=>{throw Error('runtime_receipt_unknown_reconcile_original');};
 await assert.rejects(f.driver.continueGoal(action.page,f.payload,{workspace:f.workspace,submissions:f.submissions,assertCurrent:action.assertCurrent}),/runtime_receipt_unknown/);
 assert.equal(f.workspace.pendingStarts.A.operation_id,KEY);const before=f.calls.length;delete f.hooks.start;
 const retried=f.capture(f.payload),result=await f.driver.continueGoal(retried.page,{...f.payload,operation_id:OTHER},{workspace:f.workspace,submissions:f.submissions,assertCurrent:retried.assertCurrent});
 assert.equal(result.request_id,KEY);assert.deepEqual(f.calls.slice(before).map(([op])=>op),['receipt']);
});
test('legacy accepted-but-unknown intent retains its original non-UUID key during goal receipt recovery',async()=>{
 const f=fixture();f.workspace.pendingStarts.A={operation_id:'original-legacy-key',objective:'Original accepted body'};
 const action=f.capture(f.payload),result=await f.driver.continueGoal(action.page,f.payload,{workspace:f.workspace,submissions:f.submissions,assertCurrent:action.assertCurrent});
 assert.equal(result.request_id,'original-legacy-key');assert.deepEqual(f.calls.map(([op])=>op),['receipt']);
});
test('stale prepared source, run, identity or malformed body fails before pause or Send',async()=>{
 for(const change of [f=>f.goal.next.source_request_id='foreign-request',f=>f.goal.next.expected_run_id='foreign-run',
  f=>f.goal.next.operation_id='invalid',f=>f.goal.next.objective='x'.repeat(24001),f=>f.goal.next.objective='contains\0NUL',
  f=>f.goal.next.state='queued_for_web_host',f=>f.goal.identity_valid=false]){
  const f=fixture({prepared:true});change(f);const action=f.capture(f.payload);
  await assert.rejects(f.driver.continueGoal(action.page,f.payload,{workspace:f.workspace,submissions:f.submissions,assertCurrent:action.assertCurrent}),/managed_goal_/);
  assert.deepEqual(f.calls.map(([op])=>op),['goal-read']);assert.deepEqual(f.workspace.pendingStarts,{});
 }
});
test('reconnect after preparing preserves server intent and fences local resume/Send',async()=>{
 const f=fixture(),action=f.capture(f.payload);
 f.driver.reconcileAll=async()=>{f.reconnect();};
 await assert.rejects(f.driver.continueGoal(action.page,f.payload,{workspace:f.workspace,submissions:f.submissions,assertCurrent:action.assertCurrent}),/managed_task_response_stale/);
 assert.equal(f.goal.next.operation_id,KEY);assert.deepEqual(f.calls.map(([op])=>op),['goal-read','goal-next']);
});
test('manual goal cannot use legacy budget continuation to bypass human review',async()=>{
 const f=fixture(),command=mainCommand(f);
 await assert.rejects(command('budget-continue',f.payload),/managed_goal_use_continue/);
 assert.deepEqual(f.calls.map(([op])=>op),['goal-read']);assert.deepEqual(f.workspace.pendingStarts,{});
});
test('definitively rejected goal Send returns its original receipt and leaves its server grant for explicit discard',async()=>{
 const f=fixture({prepared:true}),command=mainCommand(f);
 f.hooks.start=async()=>({state:'rejected',code:'workspace_busy_or_unreconciled',unknown:false});
 const result=await command('goal-continue',f.payload);
 assert.equal(result.state,'rejected');assert.equal(result.code,'workspace_busy_or_unreconciled');assert.equal(result.unknown,false);
 assert.equal(f.goal.next.operation_id,KEY);assert.equal(f.workspace.pendingStarts.A,undefined);
 assert.equal(f.calls.filter(([op])=>op==='start').length,1);assert.equal(f.calls.filter(([op])=>op==='goal-discard').length,0);
});
test('unconfigured legacy budget continuation remains explicit and preserves acknowledged task ownership',async()=>{
 const f=fixture({configured:false}),command=mainCommand(f),result=await command('budget-continue',f.payload);
 assert.equal(result.state,'queued_for_web_host');
 assert.deepEqual(f.calls.filter(([op])=>op!=='reconcile').map(([op])=>op),['goal-read','budget-continuation','pause','start']);
 assert.equal(f.calls.find(([op])=>op==='start')[1].objective,'Original budget continuation\n\n本次用户要求：\nNew guidance');
});
test('authoritative discard acknowledgment cleans only the matching original local intent and sends no model',async()=>{
 for(const key of [KEY,OTHER]){
  const f=fixture({prepared:true});f.workspace.pendingStarts.A={operation_id:key,objective:'Retained local body'};
  const command=mainCommand(f),result=await command('goal-discard',{...f.payload,expected_pending_id:KEY});
  assert.equal(result.state,'goal_next_discarded');assert.equal(result.model_sends,0);
  assert.equal(f.workspace.pendingStarts.A?.operation_id,key===KEY?undefined:OTHER);
  assert.deepEqual(f.calls.filter(([op])=>op!=='reconcile').map(([op])=>op),['goal-discard']);
 }
});
test('invalid nonzero model-send metadata is rejected without a follow-up mutation',async()=>{
 const f=fixture(),action=f.capture(f.payload);f.hooks['goal-save']=async()=>({goal:f.goal,model_sends:1});
 await assert.rejects(f.driver.goalOperation(action.page,'goal-save',f.payload,action.assertCurrent),/managed_goal_response_invalid/);
 assert.deepEqual(f.calls.map(([op])=>op),['goal-save']);
});


test('actual main goal-stop routes the original CAS without Send, webpage stop or pending-send disposal',async()=>{
 const f=fixture({prepared:true}),command=mainCommand(f);f.workspace.pendingStarts.A={operation_id:OTHER,objective:'Original unknown send'};
 f.hooks['goal-stop']=async p=>({state:'goal_stopped',goal:{...f.goal,state:'stopped',display_state:'stopped'},future_paused:true,model_sends:0});
 const payload={id:'A',operation_id:KEY,expected_etag:'current-etag',expected_goal_request_id:'request-A'};
 const r=await command('goal-stop',payload);
 assert.equal(r.state,'goal_stopped');assert.equal(r.model_sends,0);
 assert.deepEqual(f.calls.filter(row=>row[0]!=='reconcile'),[['goal-stop',{page_id:'A',operation_id:KEY,expected_etag:'current-etag',expected_goal_request_id:'request-A'}]]);
 assert.equal(f.workspace.pendingStarts.A.operation_id,OTHER);
 assert.equal(f.driver.records.get('A').latest_request.id,'request-A');
});
