'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {WebDriver}=require('../web-driver.cjs'),identity=require('../app-control-identity.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const actualSource=fs.readFileSync(path.join(__dirname,'../page-dom.cjs'),'utf8');
function adapterFixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clw-adapter-test-')),file=path.join(dir,'page-dom.cjs');
  fs.writeFileSync(file,actualSource);
  for(const name of ['page-input.cjs','account-access.cjs'])
    fs.writeFileSync(path.join(dir,name),`module.exports=require(${JSON.stringify(path.join(__dirname,'..',name))});`);
  fs.copyFileSync(path.join(__dirname,'../public-approval.cjs'),path.join(dir,'public-approval.cjs'));
  const api=require(file),runDom=api.runDom,initial=api.adapterSnapshot(),cached=require.cache[file];
  t.after(()=>{delete require.cache[file];for(const name of ['page-input.cjs','account-access.cjs','public-approval.cjs'])delete require.cache[path.join(dir,name)];fs.rmSync(dir,{recursive:true,force:true});});
  const candidate=actualSource.replace('function dom(action,arg={},activate,accessLimited=()=>false,approval=()=>({required:false})) {',
    'function dom(action,arg={},activate,accessLimited=()=>false,approval=()=>({required:false})) {\n  // candidate-public-adapter');
  assert.notEqual(candidate,actualSource);
  const write=source=>{fs.writeFileSync(file,source);return sha(source);};
  const reload=(expectedSHA,options={})=>api.reloadDOMImplementation({expectedSHA,expectedAdapter:initial,...options});
  return {api,runDom,initial,cached,file,write,reload,candidate};
}
test('canonical adapter update adopts only dom and preserves the original cached coordinator',t=>{
  const f=adapterFixture(t),oldDOM=f.api.dom,target=f.write(f.candidate),result=f.reload(target);
  assert.equal(f.initial.revision,1);assert.equal(result.sha256,target);assert.equal(result.revision,2);
  assert.equal(result.coordinator_sha256,f.initial.sha256);assert.equal(result.scope,'serialized-public-dom');
  assert.equal(result.read_queues_preserved,true);assert.equal(result.run_dom_preserved,true);
  assert.notEqual(f.api.dom,oldDOM);assert.equal(f.api.runDom,f.runDom);
  assert.equal(require.cache[f.file],f.cached);assert.equal(require(f.file),f.api);
  assert.equal(f.cached.children.some(child=>child.filename===f.file),false);
});
test('source mismatch and stale loaded CAS execute no candidate source',t=>{
  const f=adapterFixture(t),key='clw_adapter_execution_'+crypto.randomUUID();
  t.after(()=>delete globalThis[key]);
  const target=f.write(f.candidate+`\nglobalThis[${JSON.stringify(key)}]=true;`);
  assert.throws(()=>f.reload('0'.repeat(64)),/source_sha_mismatch/);
  assert.throws(()=>f.reload(target,{expectedAdapter:{...f.initial,revision:0}}),/loaded_identity_changed/);
  assert.equal(globalThis[key],undefined);assert.equal(require.cache[f.file],f.cached);
  assert.deepEqual(f.api.adapterSnapshot(),f.initial);
});

test('a legacy cached approval reference changes only with committed DOM and keeps its original journal owner',t=>{
 const f=adapterFixture(t),approvalFile=path.join(path.dirname(f.file),'public-approval.cjs');
 const approval=require(approvalFile).publicApproval,original=approval.toString(),symbol=Symbol.for('clw.serialized-approval-adapter');
 const source=fs.readFileSync(approvalFile,'utf8').replace("function publicApproval(action='inspect',expected={}) {","function publicApproval(action='inspect',expected={}) {\n  // live-approval-candidate");
 fs.writeFileSync(approvalFile,source);
 let checks=0;const candidate=f.write(f.candidate);
 assert.throws(()=>f.reload(candidate,{assertCurrent(){if(++checks===2)throw Error('owner_changed');}}),/owner_changed/);
 assert.equal(approval.toString(),original);assert.equal(f.api.adapterSnapshot().revision,1);
 assert.equal(f.reload(candidate).revision,2);assert.match(approval.toString(),/live-approval-candidate/);
 assert.equal(require(approvalFile).publicApproval,approval);assert.equal(f.api.runDom,f.runDom);
 const controller=approval[symbol];
 const next=f.candidate+'\n// next compatible approval revision';
 const after=f.write(next);f.api.reloadDOMImplementation({expectedSHA:after,expectedAdapter:f.api.adapterSnapshot()});
 assert.equal(approval[symbol],controller);assert.match(approval.toString(),/live-approval-candidate/);
});
test('candidate load error restores original source function, metadata and require cache',t=>{
  const f=adapterFixture(t),oldDOM=f.api.dom,target=f.write(f.candidate+"\nthrow Error('candidate_load_failed');");
  assert.throws(()=>f.reload(target),/candidate_load_failed/);assert.equal(f.api.dom,oldDOM);
  assert.deepEqual(f.api.adapterSnapshot(),f.initial);assert.equal(require.cache[f.file],f.cached);
  const repaired=f.write(f.candidate);assert.equal(f.reload(repaired).revision,2);
});
test('candidate source change during load cannot adopt the freshly loaded function',t=>{
  const f=adapterFixture(t),oldDOM=f.api.dom;
  const source=f.candidate+`\nrequire('node:fs').writeFileSync(__filename,${JSON.stringify(actualSource)});`;
  assert.throws(()=>f.reload(f.write(source)),/source_changed_during_load/);
  assert.equal(f.api.dom,oldDOM);assert.deepEqual(f.api.adapterSnapshot(),f.initial);assert.equal(require.cache[f.file],f.cached);
});
test('last synchronous owner CAS failure rolls back candidate and never commits a revision',t=>{
  const f=adapterFixture(t),oldDOM=f.api.dom,target=f.write(f.candidate);let checks=0;
  assert.throws(()=>f.reload(target,{assertCurrent(){if(++checks===2)throw Error('original_owner_changed');}}),/original_owner_changed/);
  assert.equal(checks,2);assert.equal(f.api.dom,oldDOM);assert.equal(f.api.adapterSnapshot().revision,1);
  assert.equal(require.cache[f.file],f.cached);
});
test('adoption retains timed-out original native read slot until raw settlement',async t=>{
  const f=adapterFixture(t),calls=[],expressions=[];let finish;
  const held=new Promise(resolve=>{finish=resolve;});
  const wc={getURL:()=> 'https://chatgpt.com/c/original',debugger:{isAttached:()=>true,async sendCommand(method,params){
    calls.push(method);if(method==='Page.getFrameTree'){if(calls.length===1)await held;return {frameTree:{frame:{id:'frame'}}};}
    if(method==='Page.createIsolatedWorld')return {executionContextId:1};expressions.push(params.expression);return {result:{value:{editor:true}}};
  }}};
  await assert.rejects(f.runDom(wc,'snapshot',{}, {snapshotTimeoutMs:10}),/page_snapshot_timeout/);
  assert.equal(f.reload(f.write(f.candidate)).revision,2);
  const later=await Promise.allSettled(Array.from({length:12},()=>f.runDom(wc,'snapshot',{}, {snapshotTimeoutMs:10})));
  assert.ok(later.every(row=>row.status==='rejected'&&row.reason.message==='page_snapshot_timeout'));
  assert.deepEqual(calls,['Page.getFrameTree']);finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(expressions.length,1);assert.equal(expressions[0].includes('candidate-public-adapter'),false);
  assert.deepEqual(await f.runDom(wc,'snapshot',{}, {snapshotTimeoutMs:10}),{editor:true});
  assert.equal(calls.length,6);assert.equal(expressions[1].includes('candidate-public-adapter'),true);
});

function mainFixture(t){
  const adapter=adapterFixture(t),url='https://chatgpt.com/c/original',calls=[];
  const wc={getURL:()=>url,isDestroyed:()=>false,draft:'original draft',generating:true};
  const page={id:'original',account:'A',root:'D:/Games/Camp',url,documentGeneration:4,view:{webContents:wc}};
  const pool={selected:page.id,pages:new Map([[page.id,page]])};
  const runtime=new EventEmitter();Object.assign(runtime,{ready:true,store:'original-store',info:{instance_id:'original-host'},child:{pid:1234}});
  runtime.call=()=>assert.fail('adapter reload cannot call Host or replay business operations');
  const driver=new WebDriver({runtime,pool,dom:adapter.api.runDom});driver.recordsLoaded=true;
  const row={page_id:page.id,account:'A',root:page.root,url,phase:'bound',paused:false,thread_id:'original-thread',goal:{revision:8,state:'running'},
    latest_request:{id:'original-request',attempt_id:'original-attempt',phase:'processing',sent_user_hash:'a'.repeat(64)}};
  driver.records.set(page.id,row);driver.pending.set(page.id,{attempt:'original-attempt',assistantBefore:'original-assistant'});
  t.after(()=>driver.dispose());
  const quiesce=driver.quiesceObservation.bind(driver),resume=driver.resumeObservation.bind(driver);
  driver.quiesceObservation=async options=>{calls.push(['quiesce',options.timeoutMs]);return quiesce(options);};
  driver.resumeObservation=()=>{calls.push(['resume']);return resume();};
  const workspace={pendingStarts:{},draft:'saved user draft'},submissions={busy:new Set()};
  const sandbox={driver,runtime,pool,workspace,submissions,win:{webContents:{id:55}},nativeBridge:{host:{turnTabs:new Map()}},nativeConversations:{},
    nativePreviewPool:{selected:null,pages:new Map()},runtimeGeneration:2,quitting:false,maintenanceChecking:false,shellReloading:false,
    pageAdapterReloading:false,pageDOM:adapter.api,appControlIdentity:identity};
  const source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),start=source.indexOf('async function reloadPageAdapter('),end=source.indexOf('async function reloadShell(',start);
  assert.ok(start>=0&&end>start);vm.runInNewContext(source.slice(start,end),sandbox,{filename:'actual-main-page-adapter-reload.cjs'});
  const payload={expected_page_dom_sha256:adapter.write(adapter.candidate)};
  const command=assertOwner=>sandbox.reloadPageAdapter(payload,assertOwner);
  return {adapter,command,payload,sandbox,driver,row,page,wc,runtime,pool,workspace,calls};
}
function pausedOfferFixture(f){
  const url='https://chatgpt.com/c/paused-math',attemptId='paused-math-attempt';
  const wc={getURL:()=>url,isDestroyed:()=>false,generating:false,draft:''};
  const page={id:'paused-math',account:'A',root:'D:/Math',url,documentGeneration:3,view:{webContents:wc}};
  const row={page_id:page.id,account:'A',root:page.root,url,phase:'bound',paused:true,thread_id:'paused-math-thread',
    latest_request:{id:'paused-math-request',attempt_id:attemptId,phase:'suspended',sent_user_hash:null},
    attempt:{id:attemptId,state:'offered',dispatched:null,acknowledged:null}};
  f.pool.pages.set(page.id,page);f.driver.records.set(page.id,row);
  return {row,page,wc};
}
test('actual Host list passes through WebDriver.readRecords before reload with ACK Camp and a paused unsent offer',async t=>{
  const run=promisify(execFile),fixture=path.resolve(__dirname,'../../../tests/test_harness_managed_list_attempt.py');
  const reply=await run(process.env.CLW_PYTHON||'python',['-X','utf8','-B',fixture,'--emit-list-fixture'],
    {timeout:30000,windowsHide:true,maxBuffer:1024*1024});
  const host=JSON.parse(reply.stdout),f=mainFixture(t);let lists=0;
  f.pool.pages.clear();f.driver.records.clear();f.driver.pending.clear();
  for(const row of host.state.pages){
    const wc={getURL:()=>row.url,isDestroyed:()=>false,generating:row.page_id===host.camp,draft:''};
    f.pool.pages.set(row.page_id,{id:row.page_id,account:row.account,root:row.root,url:row.url,
      documentGeneration:4,view:{webContents:wc}});
  }
  f.pool.selected=host.camp;
  f.runtime.call=async op=>{assert.equal(op,'list');lists++;return host.state;};
  await f.driver.readRecords();assert.equal(lists,1);
  f.runtime.call=()=>assert.fail('adapter reload cannot invoke Host or replay accepted work');
  f.row=f.driver.records.get(host.camp);f.page=f.pool.pages.get(host.camp);f.wc=f.page.view.webContents;
  const math=f.driver.records.get(host.math);
  assert.equal(f.row.latest_request.id,host.camp_request);assert.equal(f.row.latest_request.attempt_id,host.camp_attempt);
  assert.equal(f.row.latest_request.sent_user_hash,'b'.repeat(64));assert.equal(f.row.attempt.state,'acknowledged');
  assert.equal(math.paused,true);assert.equal(math.latest_request.id,host.math_request);
  assert.equal(math.latest_request.phase,'suspended');assert.equal(math.latest_request.sent_user_hash,null);
  assert.deepEqual(math.attempt,{id:host.math_attempt,state:'offered',dispatched:null,acknowledged:null});
  f.driver.pending.set(host.camp,{attempt:host.camp_attempt,assistantBefore:'original-assistant'});
  const before=JSON.stringify([[...f.driver.records],[...f.driver.pending],f.workspace]);
  const result=await f.command();
  assert.equal(result.page_adapter.revision,2);assert.equal(result.model_sends,0);assert.equal(result.web_owners_preserved,true);
  assert.equal(JSON.stringify([[...f.driver.records],[...f.driver.pending],f.workspace]),before);
  assert.equal(f.pool.selected,host.camp);assert.equal(f.wc.generating,true);
  assert.equal(f.driver.observationQuiesced,false);assert.deepEqual(f.calls,[['quiesce',10000],['resume']]);
});
test('actual main adopts adapter without changing original Host, WC, request, goal, generation or draft',async t=>{
  const f=mainFixture(t),before=JSON.stringify([f.row,f.workspace,f.driver.pending.get(f.page.id)]),result=await f.command();
  assert.equal(result.page_adapter.revision,2);assert.equal(result.model_sends,0);assert.equal(result.web_generation_paused,false);
  assert.equal(result.runtime_pid,1234);assert.equal(result.web_owners_preserved,true);
  assert.equal(f.page.view.webContents,f.wc);assert.equal(f.sandbox.runtime,f.runtime);assert.equal(f.sandbox.pool,f.pool);
  assert.equal(f.sandbox.driver,f.driver);assert.equal(f.driver.dom,f.adapter.runDom);assert.equal(f.wc.generating,true);assert.equal(f.wc.draft,'original draft');
  assert.equal(JSON.stringify([f.row,f.workspace,f.driver.pending.get(f.page.id)]),before);
  assert.deepEqual(f.calls,[['quiesce',10000],['resume']]);assert.equal(f.driver.observationQuiesced,false);
  assert.equal(f.driver.pageAdapterReloading,undefined);assert.equal(f.sandbox.pageAdapterReloading,false);
});
test('actual main accepts a positively unsent paused offer while preserving the original ACK Camp receipt',async t=>{
  const f=mainFixture(t),math=pausedOfferFixture(f);
  const before=JSON.stringify([f.row,math.row,f.workspace,[...f.driver.pending]]),campPending=f.driver.pending.get(f.page.id);
  const result=await f.command();
  assert.equal(result.page_adapter.revision,2);assert.equal(result.model_sends,0);assert.equal(result.web_generation_paused,false);
  assert.equal(JSON.stringify([f.row,math.row,f.workspace,[...f.driver.pending]]),before);
  assert.equal(f.driver.pending.get(f.page.id),campPending);assert.equal(f.driver.pending.has(math.page.id),false);
  assert.equal(f.driver.records.get(math.page.id),math.row);assert.equal(math.page.view.webContents,math.wc);
  assert.equal(f.wc.generating,true);assert.equal(math.wc.generating,false);assert.equal(f.pool.selected,f.page.id);
  assert.deepEqual(f.calls,[['quiesce',10000],['resume']]);assert.equal(f.driver.observationQuiesced,false);
});
for(const [label,change]of [
  ['unpaused offer',m=>m.row.paused=false],['missing paused evidence',m=>delete m.row.paused],
  ['non-boolean paused evidence',m=>m.row.paused='true'],['missing attempt',m=>delete m.row.attempt],
  ['different attempt',m=>m.row.attempt.id='foreign'],['missing attempt identity',m=>delete m.row.attempt.id],
  ['dispatching attempt',m=>m.row.attempt.state='dispatching'],['unknown attempt',m=>m.row.attempt.state='unknown'],
  ['not-sent attempt',m=>m.row.attempt.state='not_sent'],['missing attempt state',m=>delete m.row.attempt.state],
  ['dispatched timestamp',m=>m.row.attempt.dispatched=123],['zero dispatched timestamp',m=>m.row.attempt.dispatched=0],
  ['undefined dispatched timestamp',m=>delete m.row.attempt.dispatched],['acknowledged timestamp',m=>m.row.attempt.acknowledged=456],
  ['zero acknowledged timestamp',m=>m.row.attempt.acknowledged=0],['undefined acknowledged timestamp',m=>delete m.row.attempt.acknowledged],
  ['undefined sent receipt',m=>delete m.row.latest_request.sent_user_hash],['malformed sent receipt',m=>m.row.latest_request.sent_user_hash='bad'],
  ['unresolved local pending offer',(m,f)=>f.driver.pending.set(m.page.id,{attempt:m.row.attempt.id})]
])test(`actual main updates observation while preserving paused offer ${label} without validating it for Send`,async t=>{
  const f=mainFixture(t),math=pausedOfferFixture(f);change(math,f);
  const before=JSON.stringify([f.row,math.row,f.workspace,[...f.driver.pending]]),pending=f.driver.pending.get(math.page.id);
  const result=await f.command();
  assert.equal(result.page_adapter.revision,2);assert.equal(result.model_sends,0);assert.equal(result.web_generation_paused,false);
  assert.equal(JSON.stringify([f.row,math.row,f.workspace,[...f.driver.pending]]),before);
  assert.equal(f.driver.pending.get(math.page.id),pending);assert.equal(f.driver.records.get(math.page.id),math.row);
  assert.equal(math.page.view.webContents,math.wc);assert.equal(f.wc.generating,true);assert.equal(math.wc.generating,false);
  assert.deepEqual(f.calls,[['quiesce',10000],['resume']]);assert.equal(f.driver.observationQuiesced,false);
});

test('after a read-only reload a long unknown original turn only collects its receipt without Send or a new offer',async t=>{
  const f=mainFixture(t),attempt='control_'+'a'.repeat(32),assistantBefore=sha('previous-assistant');
  Object.assign(f.row,{paused:true,model:'GPT-6 · 最新',effort:'高',attempt:{id:attempt,state:'unknown',dispatched:123,acknowledged:null}});
  Object.assign(f.row.latest_request,{phase:'queued',attempt_id:attempt,sent_user_hash:null,cancel_requested:0});
  const pending={attempt,state:'unknown',assistantBefore};f.driver.pending.set(f.page.id,pending);
  const before=JSON.stringify([f.row,f.workspace,[...f.driver.pending]]);
  const result=await f.command();
  assert.equal(result.model_sends,0);assert.equal(JSON.stringify([f.row,f.workspace,[...f.driver.pending]]),before);
  assert.equal(f.driver.pending.get(f.page.id),pending);assert.equal(f.driver.dom,f.adapter.runDom);
  const snapshot={url:f.page.url,editor:true,controlKnown:true,historyAtLatest:true,generating:true,rawStopPresent:true,
    userId:'original-user',assistantId:'thinking-assistant',attemptMarker:`[CLW:${attempt}]`,attemptMarkerCount:1,
    draft:false,composing:false,stopped:false,blocked:false,approvalRequired:false,complete:false,failure:''};
  const observed=[];
  f.pool.running=(id,running)=>{assert.equal(id,f.page.id);assert.equal(running,true);};
  f.driver.dom=async(_wc,action)=>{assert.equal(action,'snapshot');return snapshot;};
  f.driver.input={key(){assert.fail('original receipt collection cannot touch input');},evaluate(){assert.fail('original receipt collection cannot Send');}};
  f.runtime.call=async(op,payload)=>{
    observed.push(op);
    if(op==='pending-receipt')return {state:'original_attempt_requires_reconciliation',attempt_id:attempt};
    if(op==='prepared')return {attempt_id:attempt,previous_user_hash:sha('previous-user'),assistant_before_hash:assistantBefore,prompt_hash:sha('original-prompt')};
    assert.equal(op,'wire');assert.equal(payload.data.action,'sent');assert.equal(payload.data.attempt_id,attempt);
    f.row.latest_request.phase='processing';f.row.latest_request.sent_user_hash=sha(snapshot.userId);
    return {state:'browser_result_pending',attempt_id:attempt};
  };
  await f.driver.tick(f.row);await f.driver.tick(f.row);
  assert.deepEqual(observed,['pending-receipt','prepared','wire']);assert.equal(f.row.latest_request.id,'original-request');
  assert.equal(f.row.paused,true);assert.equal(f.driver.pending.get(f.page.id),pending);assert.equal(f.row.goal.revision,8);
  assert.equal(snapshot.generating,true);assert.equal(f.driver.completed.size,0);assert.equal(f.driver.resultCandidates.size,0);
});

for(const [label,change]of [
  ['dispatch',(m)=>{m.row.attempt.state='dispatching';m.row.attempt.dispatched=123;}],
  ['acknowledgment',m=>m.row.attempt.acknowledged=456],['resume',m=>m.row.paused=false],
  ['attempt replacement',m=>m.row.attempt.id='foreign'],['missing dispatch evidence',m=>delete m.row.attempt.dispatched],
  ['missing ACK evidence',m=>delete m.row.attempt.acknowledged],
  ['new pending offer',(m,f)=>f.driver.pending.set(m.page.id,{attempt:m.row.attempt.id})],
  ['new preparation',(m,f)=>f.driver.bootstrapPrepared.set(m.page.id,{})],
  ['new busy operation',(m,f)=>f.driver.busy.add(m.page.id)]
])test(`actual main rejects paused offer ${label} during observer drain and restores observation`,async t=>{
  const f=mainFixture(t),math=pausedOfferFixture(f),quiesce=f.driver.quiesceObservation;
  f.driver.quiesceObservation=async options=>{await quiesce(options);change(math,f);};
  await assert.rejects(f.command(),error=>error.accepted===false&&/app_page_adapter_(original_owner_changed|original_send_unresolved|preparation_pending)/.test(error.code));
  assert.equal(f.adapter.api.adapterSnapshot().revision,1);assert.deepEqual(f.calls,[['quiesce',10000],['resume']]);
  assert.equal(f.driver.observationQuiesced,false);assert.equal(f.driver.pageAdapterReloading,undefined);
  assert.equal(f.sandbox.pageAdapterReloading,false);
});
for(const [label,change]of [
  ['busy observation',f=>f.driver.busy.add(f.page.id)],['submission',f=>f.sandbox.submissions.busy.add(f.page.id)],
  ['bootstrap preparation',f=>f.driver.bootstrapPrepared.set(f.page.id,{})],
  ['foreign pending attempt',f=>f.driver.pending.get(f.page.id).attempt='foreign'],
  ['pending without original request',f=>delete f.row.latest_request],
  ['pending without original request ID',f=>delete f.row.latest_request.id],
  ['pending without original attempt ID',f=>delete f.row.latest_request.attempt_id],
  ['approval in flight',f=>f.driver.approvals={busy:new Set([f.page.id])}],
  ['busy paused page',f=>{f.row.paused=true;f.driver.busy.add(f.page.id);}],
  ['prepared paused page',f=>{f.row.paused=true;f.driver.bootstrapPrepared.set(f.page.id,{});}],
  ['unsent original submission',f=>f.workspace.pendingStarts[f.page.id]={objective:'original'}],['already quiesced',f=>f.driver.observationQuiesced=true]
])test(`actual main rejects ${label} before quiescing or source execution`,async t=>{
  const f=mainFixture(t);change(f);await assert.rejects(f.command(),error=>error.accepted===false&&/app_page_adapter_/.test(error.message));
  assert.deepEqual(f.calls,[]);assert.equal(f.adapter.api.adapterSnapshot().revision,1);
});
for(const [label,change]of [
  ['unknown accepted send',f=>delete f.row.latest_request.sent_user_hash],
  ['queued original request',f=>{f.row.latest_request.phase='queued';f.row.latest_request.sent_user_hash=null;}],
  ['unknown original phase',f=>{f.row.latest_request.phase='unknown';f.row.latest_request.sent_user_hash=null;}],
  ['pending unknown input',f=>f.driver.pending.get(f.page.id).state='unknown'],
  ['Host-only unknown attempt',f=>{f.driver.pending.clear();delete f.row.latest_request.sent_user_hash;}]
])test(`actual main updates observation with ${label} and leaves original request, Goal, input and pending untouched`,async t=>{
  const f=mainFixture(t);change(f);
  const before=JSON.stringify([f.row,f.workspace,[...f.driver.pending]]),pending=f.driver.pending.get(f.page.id);
  const result=await f.command();
  assert.equal(result.page_adapter.revision,2);assert.equal(result.model_sends,0);assert.equal(result.web_generation_paused,false);
  assert.equal(JSON.stringify([f.row,f.workspace,[...f.driver.pending]]),before);
  assert.equal(f.driver.pending.get(f.page.id),pending);assert.equal(f.driver.records.get(f.page.id),f.row);
  assert.equal(f.page.view.webContents,f.wc);assert.equal(f.wc.draft,'original draft');assert.equal(f.wc.generating,true);
  assert.deepEqual(f.calls,[['quiesce',10000],['resume']]);assert.equal(f.driver.observationQuiesced,false);
});
for(const [label,change]of [
  ['original driver',f=>f.sandbox.driver={...f.driver}],['original runtime',f=>f.sandbox.runtime={...f.runtime}],
  ['Host child',f=>f.runtime.child={pid:5678}],['store',f=>f.runtime.store='foreign-store'],
  ['child PID',f=>f.runtime.child.pid=5678],['Host info store',f=>f.runtime.info.store_id='foreign'],
  ['native Host',f=>f.sandbox.nativeBridge.host={turnTabs:new Map()}],
  ['request',f=>f.row.latest_request.id='foreign'],['attempt',f=>f.row.latest_request.attempt_id='foreign'],
  ['account',f=>f.page.account='B'],['document',f=>f.page.documentGeneration++],['URL',f=>f.wc.getURL=()=> 'https://chatgpt.com/c/foreign'],
  ['WC',f=>f.page.view.webContents={...f.wc}],['selected page',f=>f.pool.selected='foreign'],
  ['pool map',f=>f.pool.pages=new Map(f.pool.pages)],['owner map membership',f=>f.pool.pages.set('foreign',{id:'foreign'})],
  ['connection generation',f=>f.sandbox.runtimeGeneration++],['goal revision',f=>f.row.goal.revision++],
  ['request phase',f=>f.row.latest_request.phase='queued'],['sent receipt',f=>f.row.latest_request.sent_user_hash=null],
  ['pending state',f=>f.driver.pending.get(f.page.id).state='unknown'],
  ['pending baseline',f=>f.driver.pending.get(f.page.id).assistantBefore='changed-assistant']
])test(`actual main rejects changed ${label} after drain and resumes the original observer`,async t=>{
  const f=mainFixture(t),quiesce=f.driver.quiesceObservation;
  f.driver.quiesceObservation=async options=>{await quiesce(options);change(f);};
  await assert.rejects(f.command(),error=>error.accepted===false&&error.code==='app_page_adapter_original_owner_changed');
  assert.equal(f.adapter.api.adapterSnapshot().revision,1);assert.deepEqual(f.calls,[['quiesce',10000],['resume']]);
  assert.equal(f.driver.observationQuiesced,false);assert.equal(f.driver.pageAdapterReloading,undefined);
});
test('actual main failed drain or candidate hash mismatch resumes observation and leaves loaded bytes unchanged',async t=>{
  for(const failure of ['drain','source']){
    const f=mainFixture(t);
    if(failure==='drain')f.driver.quiesceObservation=async()=>{f.driver.observationQuiesced=true;throw Error('web_observer_drain_timeout');};
    else f.payload.expected_page_dom_sha256='0'.repeat(64);
    await assert.rejects(f.command(),failure==='drain'?/web_observer_drain_timeout/:/source_sha_mismatch/);
    assert.equal(f.adapter.api.adapterSnapshot().revision,1);assert.equal(f.driver.observationQuiesced,false);
    assert.deepEqual(f.calls.at(-1),['resume']);assert.equal(f.sandbox.pageAdapterReloading,false);
  }
});
test('actual AppControl identity contract requires target hash and exact loaded adapter CAS',()=>{
  const state={app_instance_id:'app',root:'D:/CLW',runtime_generation:2,selected:'original',page_adapter:{sha256:'a'.repeat(64),revision:1}};
  const expected={app_instance_id:'app',root:state.root,runtime_generation:2,selected:'original',page_adapter:{...state.page_adapter}};
  const payload={expected_page_dom_sha256:'b'.repeat(64)};
  assert.equal(identity.capabilities.includes('reload-page-adapter'),true);
  assert.equal(identity.assertControlIdentity('reload-page-adapter',payload,expected,state),true);
  for(const value of [{},{expected_page_dom_sha256:'bad'},{...payload,source:'incoming code'},{...payload,path:'foreign'}])
    assert.throws(()=>identity.assertControlIdentity('reload-page-adapter',value,expected,state),error=>error.accepted===false&&error.code==='app_page_adapter_payload_invalid');
  for(const adapter of [undefined,{sha256:'c'.repeat(64),revision:1},{sha256:'a'.repeat(64),revision:2},{sha256:'a'.repeat(64),revision:true},{...state.page_adapter,path:'foreign'}])
    assert.throws(()=>identity.assertControlIdentity('reload-page-adapter',payload,{...expected,page_adapter:adapter},state),/app_page_adapter_changed/);
  assert.throws(()=>identity.assertControlIdentity('reload-page-adapter',payload,{...expected,selected:'foreign'},state),/selection_changed/);
});

test('actual dispatcher refuses concurrent page reads/input while status and automation pause remain available',async t=>{
  const f=mainFixture(t),source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
  const start=source.indexOf('  const dispatchCommand=async'),end=source.indexOf('  shellControl=new ShellControl',start);
  let handle,published=0,paused=0;
  Object.assign(f.sandbox,{ipcMain:{handle:(_name,fn)=>{handle=fn;}},ownShell(){},isolatedCheck:false,checkActions:[],
    recordCommands:{actions:new Set()},publish(){published++;},captureTaskIdentity:require('../task-action-identity.cjs').captureTaskIdentity,
    pageById:()=>f.page,view:null});
  f.driver.pageAdapterReloading=true;
  f.driver.pause=async(page)=>{assert.equal(page,f.page);paused++;return {paused:true};};
  vm.runInNewContext(source.slice(start,end),f.sandbox,{filename:'actual-main-during-adapter-drain.cjs'});
  for(const action of ['task-observation','inspect','refresh','start','start-first-turn','new','set-model','reconcile-send-preparation','layout'])
    await assert.rejects(handle({}, {action,payload:{id:f.page.id}}),error=>error.accepted===false&&error.code==='app_page_adapter_busy');
  await handle({}, {action:'status',payload:{}});assert.equal(published,1);
  await handle({}, {action:'pause',payload:{id:f.page.id,expected_connection_generation:2,expected_request_id:'original-request'}});
  assert.equal(paused,1);
});
test('actual public control snapshot reports adopted hash/revision and unchanged coordinator scope',async t=>{
  const f=mainFixture(t),source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
  const quotaProjection=source.split('\n').find(line=>line.startsWith('const quotaSnapshots='));
  assert.ok(quotaProjection);
  const start=source.indexOf('function controlSnapshot(){'),end=source.indexOf('async function reloadPageAdapter(',start);
  Object.assign(f.sandbox,{exitLifecycle:require('../exit-lifecycle.cjs').createExitLifecycle(),focusInstanceId:'original-app',ROOT:'D:/CLW',profile:'D:/CLW/profile',shellRevision:1,shellSources:{},loadedMainSha:'d'.repeat(64),
    quotas:new Map(),workspaceRestored:true,eventLoopHistogram:{percentile:()=>0,max:0},loaded:()=>true,process,Date});
  f.sandbox.win.isVisible=()=>true;f.sandbox.win.isMinimized=()=>false;f.runtime.snapshot=()=>({state:'ready'});
  f.sandbox.nativeBridge.snapshot=()=>({recent:[]});vm.runInNewContext(quotaProjection+'\n'+source.slice(start,end),f.sandbox);
  const before=f.sandbox.controlSnapshot();assert.equal(before.page_adapter.sha256,f.adapter.initial.sha256);assert.equal(before.page_adapter.revision,1);
  await f.command();const after=f.sandbox.controlSnapshot();
  assert.equal(after.page_adapter.sha256,f.payload.expected_page_dom_sha256);assert.equal(after.page_adapter.revision,2);
  assert.equal(after.page_adapter.coordinator_sha256,before.page_adapter.sha256);assert.equal(after.page_adapter.scope,'serialized-public-dom');
  assert.equal(after.page_adapter.reloading,false);assert.equal(after.runtime.pid,before.runtime.pid);assert.equal(after.selected,before.selected);
  assert.deepEqual(JSON.parse(JSON.stringify(after.tasks)),JSON.parse(JSON.stringify(before.tasks)));
});
test('actual AppControl dispatch routes formal reload to the canonical adapter with pinned identity',async t=>{
  const f=mainFixture(t),source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
  const start=source.indexOf('dispatch:async(action,payload,expected,controlContext)=>{'),end=source.indexOf('\n      }});',start);
  assert.ok(start>0&&end>start);let routed=0;
  const expected={app_instance_id:'original-app',root:'D:/CLW',runtime_generation:2,selected:'original',
    page_adapter:{sha256:f.adapter.initial.sha256,revision:1}};
  const state=()=>({...expected,page_adapter:f.adapter.api.adapterSnapshot()});
  const command=f.sandbox.reloadPageAdapter;
  Object.assign(f.sandbox,{controlSnapshot:state,reloadPageAdapter:(...args)=>{routed++;return command(...args);},dispatchCommand:()=>assert.fail('formal updater must not enter ordinary page dispatcher')});
  vm.runInNewContext('controlDispatch='+source.slice(start+'dispatch:'.length,end)+'\n}',f.sandbox);
  await assert.rejects(f.sandbox.controlDispatch('reload-page-adapter',f.payload,{...expected,page_adapter:{...expected.page_adapter,revision:2}}),/app_page_adapter_changed/);
  assert.equal(routed,0);assert.equal(f.adapter.api.adapterSnapshot().revision,1);
  const result=await f.sandbox.controlDispatch('reload-page-adapter',f.payload,expected);
  assert.equal(routed,1);assert.equal(result.page_adapter.revision,2);
});
