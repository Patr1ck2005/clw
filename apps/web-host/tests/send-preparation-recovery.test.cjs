'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {reconcileSendPreparation}=require('../send-preparation-recovery.cjs');
const hash=x=>createHash('sha256').update(x||'').digest('hex');
const attempt='control_'+'a'.repeat(32),marker=`[CLW:${attempt}]`,url='https://chatgpt.com/c/original';
function fixture(){
  const calls=[],hooks={},page={id:'page',account:'A',documentGeneration:2,view:{webContents:{getURL:()=>url,isDestroyed:()=>false}}};
  const row={page_id:'page',thread_id:'thread',account:'A',phase:'bound',root:'original-root',url,model:'gpt-6 · latest',effort:'pro',
    access:'write',write_paths:['.'],latest_request:{id:'request',phase:'processing',attempt_id:attempt}};
  const snapshot={url,editor:true,controlKnown:true,historyAtLatest:true,generating:false,composing:false,userId:'original-user',assistantId:'original-assistant',
    attemptMarker:'[CLW:control_'+'b'.repeat(32)+']',attemptMarkerCount:1};
  const composer={editorCount:1,text:'@Local-MCP',selected:[],visibleSelectedCount:0};
  const context={requireOpen(){hooks.context?.();},verifyOriginalPrepared:async()=>{calls.push('verify-original');hooks.prepared?.();}};
  const grant={authorized:true,state:'prepared_send_recovery_authorized',request_id:'request',attempt_id:attempt,prompt:'Original prepared continuation',
    prompt_hash:hash('Original prepared continuation'),previous_user_hash:hash(snapshot.userId),assistant_before_hash:hash(snapshot.assistantId)};
  const driver={records:new Map([[page.id,row]]),busy:new Set(),pending:new Map(),resultCandidates:new Map(),sendFailures:new Map(),failures:new Map(),
    connectionGeneration:1,runtime:{closed:false,call:async(op,payload)=>{calls.push(op);if(op==='prepared')return {prompt_hash:grant.prompt_hash,assistant_before_hash:grant.assistant_before_hash};hooks.authorize?.();assert.equal(payload.expected_attempt_id,attempt);
      assert.equal(payload.browser.composer.text_sha256,hash(composer.text));return grant;}},
    dom:async(_wc,op,arg)=>{calls.push(op);hooks[op]?.();if(op==='snapshot')return {...snapshot};if(op==='connector-state')return {...composer};
      assert.equal(op,'connector-clear-query');assert.equal(arg.expectedBaseline.userId,snapshot.userId);composer.text='';return {cleared:true};},
    inspect:async()=>({model:'GPT-6 · 最新',effort:'Pro'}),
    acceptedSendContext:async(_p,_s,binding)=>{calls.push('context');assert.deepEqual(binding,{request_id:'request',attempt_id:attempt,prompt_hash:grant.prompt_hash});return context;},
    send:async(_p,prompt,_s,sendMarker,ctx)=>{calls.push('send');assert.equal(ctx,context);assert.equal(prompt,grant.prompt+'\n'+marker);
      assert.equal(sendMarker,marker);assert.equal(composer.text,'');hooks.send?.();return {...snapshot,userId:'new-public-user',attemptMarker:marker};},
    pageState:s=>s,wire:async(_r,op,_s,data)=>{calls.push('wire-'+op);assert.equal(data.attempt_id,attempt);hooks.wire?.();return {state:'acknowledged'};}};
  const payload={id:'page',expected_connection_generation:1,expected_request_id:'request',expected_attempt_id:attempt,legacy_incident:'example-send-preparation'};
  return {page,row,driver,payload,composer,snapshot,calls,hooks,grant,run:()=>reconcileSendPreparation({driver,page,payload,operationId:'original-operation',assertCurrent(){hooks.identity?.();}})};
}
test('reconciled original preparation sends and acknowledges the same accepted attempt once without dispatching again',async()=>{
  const f=fixture(),result=await f.run();assert.equal(result.state,'original_prepared_send_confirmed');assert.equal(result.attempt_id,attempt);
  assert.equal(f.calls.filter(x=>x==='send').length,1);assert.equal(f.calls.filter(x=>x==='wire-sent').length,1);
  assert.equal(f.calls.includes('wire-dispatch'),false);assert.ok(f.calls.indexOf('reconcile-send-preparation')<f.calls.indexOf('connector-clear-query'));
  assert.equal(f.driver.busy.size,0);assert.equal(f.driver.pending.get('page').attempt,attempt);
});
test('a repeated original authorization receipt cannot clear or send again',async()=>{
  const f=fixture();f.grant.authorized=false;const result=await f.run();assert.equal(result.model_sends,0);
  assert.equal(f.calls.includes('connector-clear-query'),false);assert.equal(f.calls.includes('send'),false);
});
for(const change of ['draft','generation','marker','pause','foreign-attempt','model'])test('recovery preserves '+change+' before any authorization or composer edit',async()=>{
  const f=fixture();if(change==='draft')f.composer.text='my own draft';if(change==='generation')f.snapshot.generating=true;
  if(change==='marker')f.snapshot.attemptMarker=marker;if(change==='pause')f.row.paused=true;
  if(change==='foreign-attempt')f.row.latest_request.attempt_id='control_'+'c'.repeat(32);
  if(change==='model')f.driver.inspect=async()=>({model:'GPT-5.6 Sol',effort:'Pro'});
  await assert.rejects(f.run());assert.equal(f.calls.includes('reconcile-send-preparation'),false);assert.equal(f.calls.includes('send'),false);
  assert.equal(f.calls.includes('connector-clear-query'),false);assert.equal(f.driver.busy.size,0);
});
test('an identity change after authorization preserves the owned query and never invokes Send',async()=>{
  const f=fixture();f.hooks.authorize=()=>{f.row.latest_request.id='foreign-request';};
  await assert.rejects(f.run(),/identity_changed/);assert.equal(f.calls.includes('connector-clear-query'),false);assert.equal(f.calls.includes('send'),false);
});
test('a late public turn after original grant verification does not clear or send',async()=>{
  const f=fixture();f.driver.acceptedSendContext=async()=>{f.snapshot.userId='foreign-turn';return {requireOpen(){},verifyOriginalPrepared:async()=>{}};};
  await assert.rejects(f.run(),/public_baseline_changed/);assert.equal(f.calls.includes('connector-clear-query'),false);assert.equal(f.calls.includes('send'),false);
});
test('an unknown Send return retains original pending attempt and never retries',async()=>{
  const f=fixture();f.hooks.send=()=>{throw Error('unknown-send-return');};await assert.rejects(f.run(),/unknown-send-return/);
  assert.equal(f.calls.filter(x=>x==='send').length,1);assert.equal(f.driver.pending.get('page').attempt,attempt);
  assert.equal(f.calls.includes('wire-sent'),false);
  f.driver.sendFailures.set('page',{send_invoked:true,known_not_sent:false});delete f.payload.legacy_incident;
  await assert.rejects(f.run(),/preclick_proof_missing/);assert.equal(f.calls.filter(x=>x==='send').length,1);
});
test('an unknown sent receipt does not invoke a second Send',async()=>{
  const f=fixture();f.hooks.wire=()=>{throw Error('unknown-wire-return');};await assert.rejects(f.run(),/unknown-wire-return/);
  assert.equal(f.calls.filter(x=>x==='send').length,1);assert.equal(f.driver.pending.get('page').attempt,attempt);
});
test('recovery accepts an empty composer after owned renderer reload while preserving the exact prepared grant',async()=>{
  const f=fixture();f.composer.text='';assert.equal((await f.run()).state,'original_prepared_send_confirmed');
  assert.equal(f.calls.includes('connector-clear-query'),false);assert.equal(f.calls.filter(x=>x==='send').length,1);
});
test('caller-supplied arbitrary preparation proof is not an App API argument',async()=>{
  const f=fixture();f.payload.proof={send_invoked:false};await assert.rejects(f.run(),/recovery_invalid/);assert.deepEqual(f.calls,[]);
});
test('same original pending entry requires positive fresh pre-click proof and keeps its accepted attempt',async()=>{
  const f=fixture();f.driver.pending.set('page',{attempt});delete f.payload.legacy_incident;
  f.driver.sendFailures.set('page',{send_invoked:false,known_not_sent:true,request_id:'request',attempt_id:attempt,account:'A',url,
    document_generation:2,connection_generation:1,user_turn_sha256:hash('original-user'),assistant_turn_sha256:hash('original-assistant')});
  assert.equal((await f.run()).state,'original_prepared_send_confirmed');assert.equal(f.calls.filter(x=>x==='send').length,1);
});
test('foreign pending attempt is preserved before any public input or authorization',async()=>{
  const f=fixture();f.driver.pending.set('page',{attempt:'control_'+'c'.repeat(32)});
  await assert.rejects(f.run(),/original_operation_pending/);assert.deepEqual(f.calls,[]);
});
test('a positively failed query cleanup records a fresh pre-click proof after authorization for bounded original recovery',async()=>{
  const f=fixture();f.hooks['connector-clear-query']=()=>{throw Error('editor_focus_failed');};
  await assert.rejects(f.run(),/editor_focus_failed/);assert.equal(f.calls.includes('send'),false);
  const proof=f.driver.sendFailures.get('page');assert.equal(proof.known_not_sent,true);assert.equal(proof.send_invoked,false);
  assert.equal(proof.stage,'recovery-preparation');assert.equal(proof.attempt_id,attempt);assert.equal(proof.thread_id,'thread');
});
test('a changed user draft during failed query cleanup cannot acquire a new pre-click recovery proof',async()=>{
  const f=fixture();f.hooks['connector-clear-query']=()=>{f.composer.text='new user draft';throw Error('editor_focus_failed');};
  await assert.rejects(f.run(),/editor_focus_failed/);assert.equal(f.calls.includes('send'),false);assert.equal(f.driver.sendFailures.has('page'),false);
});
test('a legacy failed-turn reload reconciles its changed preparation baseline before verifying the original accepted grant',async()=>{
  const f=fixture(),call=f.driver.runtime.call;
  f.driver.runtime.call=async(op,payload)=>{
    if(op==='prepared'){f.calls.push(op);return {prompt_hash:f.grant.prompt_hash,assistant_before_hash:hash('old-viewport-assistant')};}
    assert.equal(payload.browser.baseline_previous_marker,f.snapshot.attemptMarker);assert.equal(payload.browser.baseline_previous_marker_count,1);
    assert.equal(payload.browser.complete,false);assert.equal(payload.browser.failure,'无法思考');return call(op,payload);
  };
  f.snapshot.complete=false;f.snapshot.failure='无法思考';
  assert.equal((await f.run()).state,'original_prepared_send_confirmed');
  assert.ok(f.calls.indexOf('reconcile-send-preparation')<f.calls.indexOf('context'));assert.equal(f.calls.filter(x=>x==='send').length,1);
});
test('a nonlegacy changed assistant preparation baseline never receives a rebase authorization or Send',async()=>{
  const f=fixture(),call=f.driver.runtime.call;delete f.payload.legacy_incident;
  f.driver.sendFailures.set('page',{send_invoked:false,known_not_sent:true,request_id:'request',attempt_id:attempt,account:'A',url,
    document_generation:2,connection_generation:1,user_turn_sha256:hash('original-user'),assistant_turn_sha256:hash('original-assistant')});
  f.driver.runtime.call=async(op,payload)=>op==='prepared'?{prompt_hash:f.grant.prompt_hash,assistant_before_hash:hash('old-assistant')}:call(op,payload);
  await assert.rejects(f.run(),/public_baseline_changed/);assert.equal(f.calls.includes('reconcile-send-preparation'),false);assert.equal(f.calls.includes('send'),false);
});
