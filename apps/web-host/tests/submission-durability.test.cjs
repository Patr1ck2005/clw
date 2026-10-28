'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {TaskSubmission}=require('../task-submission.cjs');
const {captureTaskIdentity}=require('../task-action-identity.cjs');

test('formal application start keeps its durable execution reference through accepted cleanup failure',async()=>{
 const {startExistingTask}=require('../task-submission.cjs');
 const original='93d93b4e-a3e9-867b-9c26-08e0f25b10b3',calls=[];let saves=0;
 const workspace={pendingStarts:{},save(){if(++saves===2)throw Error('cleanup disk full');}};
 const submission=new TaskSubmission({call:async(action,payload)=>{
  calls.push({action,payload});
  if(action==='start')return {state:'queued_for_web_host',request_id:original};
  return {operation_id:original,state:'completed',result:{state:'queued_for_web_host',request_id:original}};
 }},workspace);
 const dependencies={pageById:id=>({id}),driver:{records:new Map()},submissions:submission};
 const payload={id:'original-page',objective:'Original work package'},options={operation_id:original};
 await assert.rejects(startExistingTask(dependencies,payload,options),/cleanup disk full/);
 assert.equal(workspace.pendingStarts['original-page'].operation_id,original);
 await startExistingTask(dependencies,payload,options);
 assert.deepEqual(calls.map(row=>row.action),['start','receipt']);
 assert.equal(calls[0].payload.operation_id,original);assert.equal(calls[1].payload.operation_id,original);
 assert.deepEqual(workspace.pendingStarts,{});
});

test('failure to persist an unsent intent leaves the original input usable',async()=>{
 let fail=true,sends=0;
 const workspace={pendingStarts:{},save(){if(fail)throw Error('disk full');}};
 const submission=new TaskSubmission({call:async(op)=>{
  assert.equal(op,'start');sends++;return {state:'queued_for_web_host',request_id:'accepted'};
 }},workspace);
 await assert.rejects(submission.start('page','goal'),/disk full/);
 assert.deepEqual(workspace.pendingStarts,{});assert.equal(sends,0);
 fail=false;await submission.start('page','goal');assert.equal(sends,1);
});

test('a disconnected pre-write call is not an unknown sent request',async()=>{
 let connected=false;const calls=[];
 const workspace={pendingStarts:{},save(){}};
 const submission=new TaskSubmission({call:async(op)=>{
  calls.push(op);if(!connected)throw Error('runtime_not_connected');
  return {state:'queued_for_web_host',request_id:'accepted'};
 }},workspace);
 await assert.rejects(submission.start('page','goal'),/runtime_not_connected/);
 assert.deepEqual(workspace.pendingStarts,{});
 connected=true;await submission.start('page','goal');assert.deepEqual(calls,['start','start']);
});

test('an accepted submission whose cleanup fails only queries its original receipt',async()=>{
 let saves=0,sentId;const calls=[];
 const workspace={pendingStarts:{},save(){if(++saves===2)throw Error('disk full');}};
 const runtime={call:async(op,args)=>{
  calls.push(op);
  if(op==='start'){sentId=args.operation_id;return {state:'queued_for_web_host',request_id:sentId};}
  assert.equal(args.operation_id,sentId);
  return {state:'completed',result:{state:'queued_for_web_host',request_id:sentId}};
 }};
 const submission=new TaskSubmission(runtime,workspace);
 await assert.rejects(submission.start('page','goal'),/disk full/);
 assert.equal(workspace.pendingStarts.page.operation_id,sentId);
 await submission.start('page','goal');assert.deepEqual(calls,['start','receipt']);
});

test('a prepared goal operation keeps its original key across an unknown submission and only reconciles its receipt',async()=>{
 const operation='12345678-1234-4234-8234-123456789abc',calls=[];
 const workspace={pendingStarts:{},save(){}},runtime={call:async(op,args)=>{
  calls.push([op,args]);assert.equal(args.operation_id,operation);
  if(op==='start')throw Error('runtime_receipt_unknown_reconcile_original');
  return {state:'completed',result:{state:'queued_for_web_host',request_id:operation}};
 }};
 const submission=new TaskSubmission(runtime,workspace);
 await assert.rejects(submission.start('page','prepared exact objective',null,{operation_id:operation}),/runtime_receipt_unknown/);
 assert.equal(workspace.pendingStarts.page.operation_id,operation);
 const result=await submission.start('page','prepared exact objective',null,{operation_id:operation});
 assert.equal(result.request_id,operation);assert.deepEqual(calls.map(([op])=>op),['start','receipt']);
});

test('invalid or competing goal operation keys cannot replace an original pending intent or issue work',async()=>{
 const operation='12345678-1234-4234-8234-123456789abc',original={operation_id:operation,objective:'original objective'};
 const workspace={pendingStarts:{page:original},save(){assert.fail('no replacement may be persisted');}};
 const submission=new TaskSubmission({call:async()=>assert.fail('no work or foreign receipt read')},workspace);
 for(const operation_id of [null,undefined,'',42,'not-a-uuid'])
  await assert.rejects(submission.start('page','original objective',null,{operation_id}),/managed_goal_operation_invalid/);
 await assert.rejects(submission.start('page','original objective',null,{operation_id:'12345678-1234-4234-8234-123456789abd'}),/managed_goal_original_operation_required/);
 assert.equal(workspace.pendingStarts.page,original);
});

const operation='12345678-1234-4234-8234-123456789abc',objective='原始目标\n原始 Markdown 与空格。';
function fixture(){
  const original={operation_id:operation,objective,expected_request_id:'request-original'},calls=[],saved=[];
  const workspace={pendingStarts:{page:original},save(){saved.push(JSON.stringify(this.pendingStarts));}};
  let result={state:'note_saved_not_native_interrupt',request_id:'request-original',operation_id:operation},respond;
  const runtime={call:async(op,args)=>{calls.push([op,args]);assert.equal(op,'receipt');return respond?respond(op,args):{operation_id:operation,state:'completed',result};}};
  const submission=new TaskSubmission(runtime,workspace);
  return {original,calls,saved,workspace,runtime,submission,setResult:value=>{result=value;},respond:value=>{respond=value;},result:()=>result};
}

test('read-only reconciliation queries the exact durable original and preserves the accepted receipt unchanged',async()=>{
  const f=fixture(),checks=[];const result=await f.submission.reconcile('page',objective,options=>checks.push(options));
  assert.equal(result,f.result());assert.deepEqual(f.calls,[['receipt',{operation_id:operation}]]);assert.deepEqual(f.workspace.pendingStarts,{});
  assert.deepEqual(checks,[undefined,{response:true,acceptedRequestId:'request-original'}]);assert.equal(f.saved.length,1);
});

test('a stale reconciliation whose intent is already absent never creates or submits a new operation',async()=>{
  const f=fixture();delete f.workspace.pendingStarts.page;
  assert.deepEqual(await f.submission.reconcile('page',objective),{state:'rejected',code:'managed_submission_original_intent_missing',model_sends:0});
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.saved,[]);assert.deepEqual(f.workspace.pendingStarts,{});
});

test('changed UI text or malformed persisted intent cannot query a different operation or replace the original',async()=>{
  const f=fixture();for(const value of ['',objective+' edited','新草稿'])await assert.rejects(f.submission.reconcile('page',value),/managed_submission_original_objective_required/);
  for(const value of [null,undefined,42,{}])await assert.rejects(f.submission.reconcile('page',value),/managed_submission_reconcile_invalid/);
  for(const original of [{operation_id:null,objective},{operation_id:'',objective},{operation_id:operation,objective:42}]){
    f.workspace.pendingStarts.page=original;await assert.rejects(f.submission.reconcile('page',objective),/managed_submission_original_intent_invalid/);
    assert.equal(f.workspace.pendingStarts.page,original);
  }
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.saved,[]);
});

test('unknown, pending, missing and foreign operation receipts retain the exact original intent',async()=>{
  for(const receipt of [{operation_id:operation,state:'reserved',result:null},{operation_id:operation,state:'unknown',result:null},
    {operation_id:operation,state:'completed',result:null},{operation_id:'foreign',state:'completed',result:{state:'queued_for_web_host'}},
    {state:'completed',result:{state:'queued_for_web_host'}},null]){
    const f=fixture();f.respond(async()=>receipt);await assert.rejects(f.submission.reconcile('page',objective),/尚未确认|managed_submission_receipt_identity_invalid/);
    assert.equal(f.workspace.pendingStarts.page,f.original);assert.deepEqual(f.saved,[]);assert.equal(f.submission.busy.size,0);assert.equal(f.calls.length,1);
  }
});

test('a definitively rejected original receipt remains authoritative and only clears that original local intent',async()=>{
  const f=fixture(),receipt={state:'rejected',code:'workspace_has_unresolved_send'};f.setResult(receipt);
  const error=await f.submission.reconcile('page',objective).then(()=>assert.fail('accepted rejection'),error=>error);
  assert.equal(error.submissionReceipt,receipt);assert.deepEqual(f.workspace.pendingStarts,{});assert.equal(f.calls.length,1);
});

test('a read failure and a cleanup failure both keep the original for a later receipt-only reconciliation',async()=>{
  const f=fixture();f.respond(async()=>{throw Error('runtime_disconnected_reconcile_original');});
  await assert.rejects(f.submission.reconcile('page',objective),/runtime_disconnected/);assert.equal(f.workspace.pendingStarts.page,f.original);
  f.respond(null);let fail=true;f.workspace.save=()=>{if(fail)throw Error('disk full');};
  await assert.rejects(f.submission.reconcile('page',objective),/disk full/);assert.equal(f.workspace.pendingStarts.page,f.original);
  fail=false;await f.submission.reconcile('page',objective);assert.deepEqual(f.calls.map(([op])=>op),['receipt','receipt','receipt']);assert.deepEqual(f.workspace.pendingStarts,{});
});

test('legacy durable operation keys are queried as saved rather than regenerated',async()=>{
  const f=fixture();f.original.operation_id='original-legacy-key';f.respond(async(_op,args)=>({operation_id:args.operation_id,state:'completed',result:{...f.result(),operation_id:args.operation_id}}));
  await f.submission.reconcile('page',objective);assert.deepEqual(f.calls,[['receipt',{operation_id:'original-legacy-key'}]]);
});

test('a late accepted or rejected receipt cannot clear a replaced, changed or removed intent',async()=>{
  for(const result of [{state:'note_saved_not_native_interrupt',request_id:'request-original'},{state:'rejected',code:'workspace_has_unresolved_send'}]){
    for(const change of [f=>{f.workspace.pendingStarts.page={operation_id:'new-operation',objective:'new intent'};},
      f=>{f.original.objective='new same-row text';},f=>{f.original.operation_id='new-same-row-operation';},
      f=>{f.original.expected_request_id='next-request';},f=>{delete f.workspace.pendingStarts.page;}]){
      const f=fixture();let finish;f.respond(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.submission.reconcile('page',objective);
      change(f);const expected=f.workspace.pendingStarts.page;finish({operation_id:operation,state:'completed',result});
      await assert.rejects(pending,/managed_submission_original_intent_changed/);assert.equal(f.workspace.pendingStarts.page,expected);assert.deepEqual(f.saved,[]);assert.equal(f.calls.length,1);
    }
  }
});

test('a second receipt reconciliation cannot race the same page while the first one is waiting',async()=>{
  const f=fixture();let finish;f.respond(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.submission.reconcile('page',objective);
  await assert.rejects(f.submission.reconcile('page',objective),/正在确认/);assert.equal(f.calls.length,1);
  finish({operation_id:operation,state:'completed',result:f.result()});await pending;assert.equal(f.submission.busy.size,0);
});

test('fresh start responses and definitive pre-write errors cannot clear a later durable intent',async()=>{
  for(const outcome of ['accepted','rejected','disconnected']){
    const f=fixture();delete f.workspace.pendingStarts.page;let finish;
    f.runtime.call=async(op)=>{assert.equal(op,'start');return new Promise((resolve,reject)=>{finish=outcome==='disconnected'?()=>reject(Error('runtime_not_connected')):()=>resolve(outcome==='accepted'?{state:'queued_for_web_host'}:{state:'rejected',code:'managed_page_not_ready'});});};
    const pending=f.submission.start('page',objective),replacement={operation_id:'other-original',objective:'a different original'};
    f.workspace.pendingStarts.page=replacement;finish();await assert.rejects(pending,/managed_submission_original_intent_changed/);
    assert.equal(f.workspace.pendingStarts.page,replacement);assert.equal(f.saved.length,1);
  }
});

const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),start=main.indexOf('    const identityActions='),end=main.indexOf("    if(action==='prompt-preview')",start);
assert.ok(start>0&&end>start);const actionSource='(async function(action,payload){'+main.slice(start,end)+'})';
function route(){
  const f=fixture(),page={id:'page',kind:'task',account:'A'},pages=new Map([['page',page]]),row={page_id:'page',phase:'bound',thread_id:'original-thread',account:'A',latest_request:{id:'request-original',phase:'processing'}};
  const context={captureTaskIdentity,runtimeGeneration:7,pageById:id=>pages.get(id),driver:{records:new Map([['page',row]]),recordsLoaded:true},
    runtime:f.runtime,submissions:f.submission,workspaceRestored:true,quitting:false,maintenanceChecking:false,publish(){context.publications++;},publications:0,
    pool:{selected:'page',ensure:()=>assert.fail('reconciliation hydrated a browser')},contextPicker:{pickContext:()=>assert.fail('unrelated file picker called')}};
  f.runtime.ready=true;
  const payload={id:'page',objective,expected_connection_generation:7,expected_request_id:'request-original'};
  return {...f,page,pages,row,context,payload,run:vm.runInNewContext(actionSource,context)};
}

test('the real reconciliation IPC preserves its original owner while sidebar selection changes and never touches the browser',async()=>{
  const f=route();f.context.pool.selected='other-page';const result=await f.run('reconcile-submission',f.payload);
  assert.equal(result,f.result());assert.deepEqual(f.calls,[['receipt',{operation_id:operation}]]);assert.equal(f.context.publications,1);assert.deepEqual(f.workspace.pendingStarts,{});
});

test('the real reconciliation IPC requires explicit connection and current-request CAS without querying or sending',async()=>{
  for(const change of [p=>delete p.expected_connection_generation,p=>p.expected_connection_generation=6,p=>p.expected_connection_generation='7',
    p=>delete p.expected_request_id,p=>p.expected_request_id='foreign',p=>p.expected_request_id=undefined,p=>p.objective=42,p=>p.operation_id='foreign',p=>p.id='absent']){
    const f=route();change(f.payload);await assert.rejects(f.run('reconcile-submission',f.payload),/managed_submission_reconcile_invalid|managed_task_identity|managed_resume_request_changed/);
    assert.deepEqual(f.calls,[]);assert.equal(f.workspace.pendingStarts.page,f.original);assert.deepEqual(f.saved,[]);
  }
});

test('the real IPC returns local missing-intent rejection with zero runtime calls even after an earlier result cleared it',async()=>{
  const f=route();delete f.workspace.pendingStarts.page;
  assert.deepEqual(await f.run('reconcile-submission',f.payload),{state:'rejected',code:'managed_submission_original_intent_missing',model_sends:0});assert.deepEqual(f.calls,[]);assert.deepEqual(f.saved,[]);
});

test('an unavailable, hidden or unsupported task never queries a receipt',async()=>{
  for(const change of [f=>f.context.runtime.ready=false,f=>f.context.driver.recordsLoaded=false,f=>f.context.workspaceRestored=false,f=>f.context.quitting=true,
    f=>f.context.maintenanceChecking=true,f=>f.page.kind='account',f=>f.page.hidden=true,f=>f.row.phase='reserved',f=>f.row.page_id='foreign']){
    const f=route();change(f);await assert.rejects(f.run('reconcile-submission',f.payload),/managed_submission_task_unavailable/);assert.deepEqual(f.calls,[]);assert.equal(f.workspace.pendingStarts.page,f.original);
  }
});

test('connection, task, request and owner changes during real receipt reads cannot consume an old acceptance or clear its intent',async()=>{
  for(const change of [f=>f.context.runtimeGeneration++,f=>f.context.runtime.ready=false,f=>f.context.runtime={ready:true},f=>f.context.driver={...f.context.driver},
    f=>f.context.submissions={...f.submission},f=>f.context.driver.recordsLoaded=false,f=>f.context.workspaceRestored=false,f=>f.context.quitting=true,
    f=>f.context.maintenanceChecking=true,f=>f.row.latest_request.id='unacknowledged-next',f=>f.row.thread_id='new-thread',f=>f.row.account='B',
    f=>f.pages.set('page',{...f.page}),f=>f.page.closed=true,f=>f.page.hidden=true]){
    const f=route();let finish;f.respond(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.run('reconcile-submission',f.payload);
    change(f);finish({operation_id:operation,state:'completed',result:f.result()});
    await assert.rejects(pending,/managed_submission_task_unavailable|managed_task_response_stale/);assert.equal(f.workspace.pendingStarts.page,f.original);assert.deepEqual(f.saved,[]);assert.equal(f.calls.length,1);assert.equal(f.context.publications,0);
  }
});

test('only the receipt-acknowledged next request may advance while the original accepted submission is reconciled',async()=>{
  const f=route();f.original.expected_request_id=null;f.row.latest_request.phase='completed';f.payload.expected_request_id=null;
  f.setResult({state:'queued_for_web_host',request_id:operation,operation_id:operation});
  f.respond(async()=>{f.row.latest_request={id:operation,phase:'queued'};return {operation_id:operation,state:'completed',result:f.result()};});
  const result=await f.run('reconcile-submission',f.payload);assert.equal(result,f.result());assert.deepEqual(f.workspace.pendingStarts,{});assert.equal(f.calls.length,1);assert.equal(f.context.publications,1);
});

test('malformed or foreign accepted business identities never clear an original pending intent or permit record advancement',async()=>{
  for(const append of [true,false])for(const mutate of [r=>delete r.request_id,r=>r.request_id='foreign',r=>r.request_id=null,
    r=>r.operation_id='foreign-operation',r=>r.operation_id=null,r=>r.state=append?'queued_for_web_host':'note_saved_not_native_interrupt']){
    const f=fixture();if(!append)delete f.original.expected_request_id;
    const result={state:append?'note_saved_not_native_interrupt':'queued_for_web_host',request_id:append?'request-original':operation,operation_id:operation};mutate(result);f.setResult(result);
    let responseChecks=0;await assert.rejects(f.submission.reconcile('page',objective,options=>{if(options?.response)responseChecks++;}),/managed_submission_receipt_identity_invalid/);
    assert.equal(responseChecks,0);assert.equal(f.workspace.pendingStarts.page,f.original);assert.deepEqual(f.saved,[]);assert.equal(f.calls.length,1);
  }
  const f=fixture();f.respond(async()=>({operation_id:operation,state:'unknown',result:f.result()}));
  await assert.rejects(f.submission.reconcile('page',objective),/managed_submission_receipt_identity_invalid/);assert.equal(f.workspace.pendingStarts.page,f.original);
});
