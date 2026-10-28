'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
const {WebDriver}=require('../web-driver.cjs');
const hash=text=>createHash('sha256').update(text||'').digest('hex'),attempt='control_'+'f'.repeat(32),marker='[CLW:'+attempt+']';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(t){
  const row={page_id:'original',thread_id:'original-thread',phase:'bound',account:'A',url:'https://chatgpt.com/c/original',model:'GPT-6',effort:'Pro',paused:false,
    latest_request:{id:'original-request',phase:'queued',cancel_requested:0,attempt_id:null}};
  let location=row.url,body='',prepared,serverPaused=false,dispatched=false,sent=false;
  const hooks={},calls=[],actions=[],notices=[],runtime=new EventEmitter(),pool=new EventEmitter();runtime.ready=true;runtime.closed=false;
  const page={id:row.page_id,account:'A',modelRestorePending:true,documentGeneration:1,manualInteractionSequence:0,domReady:true,
    view:{webContents:{getURL:()=>location,isDestroyed:()=>false}}};
  const snapshot={url:location,editor:true,controlKnown:true,historyAtLatest:true,generating:false,rawStopPresent:false,draft:false,composing:false,
    approvalRequired:false,loginRequired:false,blocked:false,accessLimited:false,userId:'before-user',assistantId:'before-answer',effortLabel:'Pro'};
  Object.assign(pool,{pages:new Map([[page.id,page]]),running(){},work(){},isUserViewing:()=>true});
  runtime.call=async(op,args)=>{
    calls.push([op,args]);await hooks[op]?.(args);
    if(op==='pause'){serverPaused=args.paused;return {paused:serverPaused};}
    if(op==='wire'){
      const action=args.data.action;await hooks[action]?.(args);
      if(action==='pulse')return {state:'offer',attempt_id:attempt,request_id:row.latest_request.id};
      if(action==='dispatch'){dispatched=true;return {dispatch:true,attempt_id:attempt,prompt:'complete original goal'};}
      if(action==='sent')return {state:'model_received'};
      if(action==='result')return {state:'completed'};
      assert.fail('unexpected wire '+action);
    }
    if(op==='prepare'){prepared={attempt_id:args.attempt_id,previous_user_hash:hash(snapshot.userId),assistant_before_hash:args.assistant_before_hash,prompt_hash:args.prompt_hash};return {prepared:true};}
    if(op==='list'){
      const current={...row,paused:serverPaused,latest_request:{...row.latest_request,attempt_id:dispatched?attempt:null}};
      return {pages:[hooks.listResult?hooks.listResult(current):current]};
    }
    if(op==='view')return {page_id:row.page_id,thread_id:row.thread_id,latest_request:{...row.latest_request,attempt_id:attempt},
      request:{id:row.latest_request.id,phase:row.latest_request.phase,cancel_requested:0},attempt:{id:attempt,state:'dispatching',dispatched:123,acknowledged:null}};
    if(op==='prepared')return prepared;
    if(op==='pending-receipt')return hooks.receipt?.()||{state:'paused'};
    if(op==='artifact')return {path:'original-result.md',sha256:'a'.repeat(64)};
    if(op==='page-issue')return {};
    assert.fail('unexpected RPC '+op);
  };
  const driver=new WebDriver({runtime,pool,onNotice:text=>notices.push(text),sleep:async()=>{},input:{key:async()=>{}},dom:async(_wc,action,args)=>{
    actions.push(action);await hooks['dom:'+action]?.(args);
    if(action==='snapshot')return sent?{...snapshot,userId:'sent-original',userText:body,attemptMarker:marker,attemptMarkerCount:1}:{...snapshot};
    if(action==='focus-editor')return {};
    if(action==='insert-plain-text'){body=args.text;return {};}
    if(action==='editor-text')return {text:body};
    if(action==='send'){sent=true;return {};}
    assert.fail('unexpected DOM '+action);
  }});
  driver.records.set(page.id,row);driver.recordsLoaded=true;
  driver.inspect=async()=>{calls.push(['inspect']);await hooks.inspect?.();return {model:row.model,effort:row.effort};};
  driver.selectModel=async()=>assert.fail('automatic observation cannot restore a model');
  driver.prepareConnector=async(_p,_s,context)=>context.requireOpen();
  const manual=()=>{page.manualInteractionSequence++;page.manualControl=true;page.manualUrl=location;pool.emit('manual-interaction',{id:page.id,sequence:page.manualInteractionSequence,kind:'keyboard',at:Date.now()});};
  t.after(()=>driver.dispose());
  return {driver,runtime,pool,page,row,snapshot,hooks,calls,actions,notices,manual,setLocation:value=>{location=value;snapshot.url=value;},
    get sent(){return sent;},get body(){return body;}};
}
const wireActions=f=>f.calls.filter(x=>x[0]==='wire').map(x=>x[1].data.action);

test('manual input during accepted dispatch keeps the original grant unresolved and never clicks or reports not_sent',async t=>{
  const f=fixture(t),gate=deferred(),entered=deferred();f.hooks.dispatch=async()=>{entered.resolve();await gate.promise;};
  const ticking=f.driver.tick(f.row);await entered.promise;f.manual();gate.resolve();await ticking;
  assert.equal(f.sent,false);assert.equal(f.actions.includes('send'),false);assert.deepEqual(wireActions(f),['pulse','dispatch']);
  assert.equal(f.calls.some(x=>x[0]==='prepare'),false);assert.equal(f.driver.pending.get(f.page.id).attempt,attempt);
  assert.equal(f.page.manualControl,true);assert.equal(f.driver.records.get(f.page.id).paused,true);
});

test('manual input during composer editing preserves the body and original accepted attempt without pseudo finish',async t=>{
  const f=fixture(t),gate=deferred(),entered=deferred();f.hooks['dom:insert-plain-text']=async()=>{entered.resolve();await gate.promise;};
  const ticking=f.driver.tick(f.row);await entered.promise;f.manual();gate.resolve();
  await assert.rejects(ticking,error=>error.code==='manual_control');
  assert.equal(f.sent,false);assert.equal(f.body,'complete original goal\n'+marker);
  assert.equal(f.actions.includes('send'),false);assert.equal(wireActions(f).includes('finish'),false);assert.equal(f.calls.some(x=>x[0]==='page-issue'),false);
  assert.equal(f.driver.sendFailures.get(f.page.id).known_not_sent,false);assert.equal(f.driver.pending.get(f.page.id).attempt,attempt);
});

test('manual interaction after the sole Send click still confirms the accepted original browser receipt',async t=>{
  const f=fixture(t);f.hooks['dom:send']=async()=>f.manual();await f.driver.tick(f.row);
  assert.equal(f.sent,true);assert.equal(f.actions.filter(x=>x==='send').length,1);assert.deepEqual(wireActions(f),['pulse','dispatch','sent']);
  assert.equal(f.page.manualControl,true);assert.equal(f.driver.records.get(f.page.id).paused,true);assert.equal(f.driver.sendFailures.has(f.page.id),false);
});

test('manual future pause still collects the completed original reply using pending-receipt only',async t=>{
  const f=fixture(t);Object.assign(f.row.latest_request,{phase:'processing',attempt_id:attempt,sent_user_hash:hash('before-user')});
  Object.assign(f.snapshot,{complete:true,assistantId:'completed-answer',html:'<p>Original completed result</p>',attemptMarker:marker,attemptMarkerCount:1});
  f.hooks.receipt=()=>({state:'browser_result_pending',attempt_id:attempt,sent_user_hash:hash('before-user'),assistant_before_hash:hash('before-answer')});
  f.manual();await f.driver.tick(f.row);f.driver.resultCandidates.get(attempt).at-=2000;await f.driver.tick(f.row);
  assert.deepEqual(wireActions(f),['result']);assert.equal(f.calls.filter(x=>x[0]==='pending-receipt').length,2);
  assert.equal(f.calls.filter(x=>x[0]==='artifact').length,1);assert.equal(f.actions.includes('send'),false);assert.equal(f.driver.completed.has(attempt),true);
  assert.equal(f.page.manualControl,true);assert.equal(f.row.latest_request.id,'original-request');
});

test('repeated native keys persist one pause per connection instead of flooding RPC',async t=>{
  const f=fixture(t),gate=deferred();f.hooks.pause=()=>gate.promise;
  for(let n=0;n<20;n++)f.manual();
  assert.equal(f.calls.filter(x=>x[0]==='pause').length,1);assert.equal(f.page.manualInteractionSequence,20);assert.equal(f.page.manualControl,true);
  gate.resolve();await f.driver.persistManualPause(f.page);assert.equal(f.calls.filter(x=>x[0]==='pause').length,1);
});

test('late explicit resume cannot release a newer manual hold and reapplies the original pause once',async t=>{
  const f=fixture(t),gate=deferred(),entered=deferred();f.manual();await f.driver.persistManualPause(f.page);
  f.hooks.pause=async args=>{if(args.paused===false){entered.resolve();await gate.promise;}};
  const resuming=f.driver.resume(f.page,f.row.latest_request.id);await entered.promise;f.manual();gate.resolve();
  await assert.rejects(resuming,error=>error.code==='manual_control'||/手动操作/.test(error.message));
  assert.equal(f.page.manualControl,true);assert.deepEqual(f.calls.filter(x=>x[0]==='pause').map(x=>x[1].paused),[true,false,true]);
  assert.equal(wireActions(f).length,0);assert.equal(f.actions.includes('send'),false);
});

test('explicit resume reconciles a failed same-connection manual pause before releasing the original task',async t=>{
  const f=fixture(t),failure=Error('pause reply unavailable');let first=true,reconciled=0;
  f.hooks.pause=async args=>{if(args.paused&&first){first=false;throw failure;}};
  f.manual();await assert.rejects(f.driver.persistManualPause(f.page),error=>error===failure);
  const generation=f.driver.connectionGeneration;
  f.driver.reconcileAll=async()=>{assert.equal(f.page.manualControl,false);reconciled++;};
  await f.driver.resume(f.page,f.row.latest_request.id);
  assert.deepEqual(f.calls.map(x=>x[0]),['pause','list','pause']);
  assert.deepEqual(f.calls.filter(x=>x[0]==='pause').map(x=>x[1].paused),[true,false]);
  assert.equal(f.calls[2][1].expected_request_id,'original-request');assert.equal(f.driver.connectionGeneration,generation);
  assert.equal(f.page.manualControl,false);assert.equal(f.driver.manualPauses.has(f.page.id),false);assert.equal(reconciled,1);
  assert.equal(wireActions(f).length,0);assert.equal(f.actions.includes('send'),false);
});

for(const changed of ['thread','account','request'])test('failed-pause reconciliation cannot release a different '+changed,async t=>{
  const f=fixture(t),failure=Error('original pause unavailable');f.hooks.pause=async args=>{if(args.paused)throw failure;};
  f.manual();await assert.rejects(f.driver.persistManualPause(f.page),error=>error===failure);
  f.hooks.listResult=row=>changed==='thread'?{...row,thread_id:'other-thread'}:changed==='account'?{...row,account:'B'}:
    {...row,latest_request:{...row.latest_request,id:'other-request'}};
  f.driver.reconcileAll=async()=>assert.fail('foreign task cannot resume automatic observation');
  await assert.rejects(f.driver.resume(f.page,'original-request'),/原手动暂停尚未核对/);
  assert.deepEqual(f.calls.map(x=>x[0]),['pause','list']);assert.equal(f.page.manualControl,true);
  assert.equal(wireActions(f).length,0);assert.equal(f.actions.includes('send'),false);
});

test('a new manual key during failed-pause reconciliation keeps the newer hold without issuing resume',async t=>{
  const f=fixture(t),failure=Error('original pause unavailable'),gate=deferred(),entered=deferred();
  f.hooks.pause=async args=>{if(args.paused)throw failure;};f.manual();await assert.rejects(f.driver.persistManualPause(f.page),error=>error===failure);
  f.hooks.list=async()=>{entered.resolve();await gate.promise;};
  const resuming=f.driver.resume(f.page,'original-request');await entered.promise;f.manual();gate.resolve();
  await assert.rejects(resuming,error=>error.code==='manual_control'||/手动操作/.test(error.message));
  assert.deepEqual(f.calls.map(x=>x[0]),['pause','list']);assert.equal(f.page.manualControl,true);assert.equal(f.page.manualInteractionSequence,2);
  assert.equal(wireActions(f).length,0);assert.equal(f.actions.includes('send'),false);
});

test('an already-held first offer cannot change the public model or automatically dispatch',async t=>{
  const f=fixture(t);f.manual();await f.driver.tick(f.row);
  assert.equal(f.page.modelRestorePending,true);assert.equal(f.calls.some(x=>x[0]==='inspect'),false);assert.equal(f.actions.some(x=>/model|send|editor/.test(x)),false);
  assert.deepEqual(wireActions(f),[]);assert.equal(f.calls.filter(x=>x[0]==='pending-receipt').length,1);
});

test('a first offer observes a different public model instead of restoring the old task model',async t=>{
  const f=fixture(t);f.driver.inspect=async()=>({model:'GPT-6',effort:'High'});
  await f.driver.tick(f.row);
  assert.deepEqual(wireActions(f),['pulse']);assert.equal(f.actions.includes('send'),false);
  const issues=f.calls.filter(x=>x[0]==='page-issue');assert.equal(issues.length,1);assert.equal(issues[0][1].kind,'model_mismatch');
  assert.equal(f.row.effort,'Pro');assert.equal(f.page.modelRestorePending,true);
});

test('native typing while model observation awaits prevents any late dispatch',async t=>{
  const f=fixture(t),gate=deferred(),entered=deferred();f.hooks.inspect=async()=>{entered.resolve();await gate.promise;};
  const ticking=f.driver.tick(f.row);await entered.promise;f.manual();gate.resolve();await ticking;
  assert.deepEqual(wireActions(f),['pulse']);assert.equal(f.actions.includes('send'),false);assert.equal(f.driver.pending.has(f.page.id),false);
  assert.equal(f.calls.some(x=>x[0]==='page-issue'),false);assert.equal(f.driver.failures.size,0);
});

test('manual browsing another chat never returns to the task URL or pulses its queued requirement',async t=>{
  const f=fixture(t);f.setLocation('https://chatgpt.com/c/manual-chat');f.manual();
  f.driver.refresh=async()=>assert.fail('manual chat must remain visible');
  await f.driver.tick(f.row);assert.equal(f.page.view.webContents.getURL(),'https://chatgpt.com/c/manual-chat');
  assert.equal(f.row.url,'https://chatgpt.com/c/original');assert.deepEqual(wireActions(f),[]);assert.equal(f.sent,false);
});
