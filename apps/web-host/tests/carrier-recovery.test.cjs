'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const hash=value=>createHash('sha256').update(value||'').digest('hex');
const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino');
const {dom}=require('../page-dom.cjs');
const {WebDriver}=require('../web-driver.cjs');
const {emptyCarrier}=require('../carrier-recovery.cjs');
const HOME='https://chatgpt.com/',OLD='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',NEW='https://chatgpt.com/c/66666666-2222-3333-4444-555555555555';
const ATTEMPT='control_'+'a'.repeat(32);
const empty=()=>({url:HOME,editor:true,controlKnown:true,historyAtLatest:true,generating:false,draft:false,composing:false,
  approvalRequired:false,loginRequired:false,blocked:false,accessLimited:false,complete:false,userId:'',assistantId:'',html:'',
  bootstrapMarker:null,bootstrapMarkerCount:0,attemptMarker:null,attemptMarkerCount:0,failure:''});
function fixture({snapshot=empty(),composer,paused=false,eligible=true,sendFailure=false,changeAt=null}={}){
  const calls=[],runtime=new EventEmitter();runtime.ready=true;
  const row={page_id:'web-original',thread_id:'original-thread',url:OLD,phase:'bound',bootstrap_state:'sent',account:'A',
    paused,first_turn_mode:'task_v1',model:'GPT-5.6 · Latest',effort:'High',latest_request:{id:'same-first-request',phase:'queued',attempt_id:'old-not-sent'}};
  let current=snapshot,prepared;const wc={getURL:()=>current.url,isDestroyed:()=>false};
  const p={id:row.page_id,account:'A',documentGeneration:3,domReady:true,view:{webContents:wc},observation:{},modelRestorePending:false};
  const pool={pages:new Map([[p.id,p]]),running(){},work(){}};
  const descriptor={id:'recovery-original',page_id:row.page_id,thread_id:row.thread_id,request_id:row.latest_request.id,
    account:'A',original_url:OLD,original_attempt_id:'old-not-sent',retry_epoch:10,original_scope_hash:'same-scope',state:'prepared',attempt_id:null};
  runtime.call=async(op,payload)=>{
    calls.push({op,payload});if(changeAt===op)p.documentGeneration++;
    if(op==='carrier-recovery-check')return {eligible,...descriptor};
    if(op==='recover-empty-carrier')return {...descriptor};
    if(op==='bind-recovered-carrier'){descriptor.attempt_id=payload.attempt_id;return {...descriptor,state:'bound',url:payload.url,user_hash:payload.browser.user_hash};}
    if(op==='prepare'){prepared={attempt_id:payload.attempt_id,previous_user_hash:hash(current.userId),
      assistant_before_hash:payload.assistant_before_hash,prompt_hash:payload.prompt_hash};return {prepared:true};}
    if(op==='list')return {pages:[{...row,latest_request:{...row.latest_request,attempt_id:ATTEMPT}}]};
    if(op==='view')return {page_id:row.page_id,thread_id:row.thread_id,
      latest_request:{...row.latest_request,attempt_id:ATTEMPT},request:{id:row.latest_request.id,phase:row.latest_request.phase,cancel_requested:0},
      attempt:{id:ATTEMPT,state:'dispatching',dispatched:123,acknowledged:null}};
    if(op==='prepared')return prepared;
    if(op==='wire'){
      if(payload.data.action==='pulse')return descriptor.attempt_id?{state:'original_attempt_requires_reconciliation',attempt_id:ATTEMPT}:{state:'offer',attempt_id:ATTEMPT,request_id:row.latest_request.id};
      if(payload.data.action==='dispatch'){descriptor.attempt_id=ATTEMPT;return {dispatch:true,attempt_id:ATTEMPT,prompt:'Original full business task'};}
      if(payload.data.action==='sent')return {state:'browser_result_pending'};
    }
    if(op==='pending-receipt')return {state:'paused_no_pending_receipt'};
    assert.fail('unexpected '+op);
  };
  const driver=new WebDriver({runtime,pool,onNotice(){},dom:async(_,op)=>{
    if(op==='snapshot')return {...current};
    if(op==='connector-state')return composer||{editorCount:1,generating:false,composing:false,text:'',approvalRequired:false,accessLimited:false,blocked:false};
    assert.fail('unexpected DOM '+op);
  }});driver.records.set(p.id,row);
  driver.inspect=async()=>({model:row.model,effort:row.effort});
  driver.send=async(_,prompt)=>{
    calls.push({op:'actual-send',prompt});assert.match(prompt,new RegExp('\\[CLW:'+ATTEMPT+'\\]'));
    if(sendFailure)throw Error('unknown original send');
    current={...empty(),url:NEW,userId:'original-public-user',assistantId:'',generating:true,attemptMarker:'[CLW:'+ATTEMPT+']',attemptMarkerCount:1};return {...current};
  };
  return {driver,row,p,pool,calls,descriptor,get snapshot(){return current;},set snapshot(value){current=value;}};
}
test('original resumed first request follows normal dispatch, one send, exact rebind and original receipt',async()=>{
  const f=fixture();try{await f.driver.tick(f.row);
    assert.deepEqual(f.calls.map(x=>x.op),['carrier-recovery-check','recover-empty-carrier','wire','wire','prepare','list','view','prepared','actual-send','bind-recovered-carrier','wire']);
    assert.equal(f.calls.filter(x=>x.op==='actual-send').length,1);
    assert.equal(f.calls.find(x=>x.op==='bind-recovered-carrier').payload.request_id,'same-first-request');
    assert.equal(f.driver.records.get(f.p.id).url,NEW);assert.equal(f.driver.records.get(f.p.id).latest_request.id,'same-first-request');
    assert.equal(f.driver.records.get(f.p.id).bootstrap_state,'sent');assert.equal(f.driver.pending.get(f.p.id).attempt,ATTEMPT);
  }finally{f.driver.dispose();}
});
test('a root pause, rejected scope, old conversation or every public nonempty guard sends nothing',async()=>{
  const cases=[{paused:true},{eligible:false},{snapshot:{...empty(),url:OLD+'-foreign'}},
    ...['generating','draft','composing','approvalRequired','loginRequired','blocked','accessLimited','complete'].map(key=>({snapshot:{...empty(),[key]:true}})),
    {snapshot:{...empty(),userId:'enrollment-history'}},{snapshot:{...empty(),assistantId:'old-answer'}},
    {snapshot:{...empty(),userText:'real user text without DOM id'}},{snapshot:{...empty(),publicText:'real answer without DOM id'}},
    {snapshot:{...empty(),bootstrapMarker:'original',bootstrapMarkerCount:1}},{snapshot:{...empty(),historyAtLatest:false}}];
  for(const spec of cases){const f=fixture(spec);try{
    // Login/limit reporting is an existing independent hold, not a Send.
    const original=f.driver.runtime.call;f.driver.runtime.call=async(op,p)=>op==='page-issue'?{}:original(op,p);
    await f.driver.tick(f.row);assert.equal(f.calls.filter(x=>x.op==='actual-send').length,0,JSON.stringify(spec));
    assert.equal(f.calls.filter(x=>x.op==='recover-empty-carrier').length,0,JSON.stringify(spec));
  }finally{f.driver.dispose();}}
});
test('document replacement while checking backend prevents a recovery mutation or send',async()=>{
  const f=fixture({changeAt:'carrier-recovery-check'});try{
    await assert.rejects(f.driver.tick(f.row),/managed_empty_carrier_original_page_changed/);
    assert.deepEqual(f.calls.map(x=>x.op),['carrier-recovery-check']);
  }finally{f.driver.dispose();}
});
test('document replacement while binding preserves the accepted URL and waits for a fresh original receipt observation',async()=>{
  const f=fixture({changeAt:'bind-recovered-carrier'});try{
    await f.driver.tick(f.row);assert.equal(f.calls.filter(x=>x.op==='actual-send').length,1);
    assert.equal(f.driver.records.get(f.p.id).url,NEW);
    assert.equal(f.calls.filter(x=>x.op==='wire'&&x.payload.data.action==='sent').length,0);
    assert.equal(f.driver.pending.get(f.p.id).attempt,ATTEMPT);
  }finally{f.driver.dispose();}
});
test('unknown original send remains pending; a fresh exact marker may rebind but cannot replay',async()=>{
  const f=fixture({sendFailure:true});try{
    await assert.rejects(f.driver.tick(f.row),/unknown original send/);
    assert.equal(f.calls.filter(x=>x.op==='actual-send').length,1);assert.equal(f.driver.pending.get(f.p.id).attempt,ATTEMPT);
    const saved={...f.driver.records.get(f.p.id),carrier_recovery:{...f.descriptor,attempt_id:ATTEMPT}};f.driver.records.set(f.p.id,saved);
    await f.driver.tick(saved);assert.equal(f.calls.filter(x=>x.op==='actual-send').length,1);
    f.snapshot={...empty(),url:NEW,userId:'same-original-user',generating:true,attemptMarker:'[CLW:'+ATTEMPT+']',attemptMarkerCount:1};
    await f.driver.tick(saved);assert.equal(f.driver.records.get(f.p.id).url,NEW);assert.equal(f.calls.filter(x=>x.op==='actual-send').length,1);
  }finally{f.driver.dispose();}
});
test('empty carrier detection rejects unknown booleans rather than treating missing evidence as idle',()=>{
  for(const key of ['editor','controlKnown','historyAtLatest','generating','draft','composing','approvalRequired','loginRequired','blocked','accessLimited','complete','attemptMarkerCount','bootstrapMarkerCount']){
    const s=empty();delete s[key];assert.equal(emptyCarrier(s),false,key);
  }
});
test('a verified empty homepage without a history scroller preserves null evidence and first sends once',async()=>{
  const f=fixture({snapshot:{...empty(),historyAtLatest:null}});try{
    await f.driver.tick(f.row);assert.equal(f.calls.filter(x=>x.op==='actual-send').length,1);
    assert.equal(f.calls.find(x=>x.op==='recover-empty-carrier').payload.browser.history_at_latest,null);
  }finally{f.driver.dispose();}
});
function realEmptyHomepage(){
  const window=createWindow('<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div>'+
    '<button type="submit" data-testid="send-button"></button><button data-codex-intelligence-trigger="true" '+
    'data-composer-navigation-target="reasoning" aria-haspopup="menu">高</button></form>');
  const document=window.document;document.hasFocus=()=>false;
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return 100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return 30;}});
  window.HTMLElement.prototype.getClientRects=function(){return [{}];};
  for(const list of [document.querySelectorAll('div'),document.body.children])
    Object.defineProperty(Object.getPrototypeOf(list),Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const context=vm.createContext({document,window,Node:window.Node,location:{href:HOME},getComputedStyle:()=>({flexDirection:'column'})});
  const run=action=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},{},()=>{},()=>false,()=>({required:false}))`,context);
  return {snapshot:run('snapshot'),composer:run('connector-state')};
}
test('serialized actual page DOM has no composer draft field; an empty original homepage still recovers',async()=>{
  const actual=realEmptyHomepage();assert.equal(actual.snapshot.draft,false);assert.equal(Object.hasOwn(actual.composer,'draft'),false);
  assert.equal(actual.composer.editorCount,1);assert.equal(actual.composer.text,'');
  const f=fixture(actual);try{
    await f.driver.tick(f.row);assert.equal(f.calls.filter(x=>x.op==='recover-empty-carrier').length,1);
    assert.equal(f.calls.filter(x=>x.op==='actual-send').length,1);assert.equal(f.driver.records.get(f.p.id).url,NEW);
  }finally{f.driver.dispose();}
});
test('actual composer nonempty or nonidle state cannot prepare a carrier after the empty snapshot',async()=>{
  const actual=realEmptyHomepage();
  for(const [key,value] of [['text','new user draft'],['editorCount',2],['generating',true],['composing',true],
    ['approvalRequired',true],['accessLimited',true],['blocked',true]]){
    const f=fixture({...actual,composer:{...actual.composer,[key]:value}});try{
      await f.driver.tick(f.row);assert.equal(f.calls.filter(x=>x.op==='recover-empty-carrier').length,0,key);
      assert.equal(f.calls.filter(x=>x.op==='actual-send').length,0,key);
    }finally{f.driver.dispose();}
  }
});
