'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {StatePublisher,SelectedViewPoller,projectWorkspaceState}=require('../state-pipeline.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const identity=(pageId='A',extra={})=>({pageId,threadId:'thread-'+pageId,requestId:'accepted-'+pageId,runtimeGeneration:1,selectionGeneration:1,...extra});
const view=key=>({page_id:key.pageId,thread_id:key.threadId,request:{id:key.requestId,phase:'processing'},events:[],record_history:{total:1}});
function fixtureState(){return {connected:true,selected:'A',pages:[{id:'A',firstTurnDraft:'selected original',first_turn_instructions:'selected work',
  observation:{at:1,modelCheckedAt:1,generating:true,attemptId:'accepted-original',html:'private full DOM',userText:'original prompt',publicText:'long body'}}],
  view:{page_id:'A',thread_id:'thread-A',events:[{seq:1,kind:'host_request_created',data:{text:'record preview'},body_loaded:false,
    body_revision:'saved-revision',text_length:24000,withdraw:{message_id:'accepted-original'}}],record_history:{total:1}},
  codexWeb:{recent:[{traceId:'original',source:{threadId:'native-thread'},bodyRevision:'native-final'}]},recordHistory:{web:true,codex:true}};}

test('goal objectives and human feedback stay in selected detail without entering page heartbeats',()=>{
 const state=fixtureState(),goal={configured:true,objective:'Persistent complete goal'.repeat(800),review:{note:'Human feedback'.repeat(400)},
  next:{objective:'Immutable original next body',operation_id:'original'},state:'paused',mode:'manual',etag:'cas',revision:2,request_id:'original-request',
  next_recovery:{can_discard:false,reason:'reconcile_original_operation'}};
 state.pages[0].goal=goal;state.pages.push({id:'B',goal});state.view.goal=goal;
 const result=projectWorkspaceState(state);
 for(const page of result.pages){
  assert.equal(page.goal.objective,undefined);assert.equal(page.goal.review,undefined);assert.equal(page.goal.next,undefined);
  assert.equal(page.goal.etag,'cas');assert.equal(page.goal.request_id,'original-request');assert.deepEqual(page.goal.next_recovery,goal.next_recovery);
 }
 assert.deepEqual(result.view.goal,goal);assert.equal(state.pages[0].goal.objective,goal.objective);
});

test('workspace projection retains selected records and identities, without unselected prose or raw DOM',()=>{
  const state=fixtureState();state.pages.push({id:'B',parent:'target-A',account:'B',model:'GPT-6',effort:'Pro',phase:'bound',paused:true,
    firstTurnDraft:'not selected'.repeat(10000),first_turn_instructions:'complete work'.repeat(10000),
    preparation_result:{task_outcome:'not_started',path:'original.md',sha256:'original-hash',text:'reply'.repeat(10000)},
    observation:{at:2,error:'runtime_disconnected_reconcile_original',html:'large body'.repeat(10000)},latest_request:{id:'original-B',phase:'suspended'},
    maintenance:{state:'holding'},pause_origin:{source:'operator'},issue_kind:'login_required'});
  const projected=projectWorkspaceState(state);
  assert.equal(projected.pages[0].firstTurnDraft,'selected original');assert.equal(projected.pages[0].first_turn_instructions,'selected work');
  assert.deepEqual(projected.view,state.view);assert.deepEqual(projected.codexWeb,state.codexWeb);assert.deepEqual(projected.recordHistory,state.recordHistory);
  const other=projected.pages[1];assert.equal(other.firstTurnDraft,undefined);assert.equal(other.first_turn_instructions,undefined);
  assert.equal(other.has_first_turn_draft,true);assert.equal(other.has_first_turn_instructions,true);assert.equal(other.preparation_result.text,undefined);
  assert.equal(other.preparation_result.task_outcome,'not_started');assert.equal(other.preparation_result.path,'original.md');
  for(const key of ['parent','account','model','effort','phase','paused','latest_request','maintenance','pause_origin','issue_kind'])assert.deepEqual(other[key],state.pages[1][key]);
  for(const page of projected.pages){assert.equal(page.observation.html,undefined);assert.equal(page.observation.userText,undefined);assert.equal(page.observation.publicText,undefined);}
  assert.equal(state.pages[1].first_turn_instructions.length,130000,'projection never alters the authoritative input');
});

test('selection rejects a foreign view and immediately restores original selected detail in the next projection',()=>{
  const state=fixtureState();state.pages.push({id:'B',firstTurnDraft:'original B draft',first_turn_instructions:'original B work'});
  assert.equal(projectWorkspaceState({...state,selected:'B'}).view,null);
  const changed=projectWorkspaceState({...state,selected:'B',view:{page_id:'B',thread_id:'thread-B',events:[]}});
  assert.equal(changed.pages[1].firstTurnDraft,'original B draft');assert.equal(changed.pages[1].first_turn_instructions,'original B work');
});

test('bound first-turn prose leaves daily status while the saved transcript and source object remain intact',()=>{
  const state=fixtureState();state.pages[0].bound=true;
  const projected=projectWorkspaceState(state);
  assert.equal(projected.pages[0].firstTurnDraft,undefined);assert.equal(projected.pages[0].first_turn_instructions,undefined);
  assert.equal(projected.pages[0].has_first_turn_instructions,true);assert.equal(projected.pages[0].has_first_turn_draft,true);
  assert.equal(state.pages[0].firstTurnDraft,'selected original');assert.equal(state.pages[0].first_turn_instructions,'selected work');
  assert.deepEqual(projected.view.events,state.view.events);assert.deepEqual(projected.recordHistory,state.recordHistory);
});

test('same-turn observations collect once, unchanged sampling suppresses IPC, heartbeat and real transitions publish',()=>{
  let now=0,state=fixtureState(),collects=0;const jobs=[],sent=[];
  const publisher=new StatePublisher({collect:()=>{collects++;return state;},send:value=>sent.push(value),now:()=>now,
    schedule:callback=>{jobs.push(callback);return jobs.length;},cancel:()=>{}});
  for(let n=0;n<1000;n++)publisher.request();assert.equal(jobs.length,1);jobs.shift()();
  assert.equal(collects,1);assert.equal(sent.length,1);
  state={...state,pages:state.pages.map(p=>({...p,observation:{...p.observation,at:2,modelCheckedAt:2}}))};now=2500;
  publisher.request();jobs.shift()();assert.equal(sent.length,1);
  now=10000;publisher.request();jobs.shift()();assert.equal(sent.length,2);assert.equal(sent[1].pages[0].observation.at,2);
  state={...state,connected:false};now++;publisher.request();jobs.shift()();assert.equal(sent.length,3);assert.equal(sent[2].connected,false);
  state={...state,connected:true,view:{...state.view,events:[...state.view.events,{seq:2,kind:'control_browser_result_failed',data:{text:'original failure receipt'}}]}};
  publisher.request();jobs.shift()();assert.equal(sent.length,4);assert.equal(sent[3].view.events[1].seq,2);
  publisher.close();publisher.request();assert.equal(jobs.length,0);
});

test('snapshot persistence and failed renderer delivery cannot consume or falsely acknowledge state',()=>{
  const sent=[],errors=[];let fail=true;
  const publisher=new StatePublisher({collect:fixtureState,onProjection:()=>{throw Error('derived snapshot unavailable');},
    send:value=>{if(fail)throw Error('renderer gone');sent.push(value);},onError:error=>errors.push(error.message)});
  assert.equal(publisher.flush(),false);assert.equal(publisher.metrics.published,0);
  fail=false;assert.equal(publisher.flush(),true);assert.equal(sent.length,1);assert.equal(sent[0].view.events[0].seq,1);
  assert.deepEqual(errors,['derived snapshot unavailable','renderer gone','derived snapshot unavailable']);publisher.close();
});

test('a slow selected read is shared and cannot commit after A -> B -> A or reconnect',async()=>{
  let current=identity(),calls=0;const waiting=[],accepted=[];
  const poller=new SelectedViewPoller({identity:()=>current,read:key=>{calls++;const pending=deferred();waiting.push({key,pending});return pending.promise;},onView:value=>accepted.push(value)});
  const first=poller.refresh(),shared=poller.refresh();assert.equal(first,shared);await tick();assert.equal(calls,1);
  current=identity('B',{selectionGeneration:2});const second=poller.refresh();await tick();
  current=identity('A',{selectionGeneration:3});const third=poller.refresh();await tick();
  waiting[0].pending.resolve(view(waiting[0].key));waiting[1].pending.resolve(view(waiting[1].key));
  assert.equal(await first,false);assert.equal(await second,false);
  current=identity('A',{runtimeGeneration:2,selectionGeneration:3});poller.invalidate();const fourth=poller.refresh();await tick();
  waiting[2].pending.resolve(view(waiting[2].key));assert.equal(await third,false);
  waiting[3].pending.resolve(view(waiting[3].key));assert.equal(await fourth,true);
  assert.deepEqual(accepted.filter(Boolean).map(value=>value.request.id),['accepted-A']);
});

test('foreign thread results and a failed state read stay visible as faults without dispatching commands',async()=>{
  let current=identity(),now=0;const errors=[],accepted=[];let calls=0;
  const poller=new SelectedViewPoller({identity:()=>current,now:()=>now,read:async key=>{calls++;if(calls===1)return {...view(key),thread_id:'foreign'};throw Error('runtime_receipt_unknown_reconcile_original');},onView:value=>accepted.push(value),onError:error=>errors.push(error.message)});
  assert.equal(await poller.refresh(),false);assert.equal(accepted.filter(Boolean).length,0);assert.deepEqual(errors,['selected_view_identity_mismatch']);
  now=2500;assert.equal(await poller.refresh(),false);assert.equal(errors[1],'runtime_receipt_unknown_reconcile_original');
  current=null;await poller.refresh();assert.equal(accepted.at(-1),null);assert.equal(calls,2);
});

test('slow or unavailable optional activity never blocks current records, duplicates its read, or attaches across tasks',async()=>{
  let current=identity(),now=0,activityCalls=0;const activity=deferred(),accepted=[];
  const poller=new SelectedViewPoller({identity:()=>current,now:()=>now,read:async key=>view(key),readActivity:()=>{activityCalls++;return activity.promise;},onView:value=>accepted.push(value)});
  assert.equal(await poller.refresh(),true);assert.equal(accepted.at(-1).request.id,'accepted-A');assert.equal(accepted.at(-1).session_activity_loading,true);
  now=2500;assert.equal(await poller.refresh(),true);assert.equal(activityCalls,1);
  current=identity('B');await poller.refresh();assert.equal(activityCalls,2);
  activity.reject(Error('optional activity unavailable'));await tick();
  assert.equal(accepted.at(-1).page_id,'B');assert.equal(accepted.at(-1).session_activity_unavailable,true);
  assert.equal(accepted.filter(value=>value?.page_id==='A').every(value=>!value.session_activity_unavailable),true);
});

test('new accepted request fences old replies even while the selected page stays the same',async()=>{
  let current=identity();const pending=deferred(),accepted=[];
  const poller=new SelectedViewPoller({identity:()=>current,read:()=>pending.promise,onView:value=>accepted.push(value)});
  const first=poller.refresh();await tick();current=identity('A',{requestId:'new-accepted-A'});
  pending.resolve(view(identity()));assert.equal(await first,false);assert.equal(accepted.filter(Boolean).length,0);
});

test('quiesce synchronously holds new reads until the existing view and activity both naturally finish',async()=>{
  const originalView=deferred(),originalActivity=deferred(),accepted=[];let viewCalls=0,activityCalls=0;
  const current=identity(),poller=new SelectedViewPoller({identity:()=>current,
    read:()=>{viewCalls++;return originalView.promise;},readActivity:()=>{activityCalls++;return originalActivity.promise;},onView:value=>accepted.push(value)});
  const original=poller.refresh();await tick();assert.equal(poller.pendingReads.size,2);
  let finished=false;const drain=poller.quiesce({timeoutMs:1000}).then(value=>{finished=true;return value;});
  assert.equal(poller.quiesced,true);
  assert.equal(await poller.refresh({force:true}),false);
  assert.equal(await poller.startActivity(current,JSON.stringify(current),poller.generation),false);
  assert.equal(viewCalls,1);assert.equal(activityCalls,1);
  originalView.resolve(view(current));assert.equal(await original,true);await tick();
  assert.equal(finished,false);assert.equal(poller.pendingReads.size,1);
  assert.equal(accepted.at(-1).request.id,current.requestId);
  originalActivity.resolve({calls:[{id:'original-tool'}]});
  assert.deepEqual(await drain,{drained:true,pending:0});
  assert.equal(accepted.at(-1).session_activity.calls[0].id,'original-tool');
  assert.equal(accepted.at(-1).session_activity_loading,false);
  assert.equal(await poller.refresh({force:true}),false);
  poller.resume();assert.equal(poller.quiesced,false);assert.deepEqual(await poller.quiesce(),{drained:true,pending:0});
});

test('quiesce timeout keeps both original promises; resume reuses them without duplicate RPCs',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const originalView=deferred(),originalActivity=deferred();let viewCalls=0,activityCalls=0;
  const current=identity(),poller=new SelectedViewPoller({identity:()=>current,
    read:()=>{viewCalls++;return originalView.promise;},readActivity:()=>{activityCalls++;return originalActivity.promise;},onView:()=>{}});
  const original=poller.refresh();await tick();const activityPromise=poller.activity.promise;
  const drain=poller.quiesce({timeoutMs:10});t.mock.timers.tick(10);
  assert.deepEqual(await drain,{drained:false,pending:2});
  assert.equal(poller.inflight.promise,original);assert.equal(poller.activity.promise,activityPromise);
  assert.equal(poller.pendingReads.size,2);
  poller.resume();assert.equal(poller.refresh({force:true}),original);
  assert.equal(poller.startActivity(current,JSON.stringify(current),poller.generation),activityPromise);
  assert.equal(viewCalls,1);assert.equal(activityCalls,1);
  const nextDrain=poller.quiesce({timeoutMs:100});
  originalView.resolve(view(current));originalActivity.resolve({calls:[]});
  assert.equal(await original,true);assert.deepEqual(await nextDrain,{drained:true,pending:0});
  assert.equal(viewCalls,1);assert.equal(activityCalls,1);
});

test('quiesce drains every stale A -> B -> A generation without attaching old activity or losing current view',async()=>{
  let current=identity();const views=[],activities=[],accepted=[];
  const poller=new SelectedViewPoller({identity:()=>current,
    read:key=>{const pending=deferred();views.push({key,pending});return pending.promise;},
    readActivity:key=>{const pending=deferred();activities.push({key,pending});return pending.promise;},onView:value=>accepted.push(value)});
  const first=poller.refresh();await tick();current=identity('B',{selectionGeneration:2});const second=poller.refresh();await tick();
  current=identity('A',{selectionGeneration:3});const third=poller.refresh();await tick();
  assert.equal(poller.pendingReads.size,6);let finished=false;
  const drain=poller.quiesce({timeoutMs:1000}).then(result=>{finished=true;return result;});
  views[2].pending.resolve(view(views[2].key));activities[2].pending.resolve({tag:'current-A'});
  assert.equal(await third,true);await tick();assert.equal(finished,false);assert.equal(poller.pendingReads.size,4);
  views[0].pending.resolve(view(views[0].key));views[1].pending.resolve(view(views[1].key));
  activities[0].pending.resolve({tag:'stale-A'});activities[1].pending.resolve({tag:'stale-B'});
  assert.equal(await first,false);assert.equal(await second,false);assert.deepEqual(await drain,{drained:true,pending:0});
  assert.equal(accepted.at(-1).page_id,'A');assert.equal(accepted.at(-1).session_activity.tag,'current-A');
  assert.equal(accepted.filter(Boolean).some(value=>value.session_activity?.tag?.startsWith('stale-')),false);
  assert.equal(views.length,3);assert.equal(activities.length,3);
});

test('quiesce treats rejected diagnostic reads as settled without clearing the last accepted ledger view',async()=>{
  const nextView=deferred(),nextActivity=deferred(),current=identity(),errors=[],accepted=[];let reads=0,activityReads=0,now=0;
  const poller=new SelectedViewPoller({identity:()=>current,now:()=>now,read:key=>++reads===1?view(key):nextView.promise,
    readActivity:()=>++activityReads===1?{calls:['saved-tool']}:nextActivity.promise,
    onView:value=>accepted.push(value),onError:error=>errors.push(error.message)});
  assert.equal(await poller.refresh(),true);await tick();const saved=poller.latestAccepted.view;
  now=2500;const refresh=poller.refresh({force:true});await tick();assert.equal(activityReads,2);const drain=poller.quiesce({timeoutMs:1000});
  nextView.reject(Error('original read failure'));nextActivity.reject(Error('original activity failure'));
  assert.equal(await refresh,false);assert.deepEqual(await drain,{drained:true,pending:0});
  assert.equal(poller.latestAccepted.view,saved);assert.equal(accepted.at(-1).request.id,current.requestId);
  assert.deepEqual(errors,['original read failure']);
});

test('large unselected historical work packages have bounded projection and do not serialize into IPC',()=>{
  const text='x'.repeat(24000),html='y'.repeat(400000);
  const state={selected:'page-0',pages:Array.from({length:120},(_,n)=>({id:'page-'+n,title:'Task '+n,parent:n?'controller-target':null,
    firstTurnDraft:text,first_turn_instructions:text,latest_request:{id:'request-'+n,phase:'completed'},
    observation:{at:1,generating:false,html,userText:text,publicText:html}})),view:null,closed:[]};
  const before=Buffer.byteLength(JSON.stringify(state)),projected=projectWorkspaceState(state),after=Buffer.byteLength(JSON.stringify(projected));
  assert.ok(after<100000);assert.ok(before/after>1000);assert.equal(projected.pages.length,120);assert.equal(projected.pages[0].first_turn_instructions.length,24000);
  assert.equal(state.pages[119].observation.html.length,400000);
});

test('revisioned patches omit unchanged catalogs/history and explicit status resynchronizes a full snapshot',()=>{
  let state=fixtureState(),now=0;const sent=[];
  state.codexWeb.recent=Array.from({length:3000},(_,n)=>({traceId:'trace-'+n,source:{threadId:'thread-'+n,workingDirectory:'D:/fixture/'+n},status:'completed',bodyRevision:'original-'+n}));
  const publisher=new StatePublisher({collect:()=>state,send:value=>sent.push(value),now:()=>now});
  publisher.flush();assert.equal(sent[0].statePatch,false);assert.equal(sent[0].stateRevision,1);
  state={...state,pages:[{...state.pages[0],paused:true,pause_origin:{source:'operator'}}]};now=1;publisher.flush();
  const patch=sent[1];assert.equal(patch.statePatch,true);assert.equal(patch.baseRevision,1);assert.equal(patch.stateRevision,2);
  assert.equal(patch.codexWeb,undefined);assert.equal(patch.view,undefined);assert.equal(patch.pages[0].paused,true);
  assert.ok(Buffer.byteLength(JSON.stringify(patch))<1000);
  now=10001;publisher.flush();assert.equal(sent[2].stateRevision,3);assert.equal(sent[2].pages[0].paused,true);assert.equal(sent[2].codexWeb,undefined);
  publisher.force=true;publisher.flush();assert.equal(sent[3].statePatch,false);assert.equal(sent[3].stateRevision,4);assert.equal(sent[3].codexWeb.recent.length,3000);
  state={...state,view:null};publisher.flush();assert.equal(sent[4].view,null);assert.equal(sent[4].baseRevision,4);
  publisher.close();
});

test('failed patch delivery advances no revision, and failed forced recovery remains a full snapshot on retry',()=>{
  let state=fixtureState(),fail=false;const sent=[];
  const publisher=new StatePublisher({collect:()=>state,onError:()=>{},send:value=>{if(fail)throw Error('ipc unavailable');sent.push(value);}});
  publisher.flush();state={...state,connected:false};fail=true;
  assert.equal(publisher.flush(),false);assert.equal(publisher.revision,1);
  publisher.force=true;assert.equal(publisher.flush(),false);assert.equal(publisher.revision,1);
  fail=false;publisher.flush();assert.equal(sent[1].statePatch,false);assert.equal(sent[1].stateRevision,2);assert.equal(sent[1].connected,false);
  publisher.close();
});

test('real publisher and renderer decoder recover a lost patch without borrowing another task receipt',()=>{
  const {apply}=require('../state-patch.js');let source=fixtureState();const packets=[];
  const publisher=new StatePublisher({collect:()=>source,send:packet=>packets.push(packet)});
  publisher.flush();let displayed=apply({},packets[0]).state;
  source={...source,pages:[{...source.pages[0],paused:true}]};publisher.flush();const lost=packets[1];
  source={...source,selected:'B',pages:[...source.pages,{id:'B',bound:true,latest_request:{id:'accepted-B',phase:'processing'}}],
    view:{page_id:'B',thread_id:'thread-B',request:{id:'accepted-B',phase:'processing'},events:[{seq:5,body_revision:'B-original',data:{text:'B preview'}}]}};
  publisher.flush();const gap=apply(displayed,packets[2]);assert.equal(gap.needsSnapshot,true);
  assert.equal(displayed.selected,'A');assert.equal(displayed.view.events[0].body_revision,'saved-revision');
  publisher.force=true;publisher.flush();displayed=apply(displayed,packets[3]).state;
  assert.equal(displayed.selected,'B');assert.equal(displayed.view.request.id,'accepted-B');assert.equal(displayed.view.events[0].body_revision,'B-original');
  assert.equal(apply(displayed,lost).ignored,true);
  source={...source,view:null};publisher.flush();displayed=apply(displayed,packets[4]).state;
  assert.equal(displayed.view,null);assert.equal(displayed.selected,'B');publisher.close();
});
