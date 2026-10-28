'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const {selectStopScope,captureStopTarget}=require('../stop-scope.cjs');
const {WebDriver}=require('../web-driver.cjs');
const {projectTaskRelations}=require('../state-pipeline.cjs');
const hash=text=>createHash('sha256').update(text).digest('hex');
const scope=(request='controller-request',extra={})=>({available:true,request_id:request,run_id:'original-run',
  controller_target:'controller-target',controller_request:'controller-request',parent_target:null,parent_request_id:null,...extra});
function rows(){return [
  {page_id:'controller-page',target_id:'controller-target',thread_id:'controller-thread',account:'A',root:'D:/game',access:'write',write_paths:['.'],
    latest_request:{id:'controller-request',phase:'processing'},stop_scope:scope()},
  {page_id:'worker-page',target_id:'worker-target',thread_id:'worker-thread',account:'A',root:'D:/worktrees/game-worker',access:'write',write_paths:['Assets/Scenes'],parent_target:'controller-target',
    latest_request:{id:'worker-request',phase:'processing'},stop_scope:scope('worker-request',{parent_target:'controller-target',parent_request_id:'controller-request'})},
  {page_id:'grandchild-page',target_id:'grandchild-target',account:'A',root:'D:/independent-worktree',parent_target:'worker-target',
    latest_request:{id:'grandchild-request',phase:'processing'},stop_scope:scope('grandchild-request',{parent_target:'worker-target',parent_request_id:'worker-request'})}
];}
test('target_id foreign keys include real descendants and preserve each child worktree grant',()=>{
  const source=rows(),result=selectStopScope(source,'controller-page');
  assert.deepEqual(result.targets.map(r=>r.page_id),['controller-page','worker-page','grandchild-page']);
  assert.equal(result.targets[1],source[1]);assert.equal(result.targets[1].root,'D:/worktrees/game-worker');
  assert.deepEqual(result.targets[1].write_paths,['Assets/Scenes']);
});
test('navigation projects real page identities and authoritative active-handoff parents without title matching',()=>{
  const source=rows(),relations=projectTaskRelations(source);
  assert.equal(relations.get('worker-page').parent,'controller-page');
  assert.equal(relations.get('worker-page').parent_target,'controller-target');
  source.push({...source[0],page_id:'successor-page',target_id:'successor-target'});
  source[1].stop_scope.parent_target='successor-target';
  assert.equal(projectTaskRelations(source).get('worker-page').parent,'successor-page');
  source.push({...source[0],page_id:'duplicate-target-page'});
  source[1].stop_scope.parent_target='controller-target';
  const ambiguous=projectTaskRelations(source).get('worker-page');
  assert.equal(ambiguous.parent,null);assert.equal(ambiguous.parent_identity_unavailable,true);
});
test('same titles and page-id aliases never authorize unrelated targets, accounts, runs or requests',()=>{
  const source=rows();source[0].title=source[1].title='Same title';
  source.push({...source[1],page_id:'wrong-foreign-key',target_id:'wrong-target',parent_target:'controller-page'});
  source.push({...source[1],page_id:'other-account',target_id:'other-account-target',account:'B'});
  source.push({...source[1],page_id:'other-run',target_id:'other-run-target',stop_scope:{...source[1].stop_scope,run_id:'new-run'}});
  source.push({...source[1],page_id:'other-request',target_id:'other-request-target',stop_scope:{...source[1].stop_scope,request_id:'old-request'}});
  source.push({...source[1],page_id:'wrong-original-parent',target_id:'wrong-parent-target',stop_scope:{...source[1].stop_scope,parent_request_id:'old-controller-request'}});
  const result=selectStopScope(source,'controller-page');
  assert.deepEqual(result.targets.map(r=>r.page_id),['controller-page','worker-page','grandchild-page']);
  assert.deepEqual(result.unavailable,[{page_id:'other-request',reason:'managed_stop_scope_unavailable'}]);
});
test('only a verified active same-run handoff transfers descendant stop ownership',()=>{
  const source=rows(),original=source[0];
  const successor={...original,page_id:'successor-page',target_id:'successor-target',thread_id:'successor-thread',
    latest_request:{id:'successor-request',phase:'processing'},stop_scope:scope('successor-request',
      {controller_target:'successor-target',controller_request:'successor-request'})};
  original.successor=successor.page_id;original.successor_state='enrolling';source.push(successor);
  for(const child of source.slice(1,3))child.stop_scope={...child.stop_scope,controller_target:'successor-target',controller_request:'successor-request'};
  assert.deepEqual(selectStopScope(source,successor.page_id).targets.map(r=>r.page_id),['successor-page']);
  original.successor_state='active';original.stop_scope=null;
  source[1].stop_scope={...source[1].stop_scope,parent_target:'successor-target',parent_request_id:'successor-request',original_parent_request_id:'controller-request'};
  assert.deepEqual(selectStopScope(source,successor.page_id).targets.map(r=>r.page_id),['successor-page','worker-page','grandchild-page']);
  successor.stop_scope.run_id='foreign-run';
  assert.deepEqual(selectStopScope(source,successor.page_id).targets.map(r=>r.page_id),['successor-page']);
});
test('missing authoritative scope is reported without guessing old first-task creation provenance',()=>{
  const source=rows();source[1].stop_scope={available:false,request_id:'worker-request'};
  source[1].settings=JSON.stringify({first_task_parent:{run_id:'original-run',request_id:'controller-request'}});
  assert.deepEqual(selectStopScope(source,'controller-page').targets.map(r=>r.page_id),['controller-page','grandchild-page']);
  assert.deepEqual(selectStopScope(source,'controller-page').unavailable,[{page_id:'worker-page',reason:'managed_stop_scope_unavailable'}]);
});
test('ambiguous target ids and cycles cannot route stop to a different page',()=>{
  const source=rows();source.push({...source[0],page_id:'ambiguous-controller'});
  assert.deepEqual(selectStopScope(source,'controller-page').targets.map(r=>r.page_id),['controller-page']);
  source.pop();source[1].parent_target='grandchild-target';
  assert.deepEqual(selectStopScope(source,'controller-page').targets.map(r=>r.page_id),['controller-page']);
});
test('frozen child identity rejects request, account, grant, connection and document changes',()=>{
  for(const mutate of [r=>r.latest_request.id='other-request',r=>r.account='B',r=>r.root='D:/other-game',
    r=>r.write_paths=['.'],(_r,p)=>p.documentGeneration++,(_r,_p,f)=>f.generation++]){
    const record=rows()[1],page={id:record.page_id,documentGeneration:1},fixture={generation:1};
    const identity=captureStopTarget(record,page,()=>record,()=>page,()=>fixture.generation);
    identity.assertCurrent();mutate(record,page,fixture);assert.throws(()=>identity.assertCurrent(),/managed_stop_original_task_changed/);
  }
});
function driverFixture(){
  const source=rows().slice(0,2),pages=new Map(),calls=[],actions=[],snapshots=new Map(),runtime=new EventEmitter();
  for(const record of source){record.phase='bound';record.url='https://chatgpt.com/c/'+record.page_id;
    record.latest_request.sent_user_hash=hash(record.page_id+'-user');
    pages.set(record.page_id,{id:record.page_id,account:'A',documentGeneration:1,view:{webContents:{id:record.page_id,isDestroyed:()=>false}}});
    snapshots.set(record.page_id,{url:record.url,userId:record.page_id+'-user',assistantId:'reply',generating:true,stopped:false});
  }
  runtime.call=async(op,payload)=>{calls.push({op,payload});return {};};
  const pool={pages,running(){},emit(){}};
  const driver=new WebDriver({runtime,pool,onNotice(){},sleep:async()=>{},dom:async(wc,action)=>{
    actions.push({id:wc.id,action});
    if(action==='snapshot')return {...snapshots.get(wc.id)};
    assert.equal(action,'stop');snapshots.get(wc.id).generating=false;snapshots.get(wc.id).stopped=true;return {clicked:true};
  }});
  driver.records=new Map(source.map(r=>[r.page_id,r]));driver.reconcileAll=async()=>{};
  return {driver,pages,source,calls,actions,snapshots,runtime,p:pages.get('controller-page')};
}
test('concurrent and later repeated clicks stop each original turn once and never cancel execution jobs',async()=>{
  const f=driverFixture();let release;const wait=new Promise(resolve=>release=resolve);
  const call=f.runtime.call;f.runtime.call=async(op,p)=>{const result=await call(op,p);if(op==='pause')await wait;return result;};
  const first=f.driver.stopGeneration(f.p),second=f.driver.stopGeneration(f.p);release();
  const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(a.confirmed,2);assert.equal(a.pending,0);
  assert.equal(f.actions.filter(a=>a.action==='stop').length,2);
  assert.equal(f.calls.filter(c=>c.op==='pause').length,1);
  const receipts=f.calls.length,third=await f.driver.stopGeneration(f.p);
  assert.equal(third.reconciliation_only,true);assert.equal(third.confirmed,2);assert.equal(f.calls.length,receipts);
  assert.equal(f.actions.filter(a=>a.action==='stop').length,2);assert.equal(third.local_execution_stopped,false);
  assert.equal(f.calls.some(c=>/cancel|job|kill/.test(c.op)),false);
});
test('unknown accepted Stop is reconciled through original DOM without another click',async()=>{
  const f=driverFixture(),dom=f.driver.dom;let lost=true;
  f.driver.dom=async(wc,action)=>{const result=await dom(wc,action);if(action==='stop'&&wc.id===f.p.id&&lost){lost=false;throw Error('reply_lost');}return result;};
  const first=await f.driver.stopGeneration(f.p);assert.equal(first.pending,1);
  const second=await f.driver.stopGeneration(f.p);assert.equal(second.pending,0);assert.equal(second.confirmed,2);
  assert.equal(f.actions.filter(a=>a.action==='stop'&&a.id===f.p.id).length,1);
  assert.equal(f.calls.filter(c=>c.op==='pause').length,1);
});
test('a failed read before any Stop permits a fresh bounded retry without replaying accepted siblings',async()=>{
  const f=driverFixture(),dom=f.driver.dom;let failed=false;
  f.driver.dom=async(wc,action)=>{if(wc.id==='worker-page'&&action==='snapshot'&&!failed){failed=true;throw Error('read_transient');}return dom(wc,action);};
  const first=await f.driver.stopGeneration(f.p);assert.equal(first.pending,1);
  const second=await f.driver.stopGeneration(f.p);assert.equal(second.confirmed,2);assert.equal(second.pending,0);
  assert.equal(f.actions.filter(a=>a.action==='stop'&&a.id==='worker-page').length,1);
  assert.equal(f.actions.filter(a=>a.action==='stop'&&a.id===f.p.id).length,1);
  assert.equal(f.calls.filter(c=>c.op==='pause').length,1);
});
test('a restored durable user-stopped issue reconciles instead of repeating an unknown old click',async()=>{
  const f=driverFixture();for(const record of f.source){record.issue_kind='user_stopped';record.own_paused=true;}
  const result=await f.driver.stopGeneration(f.p);assert.equal(result.reconciliation_only,true);assert.equal(result.pending,2);
  assert.equal(f.actions.some(a=>a.action==='stop'),false);assert.equal(f.calls.length,0);
});
test('a lost pre-click issue receipt is checked on the original ledger before the first Stop',async()=>{
  const f=driverFixture(),call=f.runtime.call;let failed=false;
  f.runtime.call=async(op,p)=>{await call(op,p);if(op==='page-issue'&&p.page_id==='worker-page'&&!failed){
    failed=true;f.source[1].own_paused=true;f.source[1].issue_kind='user_stopped';throw Error('reply_lost');}return {};};
  const first=await f.driver.stopGeneration(f.p);assert.equal(first.pending,1);
  const second=await f.driver.stopGeneration(f.p);assert.equal(second.pending,0);
  assert.equal(f.calls.filter(c=>c.op==='page-issue'&&c.payload.page_id==='worker-page').length,1);
  assert.equal(f.actions.filter(a=>a.action==='stop'&&a.id==='worker-page').length,1);
});
test('a request or public turn change after pause prevents stopping the replacement task',async()=>{
  for(const mutate of [f=>{f.source[1].latest_request.id='new-request';},f=>{f.snapshots.get('worker-page').userId='new-user';},
    f=>{f.pages.get('worker-page').documentGeneration++;},f=>{f.source[1].write_paths=['.'];}]){
    const f=driverFixture(),call=f.runtime.call;
    f.runtime.call=async(op,p)=>{const result=await call(op,p);if(op==='pause')mutate(f);return result;};
    const result=await f.driver.stopGeneration(f.p);assert.equal(result.pending,1);
    assert.equal(f.actions.some(a=>a.id==='worker-page'&&a.action==='stop'),false);
  }
});
test('an unknown pause response is not replayed and reconnect stops subsequent old mutations',async()=>{
  const f=driverFixture(),call=f.runtime.call;
  f.runtime.call=async(op,p)=>{await call(op,p);if(op==='pause')throw Error('disconnected');return {};};
  await assert.rejects(()=>f.driver.stopGeneration(f.p),/disconnected/);
  const result=await f.driver.stopGeneration(f.p);assert.equal(result.pending,3);assert.equal(result.pause_confirmed,false);
  assert.equal(f.calls.filter(c=>c.op==='pause').length,1);assert.equal(f.actions.some(a=>a.action==='stop'),false);
  f.runtime.emit('disconnected');const again=await f.driver.stopGeneration(f.p);
  assert.equal(again.pending,3);assert.equal(f.calls.length,1);
});
test('idle public turns cannot certify a lost pause; only the original ledger pause settles it',async()=>{
  const f=driverFixture(),call=f.runtime.call;let lost=true;
  f.runtime.call=async(op,p)=>{await call(op,p);if(op==='pause'&&lost){lost=false;throw Error('reply_lost');}return {};};
  await assert.rejects(()=>f.driver.stopGeneration(f.p),/reply_lost/);
  for(const snapshot of f.snapshots.values())snapshot.generating=false;
  const unknown=await f.driver.stopGeneration(f.p);assert.equal(unknown.confirmed,2);assert.equal(unknown.pending,1);
  f.source[0].own_paused=true;
  const known=await f.driver.stopGeneration(f.p);assert.equal(known.pause_confirmed,true);assert.equal(known.pending,0);
  assert.equal(f.calls.filter(c=>c.op==='pause').length,1);
});
