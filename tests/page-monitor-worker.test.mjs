import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';

const source=fs.readFileSync(new URL('../apps/web-recovery-companion/page-monitor-worker.js',import.meta.url),'utf8');
const CHAT='https://chatgpt.com/c/12345678-1234-1234-1234-123456789012';
const OTHER='https://chatgpt.com/g/project-one/c/23456789-1234-1234-1234-123456789012';
const EXT='chrome-extension://'+'a'.repeat(32)+'/';
const PROMPT='继续原任务。先核对已有成果和在途作业，从未完成处继续，完成当前所有可推进的工作。';
const h=n=>n.toString(16).padStart(64,'0');
const clone=x=>structuredClone(x);
const popup={url:EXT+'popup.html'};
const snapshot=(patch={})=>({user_key:h(1),assistant_key:h(2),failure_key:'',kind:'idle',controls_known:true,generating:false,draft:false,focused:false,composing:false,online:true,blocked:false,stopped:false,continuation_seen:false,...patch});

function runtime(existing={}){
  const session=existing.session||new Map(),local=existing.local||new Map(),clock=existing.clock||{value:1000000},uuid=existing.uuid||{value:0};
  const tabs=existing.tabs||new Map([[7,{id:7,url:CHAT}],[8,{id:8,url:CHAT}],[9,{id:9,url:OTHER}]]);
  const failures=[],ops=[],network=[];
  const maybeFail=(area,method)=>{const i=failures.findIndex(x=>x.area===area&&x.method===method);if(i>=0){failures.splice(i,1);throw Error('mock_'+area+'_'+method+'_failed');}};
  const store=(area,values)=>({
    async get(keys){ops.push([area,'get',clone(keys)]);maybeFail(area,'get');await Promise.resolve();return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>values.has(k)).map(k=>[k,clone(values.get(k))]));},
    async set(obj){ops.push([area,'set',clone(obj)]);maybeFail(area,'set');await Promise.resolve();for(const [k,v] of Object.entries(obj))values.set(k,clone(v));},
    async remove(keys){ops.push([area,'remove',clone(keys)]);maybeFail(area,'remove');await Promise.resolve();for(const k of Array.isArray(keys)?keys:[keys])values.delete(k);},
  });
  class FakeDate extends Date{static now(){return clock.value;}}
  const ctx=vm.createContext({
    TextEncoder,Uint8Array,Date:FakeDate,
    crypto:{subtle:webcrypto.subtle,randomUUID:()=>`11111111-2222-4333-8444-${(++uuid.value).toString(16).padStart(12,'0')}`},
    chrome:{storage:{session:store('session',session),local:store('local',local)},runtime:{getURL:p=>EXT+p},tabs:{async get(id){ops.push(['tabs','get',id]);if(!tabs.has(id))throw Error('tab_not_found');return clone(tabs.get(id));}}},
    fetch:(...args)=>{network.push(args);throw Error('unexpected_network');},
    XMLHttpRequest:class{constructor(){throw Error('unexpected_network');}},
  });
  vm.runInContext(source,ctx);
  const worker=ctx.CLWPageMonitorWorker;
  const r={session,local,clock,uuid,tabs,worker,ops,network,failures,
    generation:id=>session.get('clwPageMonitorTab:'+id)?.generation,
    advance:ms=>{clock.value+=ms;},
    start:(id=7,url=tabs.get(id)?.url)=>worker.handle({type:'monitor-start',tabId:id,chatUrl:url,confirm:true},popup),
    status:(id=7,url=tabs.get(id)?.url)=>worker.handle({type:'monitor-status',tabId:id,chatUrl:url},popup),
    stop:(id=7)=>worker.handle({type:'monitor-stop',tabId:id,chatUrl:tabs.get(id)?.url},popup),
    message:(type,extra={},senderPatch={},id=7)=>worker.handle({type,generation:r.generation(id),...extra},{tab:clone(tabs.get(id)),url:tabs.get(id)?.url,frameId:0,documentId:'doc-a',...senderPatch}),
    observe:(s=snapshot(),senderPatch={},id=7)=>r.message('monitor-observe',{snapshot:s},senderPatch,id),
    journal:()=>clone([...local.entries()].find(([k])=>k.startsWith('clwPageMonitorJournal:'))?.[1]),
    recreate:()=>runtime({session,local,clock,uuid,tabs}),
  };
  return r;
}

async function due(r,s=snapshot({kind:'cannot_think',failure_key:h(3)}),delay=15000){
  const scheduled=await r.observe(s);assert.equal(scheduled.state,'backoff');assert.equal(scheduled.offer,undefined);
  r.advance(delay-1);assert.equal((await r.observe(s)).offer,undefined);
  r.advance(1);const observed=await r.observe(s);assert.equal(observed.offer.prompt,PROMPT);
  return {s,offer:observed.offer};
}
async function grant(r,planned){
  return r.message('monitor-dispatch',{attempt_id:planned.offer.attempt_id,snapshot:planned.s});
}
async function attached(){const r=runtime();await r.start();await r.observe();return r;}
test('saved historical watching state is not reported as a live monitor after session bindings disappear',async()=>{
  const r=await attached(),cold=runtime({session:new Map(),local:r.local,clock:r.clock,uuid:r.uuid,tabs:r.tabs});
  const status=await cold.status();assert.equal(status.state,'unbound');assert.equal(status.observer_recent,false);assert.equal(status.bound,false);assert.equal(cold.journal().state,'watching');
});
const waitingProgress=(patch={})=>snapshot({kind:'connection_wait',generating:true,progress_key:h(500),...patch});
async function reloadDue(r,s=waitingProgress(),documentId='doc-a'){
  assert.equal((await r.observe(s,{documentId})).reload,undefined);
  r.advance(179999);assert.equal((await r.observe(s,{documentId})).reload,undefined);
  r.advance(1);const out=await r.observe(s,{documentId});assert.ok(out.reload);return out;
}
async function completedChain(r,count=3){
  let user=r.journal().expected_user;
  for(let i=0;i<count;i++){
    const p=await due(r,snapshot({user_key:user,assistant_key:h(20+i),failure_key:h(30+i),kind:'cannot_think'}),[15000,45000,120000][i]);
    const sent=await grant(r,p);await r.message('monitor-finish',{attempt_id:sent.attempt_id,result:'clicked'});
    user=h(10+i);await r.observe(snapshot({user_key:user,kind:'generating',generating:true,continuation_seen:true}));
  }
  return user;
}

test('module import is passive, including legacy mocks without local storage',()=>{
  const ctx=vm.createContext({chrome:{storage:{session:{}}}});vm.runInContext(source,ctx);
  assert.equal(ctx.CLWPageMonitorWorker.PROMPT,PROMPT);assert.equal(typeof ctx.CLWPageMonitorWorker.handle,'function');
});
test('manual Pro chat can start without model, task enrollment, host, or network',async()=>{
  const r=runtime();assert.equal(r.ops.length,0);
  const out=await r.start();assert.equal(out.started,true);assert.match(out.generation,/^[0-9a-f-]{36}$/);assert.equal(await r.worker.isBound(7),true);
  await r.observe();const sent=await grant(r,await due(r));assert.equal(sent.dispatch,true);assert.equal(sent.prompt,PROMPT);assert.equal(sent.attempts,1);
  assert.equal(r.network.length,0);assert.ok(!/CLWControlPolicy|model_label|effort_label|fetch\(|XMLHttpRequest|127\.0\.0\.1/.test(source));
});
test('status reads and finish writes do not make stale observations look healthy',async()=>{
  const r=runtime(),started=await r.start();assert.equal(started.updated_at,null);assert.equal(started.observer_recent,false);
  await r.observe();const p=await due(r),observedAt=r.clock.value;assert.equal((await r.status()).observer_recent,true);
  const out=await grant(r,p);r.advance(45001);await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'clicked'});
  const stale=await r.status();assert.equal(stale.updated_at,observedAt);assert.equal(stale.state_updated_at,r.clock.value);assert.equal(stale.observer_recent,false);
  r.advance(3000);assert.equal((await r.status()).updated_at,observedAt);assert.equal((await r.observe(p.s)).observer_recent,true);
});
test('status and stop accept only an optional true popup confirmation',async()=>{
  const r=runtime();await r.start();
  assert.equal((await r.worker.handle({type:'monitor-status',tabId:7,chatUrl:CHAT,confirm:true},popup)).bound,true);
  await assert.rejects(r.worker.handle({type:'monitor-status',tabId:7,chatUrl:CHAT,confirm:false},popup),/message_invalid/);
  assert.equal((await r.worker.handle({type:'monitor-stop',tabId:7,chatUrl:CHAT,confirm:true},popup)).stopped,true);
});
test('only extension popup can start, status, or stop an exact current conversation',async()=>{
  const r=runtime();
  for(const type of ['monitor-start','monitor-status','monitor-stop']){
    const m={type,tabId:7,chatUrl:CHAT,...(type==='monitor-start'?{confirm:true}:{})};
    for(const sender of [{url:EXT+'foreign.html'},{url:CHAT},{...popup,tab:{id:7,url:CHAT}}])await assert.rejects(r.worker.handle(m,sender),/monitor_explicit_popup_required/);
  }
  await assert.rejects(r.worker.handle({type:'monitor-start',tabId:7,chatUrl:CHAT,confirm:false},popup),/confirmation/);
  for(const url of [CHAT+'?x=1',CHAT+'#fragment',CHAT+'/',CHAT.replace('chatgpt.com','chatgpt.com.evil.test'),'https://chatgpt.com/','https://chatgpt.com/c/short'])await assert.rejects(r.start(7,url),/exact_chat_required/);
  await assert.rejects(r.start(7,OTHER),/tab_changed/);
  r.tabs.get(7).pendingUrl=OTHER;await assert.rejects(r.start(),/tab_changed/);
  assert.equal(r.session.size,0);
});
test('content requires exact tab URL, top frame, document, and generation',async()=>{
  const r=await attached();
  for(const patch of [{frameId:1},{documentId:''},{documentId:undefined},{url:OTHER},{tab:{id:7,url:OTHER}},{documentId:'doc-b'}])await assert.rejects(r.observe(snapshot(),patch),/monitor_(top_document_required|binding_mismatch|document_changed)/);
  await assert.rejects(r.message('monitor-observe',{generation:'11111111-2222-4333-8444-999999999999',snapshot:snapshot()}),/binding_mismatch/);
  r.tabs.get(7).url=OTHER;await assert.rejects(r.observe(),/binding_mismatch|tab_changed/);
});
test('first terminal failure is recorded as an old baseline and never sent',async()=>{
  const r=runtime();await r.start();const s=snapshot({kind:'cannot_think',failure_key:h(3)});
  assert.equal((await r.observe(s)).reason,'initial_snapshot_observed');r.advance(999999);
  const out=await r.observe(s);assert.equal(out.reason,'existing_failure_observed');assert.equal(out.offer,undefined);assert.equal(out.attempts,0);
  assert.equal(r.journal().baseline_failure,h(3));
});
test('incomplete initial DOM waits for controls and a real user without consuming the baseline',async()=>{
  const r=runtime();await r.start();
  for(const patch of [{controls_known:false,user_key:''},{controls_known:false,user_key:h(1)},{controls_known:true,user_key:''}]){
    const out=await r.observe(snapshot({kind:'unsupported',assistant_key:'',...patch}));
    assert.equal(out.state,'waiting');assert.equal(out.reason,'controls_unknown');assert.equal(out.observer_recent,false);assert.equal(out.offer,undefined);
    assert.equal(r.session.get('clwPageMonitorTab:7').baseline_pending,true);assert.equal(r.journal().expected_user,'');assert.equal(r.journal().pending,null);
  }
  const attached=await r.observe(snapshot({kind:'generating',generating:true}));
  assert.equal(attached.reason,'initial_snapshot_observed');assert.equal(attached.state,'watching');assert.equal(attached.observer_recent,true);
  assert.equal(r.session.get('clwPageMonitorTab:7').baseline_pending,false);assert.equal(r.journal().expected_user,h(1));
  assert.equal((await grant(r,await due(r))).dispatch,true);
});
test('first real terminal failure after incomplete DOM still becomes an old failure baseline',async()=>{
  const r=runtime();await r.start();await r.observe(snapshot({kind:'unsupported',controls_known:false,user_key:''}));
  const s=snapshot({kind:'connection_lost',failure_key:h(3)});await r.observe(s);r.advance(999999);
  const out=await r.observe(s);assert.equal(out.reason,'existing_failure_observed');assert.equal(out.offer,undefined);assert.equal(out.attempts,0);
  assert.equal(r.journal().baseline_failure,h(3));
});
test('generating connection banner becomes eligible only after generation terminates',async()=>{
  const r=runtime();await r.start();await r.observe(snapshot({kind:'generating',generating:true,failure_key:h(3)}));
  assert.equal(r.journal().baseline_failure,'');r.advance(3600000);
  const out=await r.observe(snapshot({kind:'connection_lost',failure_key:h(3)}));assert.equal(out.state,'backoff');assert.equal(out.next_retry_at,r.clock.value+15000);
});
test('ordinary long reasoning, idle, and unsupported snapshots never schedule',async()=>{
  const r=await attached();
  for(const s of [snapshot(),snapshot({kind:'generating',generating:true}),snapshot({kind:'unsupported',controls_known:false})]){
    r.advance(86400000);const out=await r.observe(s);assert.equal(out.offer,undefined);assert.equal(out.attempts,0);assert.equal(r.journal().pending,null);
  }
});
test('connection wait is a waiting baseline with or without a physical Stop and never consumes a grant',async()=>{
  for(const generating of [true,false]){
    const r=runtime();await r.start();const since=r.clock.value;
    const s=snapshot({kind:'connection_wait',generating,failure_key:h(3)});
    const initial=await r.observe(s);assert.equal(initial.state,'waiting');assert.equal(initial.reason,'connection_wait');
    assert.equal(initial.connection_wait_since,since);assert.equal(initial.connection_wait_ms,0);assert.equal(initial.observer_recent,true);
    assert.equal(r.journal().baseline_failure,'');assert.equal(r.journal().connection_wait_since,since);
    r.advance(89999);const short=await r.observe(s);assert.equal(short.reason,'connection_wait');assert.equal(short.connection_wait_ms,89999);
    r.advance(1);const prolonged=await r.observe(s);assert.equal(prolonged.state,'waiting');assert.equal(prolonged.reason,'connection_wait_long');
    assert.equal(prolonged.connection_wait_since,since);assert.equal(prolonged.connection_wait_ms,90000);assert.equal(prolonged.offer,undefined);
    assert.equal(prolonged.attempts,0);assert.equal(r.journal().pending,null);assert.deepEqual(r.journal().used_failures,[]);
    await assert.rejects(r.message('monitor-dispatch',{attempt_id:'11111111-2222-4333-8444-999999999999',snapshot:s}),/dispatch_not_permitted/);
    assert.equal(r.network.length,0);
  }
});
test('connection wait preserves an original plan but never grants it, even after a long wait',async()=>{
  for(const generating of [true,false]){
    const r=await attached(),p=await due(r),pending=r.journal().pending;
    const s={...p.s,kind:'connection_wait',generating};const since=r.clock.value;
    assert.equal((await r.observe(s)).reason,'connection_wait');r.advance(120000);
    const long=await r.observe(s);assert.equal(long.reason,'connection_wait_long');assert.equal(long.state,'waiting');assert.equal(long.offer,undefined);
    assert.equal(long.connection_wait_since,since);assert.deepEqual(r.journal().pending,pending);
    assert.equal(r.journal().retry_count,0);assert.deepEqual(r.journal().used_failures,[]);
    await assert.rejects(r.message('monitor-dispatch',{attempt_id:p.offer.attempt_id,snapshot:s}),/dispatch_not_permitted/);
    assert.deepEqual(r.journal().pending,pending);
    const failed=await r.observe(p.s);assert.equal(failed.reason,'retry_due');assert.equal(failed.offer.attempt_id,p.offer.attempt_id);
    assert.equal(failed.connection_wait_since,null);assert.equal(failed.connection_wait_ms,0);assert.equal((await grant(r,p)).attempts,1);
  }
});
test('repeated observations, worker reconstruction, and explicit rebind retain the connection wait start',async()=>{
  const r=await attached(),s=snapshot({kind:'connection_wait',generating:true});const since=r.clock.value;
  await r.observe(s);r.advance(30000);assert.equal((await r.observe(s)).connection_wait_since,since);
  const next=r.recreate();r.advance(30000);const status=await next.status();assert.equal(status.connection_wait_since,since);assert.equal(status.connection_wait_ms,60000);
  assert.equal((await next.observe(s)).connection_wait_since,since);await next.start();r.advance(30000);
  const rebound=await next.observe(s);assert.equal(rebound.state,'waiting');assert.equal(rebound.reason,'connection_wait_long');
  assert.equal(rebound.connection_wait_since,since);assert.equal(rebound.connection_wait_ms,90000);assert.equal(rebound.attempts,0);
});
test('connection wait timing survives unsupported or offline DOM and clears on recognized progress',async()=>{
  const r=await attached(),s=snapshot({kind:'connection_wait',generating:true});const since=r.clock.value;
  await r.observe(s);r.advance(30000);
  const loading=await r.observe(snapshot({kind:'unsupported',controls_known:false}));assert.equal(loading.reason,'controls_unknown');assert.equal(loading.connection_wait_since,since);
  r.advance(30000);const offline=await r.observe(snapshot({kind:'offline',online:false}));assert.equal(offline.reason,'offline');assert.equal(offline.connection_wait_since,since);
  r.advance(30000);const waiting=await r.observe(s);assert.equal(waiting.reason,'connection_wait_long');assert.equal(waiting.connection_wait_ms,90000);
  const thinking=await r.observe(snapshot({kind:'generating',generating:true}));assert.equal(thinking.reason,'generating');assert.equal(thinking.connection_wait_since,null);assert.equal(thinking.connection_wait_ms,0);
  r.advance(5000);const freshWait=await r.observe(s);assert.equal(freshWait.reason,'connection_wait');assert.equal(freshWait.connection_wait_since,r.clock.value);
  const idle=await r.observe();assert.equal(idle.state,'watching');assert.equal(idle.connection_wait_since,null);
  await r.observe(s);const failure=await r.observe(snapshot({kind:'cannot_think',failure_key:h(3)}));
  assert.equal(failure.state,'backoff');assert.equal(failure.next_retry_at,r.clock.value+15000);assert.equal(failure.connection_wait_since,null);
});
test('connection wait never masks in-flight, clicked, or unknown delivery or replays their grants',async()=>{
  for(const result of [null,'clicked','unknown']){
    const r=await attached(),p=await due(r),sent=await grant(r,p);
    if(result)await r.message('monitor-finish',{attempt_id:sent.attempt_id,result});
    const pending=r.journal().pending,s={...p.s,kind:'connection_wait',generating:true};
    const first=await r.observe(s);assert.equal(first.state,result||'dispatching');assert.equal(first.reason,'waiting_delivery_confirmation');
    r.advance(90000);const long=await r.observe(s);assert.equal(long.state,result||'dispatching');assert.equal(long.offer,undefined);assert.equal(long.attempts,1);
    assert.equal(long.connection_wait_ms,90000);assert.deepEqual(r.journal().pending,pending);
    await assert.rejects(grant(r,p),/dispatch_not_permitted/);await assert.rejects(r.start(),/delivery_unresolved/);
  }
});
test('manual pause, explicit Stop, and a new manual turn take precedence over connection wait',async()=>{
  const s=snapshot({kind:'connection_wait',generating:true});
  for(const action of ['gesture','stopped','manual']){
    const r=await attached(),p=await due(r);
    if(action==='gesture')await r.message('monitor-gesture');
    const waiting=await r.observe({...s,...(action==='stopped'?{stopped:true}:action==='manual'?{user_key:h(9)}:{})});
    assert.equal(waiting.state,'paused');assert.equal(waiting.reason,{gesture:'manual_gesture',stopped:'user_stopped',manual:'manual_takeover'}[action]);
    r.advance(90000);const long=await r.observe(s);assert.equal(long.state,'paused');assert.notEqual(long.reason,'connection_wait_long');assert.equal(long.offer,undefined);
    assert.equal(r.journal().pending,null);await assert.rejects(grant(r,p),/dispatch_not_permitted/);
  }
  const r=runtime();await r.start();const stopped=await r.observe({...s,stopped:true});assert.equal(stopped.state,'paused');assert.equal(stopped.reason,'user_stopped');
});
test('a legacy 0.6.0 journal is normalized and persisted without changing counters or pending work',async()=>{
  for(const withWaitField of [false,true])for(const phase of ['planned','dispatching','clicked','unknown']){
    const r=await attached(),p=await due(r);
    if(phase!=='planned'){
      const sent=await grant(r,p);
      if(phase!=='dispatching')await r.message('monitor-finish',{attempt_id:sent.attempt_id,result:phase});
    }
    const [key]=r.local.keys(),legacy=r.journal();
    for(const field of ['last_progress_key','last_progress_at','reload_wait_since','reload_count','reload'])delete legacy[field];
    if(!withWaitField)delete legacy.connection_wait_since;r.local.set(key,legacy);
    const next=r.recreate(),out=await next.status();assert.equal(out.attempts,legacy.retry_count);assert.equal(out.pending_result,phase);
    assert.equal(out.connection_wait_since,null);assert.equal(out.connection_wait_ms,0);
    const migrated=next.journal();assert.deepEqual(migrated,{...legacy,connection_wait_since:null,last_progress_key:'',last_progress_at:null,reload_wait_since:null,reload_count:0,reload:null});
    assert.deepEqual(migrated.pending,legacy.pending);assert.deepEqual(migrated.used_failures,legacy.used_failures);assert.equal(migrated.expected_user,legacy.expected_user);
  }
});
test('legacy snapshots without a progress key can never request a reload',async()=>{
  const r=await attached(),s=snapshot({kind:'connection_wait',generating:true});
  await r.observe(s);r.advance(86400000);const out=await r.observe(s);
  assert.equal(out.reload,undefined);assert.equal(out.reload_count,0);assert.equal(out.reload_wait_since,null);assert.equal(r.journal().last_progress_at,null);
  assert.equal(await r.worker.resumeAfterReload(7),null);
});
test('an unchanged safe connection wait durably grants one native reload at exactly 180 seconds',async()=>{
  for(const generating of [true,false]){
    const r=runtime();await r.start();const oldGeneration=r.generation(7),since=r.clock.value,s=waitingProgress({generating});
    const first=await r.observe(s);assert.equal(first.state,'waiting');assert.equal(first.last_progress_at,since);assert.equal(first.reload_wait_since,since);
    r.advance(179999);assert.equal((await r.observe(s)).reload,undefined);r.advance(1);
    const out=await r.observe(s);assert.equal(out.reason,'reload_requested');assert.equal(out.state,'waiting');assert.equal(out.attempts,0);assert.equal(out.reload_count,1);
    assert.equal(out.reload.tabId,7);assert.equal(out.reload.chatUrl,CHAT);assert.notEqual(out.reload.generation,oldGeneration);assert.equal(out.reload.generation,r.generation(7));
    assert.equal(r.session.get('clwPageMonitorTab:7').documentId,null);assert.equal(r.session.get('clwPageMonitorTab:7').baseline_pending,false);
    assert.deepEqual(r.journal().reload,{tab_id:7,generation:out.reload.generation,old_document_id:'doc-a',requested_at:r.clock.value,state:'requested'});
    assert.equal(r.journal().pending,null);assert.deepEqual(r.journal().used_failures,[]);
    await assert.rejects(r.message('monitor-observe',{generation:oldGeneration,snapshot:s}),/binding_mismatch/);
    assert.equal((await r.status()).reload,undefined);assert.equal(r.network.length,0);
  }
});
test('changed progress restarts the stall duration without consuming or resetting any reload count',async()=>{
  const r=await attached(),s=waitingProgress();await r.observe(s);const firstProgressAt=r.journal().last_progress_at;
  r.advance(179999);assert.equal((await r.observe(s)).last_progress_at,firstProgressAt);
  const changed=waitingProgress({progress_key:h(501)}),progress=await r.observe(changed);assert.equal(progress.last_progress_at,r.clock.value);assert.equal(progress.reload_wait_ms,0);
  r.advance(179999);assert.equal((await r.observe(changed)).reload,undefined);r.advance(1);
  assert.ok((await r.observe(changed)).reload);assert.equal(r.journal().reload_count,1);
});
test('offline, unknown controls, drafts, focus, composition, or blocking break a continuous safe stall',async()=>{
  for(const patch of [{online:false},{kind:'offline',online:false},{kind:'unsupported',controls_known:false},{controls_known:false},{draft:true},{focused:true},{composing:true},{blocked:true}]){
    const r=await attached(),s=waitingProgress();await r.observe(s);r.advance(179999);
    const unsafe={...s,...patch};assert.equal((await r.observe(unsafe)).reload,undefined);assert.equal(r.journal().reload_wait_since,null);
    r.advance(500000);assert.equal((await r.observe(unsafe)).reload,undefined);
    const safe=await r.observe(s);assert.equal(safe.reload_wait_since,r.clock.value);assert.equal(safe.reload,undefined);
    r.advance(180000);assert.ok((await r.observe(s)).reload);
  }
});
test('Stop, manual pause, and changed user prohibit automatic reload',async()=>{
  for(const action of ['stopped','gesture','user']){
    const r=await attached(),s=waitingProgress();await r.observe(s);r.advance(180000);
    if(action==='gesture')await r.message('monitor-gesture');
    const out=await r.observe({...s,...(action==='stopped'?{stopped:true}:action==='user'?{user_key:h(90)}:{})});
    assert.equal(out.state,'paused');assert.equal(out.reload,undefined);assert.equal(out.reload_count,0);assert.equal(r.journal().reload_wait_since,null);
    r.advance(180000);assert.equal((await r.observe(s)).reload,undefined);
  }
});
test('planned sends and every unresolved send phase prohibit reload without altering the send ledger',async()=>{
  for(const phase of ['planned','dispatching','clicked','unknown']){
    const r=await attached(),p=await due(r);
    if(phase!=='planned'){
      const sent=await grant(r,p);if(phase!=='dispatching')await r.message('monitor-finish',{attempt_id:sent.attempt_id,result:phase});
    }
    const before=r.journal(),s=waitingProgress();await r.observe(s);r.advance(180000);const out=await r.observe(s);
    assert.equal(out.reload,undefined);assert.equal(out.reload_count,0);assert.equal(out.attempts,before.retry_count);assert.deepEqual(r.journal().pending,before.pending);assert.deepEqual(r.journal().used_failures,before.used_failures);
  }
});
test('reload request receipts and worker reconstruction never replay the native effect',async()=>{
  for(const receipt of [null,'requested','unknown','failed']){
    const r=await attached(),out=await reloadDue(r),generation=out.reload.generation;
    if(receipt)await r.worker.finishReload(7,generation,receipt);
    const next=r.recreate(),status=await next.status();assert.equal(status.reload,undefined);assert.equal(status.reload_count,1);assert.equal(next.journal().reload.state,receipt||'requested');
    next.tabs.get(7).status='loading';assert.equal(await next.worker.resumeAfterReload(7),null);
    next.tabs.get(7).status='complete';const resume=await next.worker.resumeAfterReload(7);
    if(receipt==='failed'){assert.equal(resume,null);assert.equal(status.state,'paused');assert.equal(status.reason,'reload_failed');}
    else {assert.equal(resume.generation,generation);assert.equal(resume.reload,undefined);assert.equal((await next.worker.resumeAfterReload(7)).generation,generation);}
    if(receipt==='unknown'){
      await next.worker.finishReload(7,generation,'requested');assert.equal(next.journal().reload.state,'unknown');
    }
    assert.equal(next.journal().retry_count,0);
  }
});
test('resuming an owned reload requires its original exact tab, completed navigation, and no manual pause',async()=>{
  const r=await attached();await reloadDue(r);r.tabs.get(7).status='complete';
  assert.equal(await r.worker.resumeAfterReload(8),null);await assert.rejects(r.start(8),/duplicate_url_owner/);
  r.tabs.get(7).pendingUrl=OTHER;await assert.rejects(r.worker.resumeAfterReload(7),/tab_changed/);delete r.tabs.get(7).pendingUrl;
  r.tabs.get(7).url=OTHER;await assert.rejects(r.worker.resumeAfterReload(7),/tab_changed/);r.tabs.get(7).url=CHAT;
  await r.message('monitor-gesture');assert.equal(await r.worker.resumeAfterReload(7),null);assert.equal(r.journal().reload_count,1);
  await r.stop();assert.equal(await r.worker.resumeAfterReload(7),null);assert.equal(r.journal().reload_count,1);
});
test('an old document cannot confirm its own reload and cannot get a second reload',async()=>{
  const r=await attached(),out=await reloadDue(r);r.tabs.get(7).status='complete';assert.equal((await r.worker.resumeAfterReload(7)).generation,out.reload.generation);
  const same=await r.observe(waitingProgress());assert.equal(same.state,'paused');assert.equal(same.reason,'reload_not_confirmed');assert.equal(same.reload,undefined);
  assert.equal(r.journal().reload_count,1);assert.notEqual(r.journal().reload,null);r.advance(86400000);
  assert.equal((await r.observe(waitingProgress())).reload,undefined);assert.equal(await r.worker.resumeAfterReload(7),null);
});
test('a verified new document retains original user and failure baseline, then applies ordinary terminal-failure backoff',async()=>{
  const r=await attached(),before=r.journal();await reloadDue(r);const s=snapshot({kind:'cannot_think',failure_key:h(600),progress_key:h(501)});
  const out=await r.observe(s,{documentId:'doc-b'});assert.equal(out.state,'backoff');assert.equal(out.reason,'failure_backoff');assert.equal(out.next_retry_at,r.clock.value+15000);
  assert.equal(r.journal().reload,null);assert.equal(r.journal().expected_user,before.expected_user);assert.equal(r.journal().baseline_failure,before.baseline_failure);
  assert.equal(r.session.get('clwPageMonitorTab:7').documentId,'doc-b');assert.equal(r.session.get('clwPageMonitorTab:7').baseline_pending,false);
  assert.equal(r.journal().retry_count,0);r.advance(15000);const due=await r.observe(s,{documentId:'doc-b'});assert.ok(due.offer);
  const sent=await r.message('monitor-dispatch',{attempt_id:due.offer.attempt_id,snapshot:s},{documentId:'doc-b'});assert.equal(sent.attempts,1);assert.equal(sent.reload_count,1);
});
test('a new document with loading DOM waits for a usable original user and never adopts a changed user',async()=>{
  const r=await attached(),user=r.journal().expected_user;await reloadDue(r);
  const loading=await r.observe(snapshot({kind:'unsupported',controls_known:false,user_key:''}),{documentId:'doc-b'});
  assert.equal(loading.state,'waiting');assert.notEqual(r.journal().reload,null);assert.equal(r.journal().expected_user,user);
  const changed=await r.observe(waitingProgress({user_key:h(99)}),{documentId:'doc-b'});assert.equal(changed.state,'paused');assert.equal(changed.reason,'manual_takeover');assert.equal(changed.reload,undefined);
  assert.equal(r.journal().expected_user,user);assert.equal(r.journal().reload_count,1);assert.equal(r.journal().pending,null);
});
test('a verified reload into ordinary generating or idle state never sends a continuation',async()=>{
  for(const s of [snapshot({kind:'generating',generating:true}),snapshot()]){
    const r=await attached();await reloadDue(r);const out=await r.observe(s,{documentId:'doc-b'});
    assert.equal(out.offer,undefined);assert.equal(out.reload,undefined);assert.equal(out.attempts,0);assert.equal(r.journal().reload,null);assert.equal(r.journal().pending,null);
    assert.equal(out.reason,s.kind==='generating'?'generating':'watching_for_explicit_failure');
  }
});
test('each verified reload starts a fresh 180-second stall and the chain permits at most two reloads',async()=>{
  const r=await attached(),s=waitingProgress();await reloadDue(r);const firstGeneration=r.generation(7);
  const verified=await r.observe(s,{documentId:'doc-b'});assert.equal(verified.reload_count,1);assert.equal(verified.reload_wait_ms,0);assert.equal(verified.last_progress_at,r.clock.value);
  r.advance(179999);assert.equal((await r.observe(s,{documentId:'doc-b'})).reload,undefined);r.advance(1);
  const second=await r.observe(s,{documentId:'doc-b'});assert.ok(second.reload);assert.notEqual(second.reload.generation,firstGeneration);assert.equal(second.reload_count,2);
  const next=r.recreate();await next.observe(s,{documentId:'doc-c'});await next.start();const rebound=await next.observe(s,{documentId:'doc-c'});assert.equal(rebound.reload_count,2);
  r.advance(180000);const limited=await next.observe(s,{documentId:'doc-c'});assert.equal(limited.reload,undefined);assert.equal(limited.reason,'reload_limit_reached');assert.equal(limited.state,'waiting');assert.equal(limited.attempts,0);
  const progress=await next.observe(waitingProgress({progress_key:h(999)}),{documentId:'doc-c'});assert.equal(progress.reload_count,2);assert.equal(progress.reload_wait_ms,0);
});
test('partial reload grant persistence and missing effect receipts fail closed across worker restarts',async()=>{
  for(const area of ['local','session']){
    const r=await attached(),s=waitingProgress();await r.observe(s);r.advance(180000);r.failures.push({area,method:'set'});
    await assert.rejects(r.observe(s),new RegExp('mock_'+area+'_set_failed'));assert.equal((await r.status()).reload,undefined);
    if(area==='session'){
      assert.equal(r.journal().reload_count,1);const next=r.recreate();const blocked=await next.observe(s);assert.equal(blocked.reason,'reload_not_confirmed');assert.equal(blocked.reload,undefined);assert.equal(next.journal().reload_count,1);
    }else {assert.equal(r.journal().reload_count,0);assert.equal((await r.observe(s)).state,'paused');}
  }
});
test('reload preserves an existing model retry count and a later failure uses its original backoff tier',async()=>{
  const r=await attached(),p=await due(r),sent=await grant(r,p);await r.message('monitor-finish',{attempt_id:sent.attempt_id,result:'not_sent'});
  const used=r.journal().used_failures;await reloadDue(r);const failure=snapshot({kind:'generation_failed',assistant_key:h(600),failure_key:h(601)});
  const out=await r.observe(failure,{documentId:'doc-b'});assert.equal(out.attempts,1);assert.equal(out.reload_count,1);assert.equal(out.next_retry_at,r.clock.value+45000);assert.deepEqual(r.journal().used_failures,used);
});
test('a Stop on an incomplete replacement document still pauses the owned reload',async()=>{
  const r=await attached();await reloadDue(r);const out=await r.observe(snapshot({kind:'unsupported',controls_known:false,user_key:'',stopped:true}),{documentId:'doc-b'});
  assert.equal(out.state,'paused');assert.equal(out.reason,'user_stopped');assert.equal(out.reload,undefined);assert.notEqual(r.journal().reload,null);assert.equal(await r.worker.resumeAfterReload(7),null);
});
test('reload metadata and progress hashes use strict schemas and preserve corrupt evidence',async()=>{
  const r=await attached();
  for(const progress_key of ['',null,undefined,'not-a-hash',h(1)+'0'])await assert.rejects(r.observe(waitingProgress({progress_key})),/snapshot_invalid/);
  await assert.rejects(r.worker.finishReload(7,'bad','requested'),/reload_result_invalid/);
  await assert.rejects(r.worker.finishReload(7,'11111111-2222-4333-8444-999999999999','complete'),/reload_result_invalid/);
  for(const patch of [{reload_count:3},{last_progress_key:h(1),last_progress_at:null},{reload_wait_since:-1}]){
    const other=await attached(),[key]=other.local.keys(),journal={...other.journal(),...patch};other.local.set(key,journal);await assert.rejects(other.status(),/journal_corrupt/);assert.deepEqual(other.local.get(key),journal);
  }
  await reloadDue(r);const [key]=r.local.keys(),journal=r.journal();journal.reload.state='verified';r.local.set(key,journal);await assert.rejects(r.status(),/journal_corrupt/);assert.deepEqual(r.local.get(key),journal);
});
test('malformed wait metadata or extra legacy fields fail closed instead of resetting the journal',async()=>{
  for(const value of [-1,1.5,'1000000',undefined]){
    const r=await attached(),[key]=r.local.keys(),journal=r.journal();journal.connection_wait_since=value;r.local.set(key,journal);
    await assert.rejects(r.status(),/journal_corrupt/);assert.equal(r.local.get(key).connection_wait_since,value);
  }
  const r=await attached(),[key]=r.local.keys(),legacy=r.journal();delete legacy.connection_wait_since;legacy.extra=true;r.local.set(key,legacy);
  await assert.rejects(r.status(),/journal_corrupt/);assert.equal(r.local.get(key).extra,true);
});
test('three consecutive failures use 15, 45, 120 second backoffs with a persistent limit',async()=>{
  const r=await attached();let user=h(1);
  for(const [i,delay] of [15000,45000,120000].entries()){
    const planned=await due(r,snapshot({user_key:user,assistant_key:h(20+i),failure_key:h(30+i),kind:['cannot_think','generation_failed','connection_lost'][i]}),delay);
    const out=await grant(r,planned);assert.equal(out.attempts,i+1);
    await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'clicked'});
    user=h(10+i);const ack=await r.observe(snapshot({user_key:user,generating:true,kind:'generating',continuation_seen:true}));
    assert.equal(ack.reason,'continuation_delivered');assert.equal(r.journal().pending,null);
  }
  const out=await r.observe(snapshot({user_key:user,kind:'connection_lost',failure_key:h(99)}));assert.equal(out.state,'exhausted');assert.equal(out.offer,undefined);assert.equal(out.attempts,3);
  const rebind=await r.start();assert.equal(rebind.state,'exhausted');assert.equal(rebind.attempts,3);
  const same=snapshot({user_key:user,kind:'connection_lost',failure_key:h(99)});await r.observe(same);
  assert.equal((await r.observe(same)).offer,undefined);assert.equal((await r.status()).state,'exhausted');
  await r.stop();assert.equal((await r.start()).state,'exhausted');await r.observe(same);assert.equal((await r.observe(same)).offer,undefined);
  assert.equal(r.journal().retry_count,3);assert.equal(r.network.length,0);
});
test('a genuinely new manual turn plus explicit start begins a new continuation chain after exhaustion',async()=>{
  const r=await attached(),oldUser=await completedChain(r);const manual=snapshot({user_key:h(90),kind:'generating',generating:true});
  assert.equal((await r.observe(manual)).reason,'manual_takeover');assert.equal(r.journal().retry_count,3);
  const start=await r.start();assert.equal(start.state,'exhausted');assert.equal(start.attempts,3);
  await r.observe(snapshot({kind:'unsupported',controls_known:false,user_key:''}));assert.equal(r.journal().retry_count,3);assert.equal(r.journal().expected_user,oldUser);
  const baseline=await r.observe(manual);assert.equal(baseline.state,'watching');assert.equal(baseline.attempts,0);assert.deepEqual(r.journal().used_failures,[]);
  const sent=await grant(r,await due(r,snapshot({user_key:h(90),assistant_key:h(91),failure_key:h(92),kind:'generation_failed'})));
  assert.equal(sent.dispatch,true);assert.equal(sent.attempts,1);
});
test('explicit start on a different automatic continuation retains the exhausted budget',async()=>{
  const r=await attached();await completedChain(r);await r.start();
  const automatic=snapshot({user_key:h(90),kind:'generating',generating:true,continuation_seen:true});
  const baseline=await r.observe(automatic);assert.equal(baseline.state,'exhausted');assert.equal(baseline.attempts,3);assert.equal(r.journal().used_failures.length,3);
  const failed=await r.observe(snapshot({user_key:h(90),assistant_key:h(91),failure_key:h(92),kind:'cannot_think'}));assert.equal(failed.offer,undefined);assert.equal(failed.state,'exhausted');
});
test('explicit start cannot reset a planned attempt even when the observed manual turn changes',async()=>{
  const r=await attached(),user=await completedChain(r,1),failure=snapshot({user_key:user,assistant_key:h(40),failure_key:h(41),kind:'cannot_think'});
  await r.observe(failure);const pending=r.journal().pending;await r.start();
  await r.observe(snapshot({user_key:h(90)}));assert.equal(r.journal().retry_count,1);assert.deepEqual(r.journal().pending,pending);
  assert.equal((await r.observe(snapshot({user_key:h(90)}))).reason,'manual_takeover');assert.equal(r.journal().retry_count,1);
});
test('a new manual turn cannot reset an unknown delivery through explicit start',async()=>{
  const r=await attached(),p=await due(r),sent=await grant(r,p);await r.message('monitor-finish',{attempt_id:sent.attempt_id,result:'unknown'});
  await r.observe(snapshot({user_key:h(90),continuation_seen:false}));await assert.rejects(r.start(),/delivery_unresolved/);
  assert.equal(r.journal().retry_count,1);assert.equal(r.journal().pending.phase,'unknown');assert.deepEqual(r.journal().used_failures,[p.s.failure_key]);
});
test('unsafe generating, draft, focus, composition, offline, block, and unknown controls cannot grant',async()=>{
  for(const patch of [{kind:'generating',generating:true},{draft:true},{focused:true},{composing:true},{online:false},{blocked:true},{controls_known:false}]){
    const r=await attached(),p=await due(r);const unsafe={...p.s,...patch};
    const waiting=await r.observe(unsafe);assert.equal(waiting.state,'waiting');assert.equal(waiting.offer,undefined);
    await assert.rejects(r.message('monitor-dispatch',{attempt_id:p.offer.attempt_id,snapshot:unsafe}),/dispatch_not_permitted/);
    assert.equal((await grant(r,p)).dispatch,true);
  }
});
test('manual gesture cancels planned work, pauses, and leaves legacy adoption blocked',async()=>{
  const r=await attached();const p=await due(r);
  const out=await r.message('monitor-gesture');assert.equal(out.state,'paused');assert.equal(r.journal().pending,null);assert.equal(await r.worker.isBound(7),true);
  await assert.rejects(grant(r,p),/dispatch_not_permitted/);assert.equal((await r.observe(p.s)).offer,undefined);
  const resumed=await r.start();assert.notEqual(resumed.generation,p.generation);await r.observe(p.s);assert.equal((await r.observe(p.s)).reason,'existing_failure_observed');
});
test('new user turn without pending continuation pauses as manual takeover',async()=>{
  const r=await attached();const out=await r.observe(snapshot({user_key:h(99),continuation_seen:true,kind:'cannot_think',failure_key:h(3)}));
  assert.equal(out.state,'paused');assert.equal(out.reason,'manual_takeover');assert.equal(out.offer,undefined);assert.equal(r.journal().pending,null);
});
test('explicit stopped observation cancels only planned work',async()=>{
  const r=await attached(),p=await due(r);const out=await r.observe({...p.s,stopped:true});assert.equal(out.state,'paused');assert.equal(out.reason,'user_stopped');assert.equal(r.journal().pending,null);
});
test('a durable dispatch grant is returned once even when two requests race',async()=>{
  const r=await attached(),p=await due(r);
  const results=await Promise.allSettled([grant(r,p),grant(r,p)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
  assert.equal(r.journal().pending.phase,'dispatching');assert.equal(r.journal().retry_count,1);assert.deepEqual(r.journal().used_failures,[p.s.failure_key]);
  assert.equal((await r.observe(p.s)).offer,undefined);
});
test('dispatch revalidates due time and all three turn/failure identities',async()=>{
  const r=await attached(),s=snapshot({kind:'cannot_think',failure_key:h(3)}),planned=await r.observe(s),attempt=()=>r.journal().pending.attempt_id;
  assert.equal(planned.offer,undefined);await assert.rejects(r.message('monitor-dispatch',{attempt_id:attempt(),snapshot:s}),/dispatch_not_permitted/);
  r.advance(15000);
  for(const patch of [{user_key:h(5)},{assistant_key:h(5)},{failure_key:h(5)},{kind:'generation_failed'}])await assert.rejects(r.message('monitor-dispatch',{attempt_id:attempt(),snapshot:{...s,...patch}}),/dispatch_not_permitted/);
  assert.equal((await r.message('monitor-dispatch',{attempt_id:attempt(),snapshot:s})).dispatch,true);
});
test('clicked is unconfirmed delivery, not an invitation to retry the same failure',async()=>{
  const r=await attached(),p=await due(r),out=await grant(r,p);
  await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'clicked'});
  r.advance(999999);const waiting=await r.observe(p.s);assert.equal(waiting.state,'clicked');assert.equal(waiting.offer,undefined);
  await assert.rejects(r.start(),/delivery_unresolved/);await assert.rejects(r.message('monitor-finish',{attempt_id:out.attempt_id,result:'not_sent'}),/delivery_unresolved/);
  assert.equal(r.journal().retry_count,1);assert.equal(r.journal().pending.phase,'clicked');
});
test('only a new user key plus exact continuation DOM attestation acknowledges delivery',async()=>{
  const r=await attached(),p=await due(r),out=await grant(r,p);await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'unknown'});
  assert.equal((await r.observe({...p.s,continuation_seen:true})).pending_result,'unknown');
  const ack=await r.observe(snapshot({user_key:h(10),continuation_seen:true,kind:'generating',generating:true}));
  assert.equal(ack.reason,'continuation_delivered');assert.equal(ack.attempts,1);assert.equal(r.journal().expected_user,h(10));assert.equal(r.journal().pending,null);
  const next=await r.observe(snapshot({user_key:h(10),assistant_key:h(20),failure_key:h(30),kind:'cannot_think'}));assert.equal(next.next_retry_at,r.clock.value+45000);
});
test('a changed user without delivery attestation preserves unknown and pauses',async()=>{
  const r=await attached(),p=await due(r),out=await grant(r,p);await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'unknown'});
  const manual=await r.observe(snapshot({user_key:h(10)}));assert.equal(manual.state,'paused');assert.equal(manual.reason,'manual_takeover');assert.equal(r.journal().pending.phase,'unknown');
});
test('manual gesture never erases clicked/unknown and late delivery does not unpause',async()=>{
  const r=await attached(),p=await due(r),out=await grant(r,p);await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'unknown'});
  await r.message('monitor-gesture');assert.equal(r.journal().pending.phase,'unknown');assert.equal(r.journal().retry_count,1);
  const ack=await r.observe(snapshot({user_key:h(10),continuation_seen:true}));assert.equal(ack.state,'paused');assert.equal(r.journal().pending,null);
  assert.equal((await r.observe(snapshot({user_key:h(10),kind:'generation_failed',failure_key:h(7)}))).offer,undefined);
});
test('not_sent consumes its one grant, preserves the budget, and cannot replay',async()=>{
  const r=await attached(),p=await due(r),out=await grant(r,p);await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'not_sent'});
  assert.equal(r.journal().pending,null);assert.equal((await r.observe(p.s)).reason,'failure_already_granted');
  await r.start();await r.observe(p.s);assert.equal((await r.observe(p.s)).offer,undefined);assert.equal(r.journal().retry_count,1);
});
test('dispatching, clicked, and unknown survive worker reinstantiation without replay',async()=>{
  for(const result of [null,'clicked','unknown']){
    const r=await attached(),p=await due(r),out=await grant(r,p);
    if(result)await r.message('monitor-finish',{attempt_id:out.attempt_id,result});
    const next=r.recreate();assert.equal(await next.worker.isBound(7),true);
    await assert.rejects(next.start(),/delivery_unresolved/);await assert.rejects(grant(next,p),/dispatch_not_permitted/);
    assert.equal((await next.observe(p.s)).offer,undefined);assert.equal(next.journal().retry_count,1);
    const ack=await next.observe(snapshot({user_key:h(10),continuation_seen:true}));assert.equal(ack.reason,'continuation_delivered');
  }
});
test('browser restart does not restore sessions or reset a durable unknown',async()=>{
  const r=await attached(),p=await due(r),out=await grant(r,p);await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'unknown'});
  r.session.clear();const next=r.recreate();assert.equal(await next.worker.isBound(7),false);
  await assert.rejects(next.observe(p.s),/generation_invalid/);await assert.rejects(next.start(),/delivery_unresolved/);
  const status=await next.status();assert.equal(status.state,'unbound');assert.equal(status.pending_result,'unknown');assert.equal(status.bound,false);assert.equal(status.generation,null);assert.equal(status.attempts,1);
});
test('explicit document rebind invalidates old observer while preserving attempts',async()=>{
  const r=await attached(),p=await due(r),out=await grant(r,p);await r.message('monitor-finish',{attempt_id:out.attempt_id,result:'not_sent'});
  const old=r.generation(7),resumed=await r.start();assert.notEqual(resumed.generation,old);assert.equal(resumed.attempts,1);
  await assert.rejects(r.message('monitor-observe',{generation:old,snapshot:snapshot()}),/binding_mismatch/);
  await r.observe(snapshot(),{documentId:'doc-b'});assert.equal(r.session.get('clwPageMonitorTab:7').documentId,'doc-b');assert.equal(r.journal().retry_count,1);
});
test('tab removal drops session ownership and preserves an in-flight durable grant',async()=>{
  const r=await attached(),p=await due(r);await grant(r,p);
  await r.worker.stopForTab(7);assert.equal(await r.worker.isBound(7),false);assert.equal(r.session.size,0);assert.equal(r.journal().pending.phase,'dispatching');
  await assert.rejects(r.start(8),/delivery_unresolved/);assert.equal(r.journal().retry_count,1);
});
test('popup stop cancels planned work and a later start keeps the same budget',async()=>{
  const r=await attached(),p=await due(r);await r.stop();assert.equal(r.journal().pending,null);assert.equal(r.journal().state,'stopped');
  assert.equal(await r.worker.isBound(7),false);const restart=await r.start(8);assert.equal(restart.attempts,0);await r.observe(p.s,{},8);r.advance(120000);
  assert.equal((await r.observe(p.s,{},8)).offer,undefined);
});
test('legacy dispatcher binding always blocks independent start and content grants',async()=>{
  for(const prefix of ['clwUnifiedTab:','clwRecoveryTab:']){
    const r=runtime();r.session.set(prefix+'7',{chatUrl:CHAT,token:'not-read'});await assert.rejects(r.start(),/legacy_binding_active/);assert.equal(r.local.size,0);
    r.session.delete(prefix+'7');await r.start();await r.observe();const p=await due(r);r.session.set(prefix+'7',{chatUrl:CHAT});await assert.rejects(grant(r,p),/legacy_binding_active/);
  }
});
test('global serialization permits only one active monitor owner of the same URL',async()=>{
  const r=runtime(),out=await Promise.allSettled([r.start(7),r.start(8)]);
  assert.equal(out.filter(x=>x.status==='fulfilled').length,1);assert.equal(out.filter(x=>x.status==='rejected').length,1);
  assert.match(out.find(x=>x.status==='rejected').reason.message,/duplicate_url_owner/);
  assert.equal(r.local.size,1);assert.equal(r.session.has('clwPageMonitorTab:7'),true);assert.equal(r.session.has('clwPageMonitorTab:8'),false);
  await r.message('monitor-gesture');await assert.rejects(r.start(8),/duplicate_url_owner/);
  await r.worker.stopForTab(7);assert.equal((await r.start(8)).started,true);
});
test('different exact URLs have independent durable retry counters',async()=>{
  const r=runtime();const starts=await Promise.all([r.start(7),r.start(9)]);assert.equal(starts.length,2);
  await r.observe();await r.observe(snapshot(),{},9);await grant(r,await due(r));
  assert.equal((await r.status(7)).attempts,1);assert.equal((await r.status(9)).attempts,0);assert.equal(r.local.size,2);
});
test('strict message and snapshot schemas reject arbitrary text and missing fields',async()=>{
  const r=await attached();
  for(const patch of [{prompt:'arbitrary chat text'},{model:'Pro'},{snapshot:{...snapshot(),text:'chat text'}},{snapshot:{...snapshot(),kind:'success'}},{snapshot:{...snapshot(),user_key:'not-a-hash'}},{snapshot:{...snapshot(),online:1}},{snapshot:{...snapshot(),failure_key:'x'.repeat(10000)}}])await assert.rejects(r.message('monitor-observe',{snapshot:snapshot(),...patch}),/message_invalid|snapshot_invalid/);
  const incomplete=snapshot();delete incomplete.composing;await assert.rejects(r.observe(incomplete),/snapshot_invalid/);
  await assert.rejects(r.message('monitor-finish',{attempt_id:'bad',result:'clicked'}),/attempt_invalid/);
  await assert.rejects(r.message('monitor-finish',{attempt_id:'11111111-2222-4333-8444-999999999999',result:'sent'}),/result_invalid/);
  assert.equal(r.journal().retry_count,0);
});
test('session/local storage errors return no sending grant',async()=>{
  for(const [area,method] of [['session','get'],['local','get'],['local','set']]){
    const r=await attached(),p=await due(r);r.failures.push({area,method});
    await assert.rejects(grant(r,p),new RegExp('mock_'+area+'_'+method+'_failed'));
    assert.equal(r.journal().retry_count,0);assert.equal(r.journal().pending.phase,'planned');
    await assert.rejects(grant(r,p),/dispatch_not_permitted/);
  }
  const r=runtime();r.failures.push({area:'session',method:'set'});await assert.rejects(r.start(),/session_set_failed/);assert.equal(await r.worker.isBound(7),false);
});
test('a failed manual-pause write cannot leave an old plan sendable after storage recovers',async()=>{
  const r=await attached(),p=await due(r);r.failures.push({area:'local',method:'set'});
  await assert.rejects(r.message('monitor-gesture'),/local_set_failed/);assert.equal(r.journal().pending.phase,'planned');
  await r.start(9); // Rearming another URL must not unlock this failed pause.
  await assert.rejects(grant(r,p),/dispatch_not_permitted/);
  const out=await r.observe(p.s);assert.equal(out.state,'paused');assert.equal(out.reason,'storage_uncertain_explicit_start_required');assert.equal(out.offer,undefined);
  await r.start();await r.observe(p.s);assert.equal((await r.observe(p.s)).reason,'existing_failure_observed');assert.equal(r.journal().retry_count,0);
});
test('failed finish persistence leaves original dispatch lock after worker restart',async()=>{
  const r=await attached(),p=await due(r),out=await grant(r,p);r.failures.push({area:'local',method:'set'});
  await assert.rejects(r.message('monitor-finish',{attempt_id:out.attempt_id,result:'clicked'}),/local_set_failed/);
  const next=r.recreate();assert.equal(next.journal().pending.phase,'dispatching');await assert.rejects(next.start(),/delivery_unresolved/);assert.equal((await next.observe(p.s)).offer,undefined);
});
test('corrupt durable journal fails closed instead of silently resetting the budget',async()=>{
  const r=await attached();const [key]=[...r.local.keys()];r.local.set(key,{...r.journal(),retry_count:99});
  await assert.rejects(r.start(),/journal_corrupt/);await assert.rejects(r.observe(),/journal_corrupt/);assert.equal(r.local.get(key).retry_count,99);
});
test('durable storage contains hashes and state only, with no URL, prompt, transcript, or credential',async()=>{
  const r=await attached();await grant(r,await due(r));
  const encoded=JSON.stringify([...r.local]);assert.ok(!encoded.includes(CHAT));assert.ok(!encoded.includes(PROMPT));assert.ok(!encoded.includes('token'));assert.ok(!encoded.includes('model'));
  assert.match([...r.local.keys()][0],/^clwPageMonitorJournal:[0-9a-f]{64}$/);
  assert.ok(r.ops.filter(x=>x[0]==='session'&&x[1]==='get').every(x=>typeof x[2]==='string'||Array.isArray(x[2])));
  assert.equal(r.network.length,0);
});
