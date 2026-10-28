'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const readyComposer=(url,account='B')=>async(_wc,action)=>{
 if(action==='snapshot')return {url,editor:true,controlKnown:true,generating:false,draft:false,composing:false};
 assert.equal(action,'connector-state');
 return {editorCount:1,text:'',selected:[account==='A'?'Local-MCP':'Local-MCP-B'],visibleSelectedCount:1};
};

test('first task waits for the initial blank page navigation without creating a second page',async()=>{
 const runtime=new EventEmitter();runtime.call=async op=>{assert.equal(op,'list');return {pages:[]};};
 let url='about:blank',waits=0,enrollments=0;
 const p={id:'fresh',view:{webContents:{getURL:()=>url}}};
 const d=new WebDriver({runtime,pool:{},onNotice(){},sleep:async()=>{waits++;url='https://chatgpt.com/';},
   dom:async()=>{if(url==='about:blank')throw Error('chat_page_required');return {editor:true,controlKnown:true};}});
 d.inspect=async()=>({model:'GPT-6',effort:'极高'});d.selectModel=async()=>({model:'GPT-6',effort:'极高'});
 d.enroll=async()=>{enrollments++;return {state:'reserved'};};
 const r=await d.startFirstTurn(p,{root:'D:/isolated',title:'fixture',instructions:'read fixture',waitForReady:true});
 assert.equal(r.state,'reserved');assert.equal(waits,1);assert.equal(enrollments,1);
 url='https://auth.openai.com/';d.dom=async()=>{throw Error('chat_page_required');};
 await assert.rejects(d.startFirstTurn(p,{instructions:'fixture',waitForReady:true}),/chat_page_required/);
 assert.equal(enrollments,1);
});

test('runtime connection is not task readiness until the ledger arrives, including reconnect',async()=>{
 const runtime=new EventEmitter();runtime.ready=true;let deliver;
 runtime.call=async op=>{assert.equal(op,'list');return new Promise(resolve=>{deliver=resolve;});};
 const d=new WebDriver({runtime,pool:{pages:new Map()},onNotice(){}});
 assert.equal(d.recordsLoaded,false);
 const loading=d.reconcileAll();assert.equal(d.recordsLoaded,false);
 deliver({pages:[]});await loading;assert.equal(d.recordsLoaded,true);
 runtime.emit('ready');assert.equal(d.recordsLoaded,false);
 deliver({pages:[]});await new Promise(resolve=>setImmediate(resolve));assert.equal(d.recordsLoaded,true);
});

test('worker complete first task uses Pro for the single enrollment and work Send',async()=>{
 const calls=[],choices=[],sends=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
 const r={page_id:'worker',parent_target:'master',phase:'reserved',bootstrap_state:'pending',bootstrap_text:'enroll and implement',first_turn_instructions:'Implement, test, repair and deliver.',first_turn_mode:'task_v1',model:'GPT-6',effort:'Pro',bootstrap_model_selection:{model:'GPT-6',effort:'Pro'}};
 const p={id:r.page_id,view:{webContents:{getURL:()=> 'https://chatgpt.com/'}}};
 const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:readyComposer(p.view.webContents.getURL())});
 d.selectModel=async(_p,expected)=>{choices.push(expected.effort);return expected;};
 d.send=async(_p,text,_baseline,_marker,_context,beforeSend)=>{await beforeSend();sends.push(text);};
 await d.tick(r);assert.deepEqual(choices,['Pro']);assert.equal(sends.length,1);assert.ok(!calls.some(([op])=>op==='page-issue'));
});

test('failed thinking during first-task enrollment enters recovery with actual bootstrap evidence',async()=>{
 const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
 const r={page_id:'worker',phase:'receiver_enrolled',first_turn_mode:'task_v1',latest_request:{phase:'processing'}};
 const s={url:'https://chatgpt.com/c/worker',editor:true,controlKnown:true,historyAtLatest:true,failure:'无法思考',userId:'actual',bootstrapMarker:'[CLW-BOOTSTRAP:worker]',bootstrapMarkerCount:1};
 const p={id:r.page_id,view:{webContents:{getURL:()=>s.url}}};
 const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async()=>s});
 d.send=async()=>assert.fail('observe first; recovery Send is separately admitted');
 await d.tick(r);assert.equal(calls[0][0],'first-task-failed');assert.equal(p.observation.failure,'无法思考');
});

test('a stream error before enrollment reports the original bootstrap failure without a recovery Send',async()=>{
 const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
 const r={page_id:'original',phase:'reserved',bootstrap_state:'sent',first_turn_mode:'task_v1'};
 const s={url:'https://chatgpt.com/c/original',editor:true,controlKnown:true,historyAtLatest:true,failure:'消息流中的错误',userId:'actual',bootstrapMarker:'[CLW-BOOTSTRAP:original]',bootstrapMarkerCount:1};
 const p={id:r.page_id,view:{webContents:{getURL:()=>s.url}}};
 const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async()=>s});
 d.send=async()=>assert.fail('unbound generation failure cannot repeat enrollment');
 await d.tick(r);assert.equal(calls.length,1);assert.equal(calls[0][0],'page-issue');
 assert.equal(calls[0][1].kind,'bootstrap_failed');assert.match(calls[0][1].detail,/消息流中的错误/);
});

test('completed first task or real tool wait uses the original user marker, not an assistant echo',async()=>{
 for(const phase of ['queued','suspended','completed','blocked']){
  const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
  const r={page_id:'first',phase:'receiver_enrolled',first_turn_mode:'task_v1',latest_request:{phase},first_turn_instructions:'complete work'};
  const s={url:'https://chatgpt.com/c/first',editor:true,controlKnown:true,historyAtLatest:true,complete:true,
    publicText:'Waiting or result saved.',html:'<p>Waiting or result saved.</p>',assistantId:'answer',bootstrapMarker:'[CLW-BOOTSTRAP:first]',bootstrapMarkerCount:1};
  const p={id:r.page_id,view:{webContents:{getURL:()=>s.url}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async()=>s});
  await d.tick(r);
  assert.ok(calls.some(([op])=>op==='bind-first-turn'));assert.ok(!calls.some(([op])=>op==='page-issue'));
 }
});

test('known first-task resource conflict waits before model selection or Send; races also keep pending',async()=>{
 for(const early of [true,false]){
  const calls=[],runtime=new EventEmitter();
  runtime.call=async(op,p)=>{calls.push([op,p]);if(op==='bootstrap')throw Error('managed_bootstrap_waiting_local_slot');return {};};
  const r={page_id:'waiting',phase:'reserved',bootstrap_state:'pending',bootstrap_text:'complete task',
    first_turn_instructions:'Implement and verify.',model:'GPT-6',effort:'Pro',bootstrap_wait:early?{state:'waiting_local_slot'}:null};
  const p={id:r.page_id,view:{webContents:{getURL:()=> 'https://chatgpt.com/'}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:readyComposer(p.view.webContents.getURL())});
  d.selectModel=async()=>{assert.equal(early,false);return {model:'GPT-6',effort:'Pro'};};
  d.send=async(_p,_text,_baseline,_marker,_context,beforeSend)=>{
   await beforeSend();assert.fail('known resource conflict must not spend a model turn');
  };
  await d.tick(r);assert.match(p.status,/等待工作目录空闲/);
  assert.equal(calls.filter(([op,p])=>op==='bootstrap'&&p.state==='sending').length,early?0:1);
  assert.equal(r.bootstrap_state,'pending');
  assert.ok(!calls.some(([op,p])=>op==='page-issue'||op==='bootstrap'&&p.state==='unknown'));
 }
});

function waitingPreparation(){
 const calls=[],actions=[],url='https://chatgpt.com/c/waiting',marker='[CLW-BOOTSTRAP:waiting]';
 const r={page_id:'waiting',thread_id:'original-thread',account:'A',root:'D:/original-scope',access:'write',write_paths:['src'],
  phase:'reserved',bootstrap_state:'pending',bootstrap_text:'原始中文任务\r\n  保留正文与缩进',first_turn_mode:'task_v1',
  first_turn_instructions:'完整实施与验证',model:'GPT-6 · Latest',effort:'Pro',
  bootstrap_model_selection:{model:'GPT-6 · Latest',effort:'Pro',selection:['Latest'],sliderCount:1,sliderContainerCount:1}};
 const p={id:r.page_id,account:r.account,documentGeneration:1,view:{webContents:{getURL:()=>url,isDestroyed:()=>false}}};
 const pool={pages:new Map([[p.id,p]]),running(){}},runtime=new EventEmitter();
 let occupied=true,body='',clicks=0,insertions=0,model={...r.bootstrap_model_selection},admissionError=null,sendError=null,onAdmission=null,onSend=null,onList=null;
 runtime.call=async(op,payload)=>{
  calls.push([op,payload]);
  if(op==='list'){const row=JSON.parse(JSON.stringify(r));await onList?.();return {pages:[row]};}
  if(op==='bootstrap'){
   if(payload.state==='sending'){
    if(admissionError)throw Error(admissionError);
    if(occupied)throw Error('managed_bootstrap_waiting_local_slot');
    await onAdmission?.();
   }
   r.bootstrap_state=payload.state;
  }
  return {};
 };
 const options={runtime,pool,onNotice(){},sleep:async()=>{},dom:async(_wc,action,arg)=>{
  actions.push(action);
  if(action==='snapshot')return {url,editor:true,controlKnown:true,generating:false,composing:false,draft:!!body,
   userId:clicks&&!sendError?'accepted-user':'old-user',assistantId:'old-answer',userText:clicks&&!sendError?marker:'original-user'};
  if(action==='connector-state')return {editorCount:1,text:body,selected:['Local-MCP'],visibleSelectedCount:1};
  if(action==='insert-plain-text'){insertions++;body=arg.text;return {};}
  if(action==='editor-text')return {text:body};
  if(action==='send'){
   onSend?.();
   if(arg.expectedModel&&(arg.expectedModel.model!==model.model||arg.expectedModel.effort!==model.effort||
      JSON.stringify(arg.expectedModel.selection)!==JSON.stringify(model.selection)))throw Error('send_model_selection_mismatch');
   clicks++;if(sendError)throw Error(sendError);
   assert.equal(arg.expectedText.replace(/\r\n/g,'\n'),body);assert.equal(arg.expectedConnector,'Local-MCP');
   body='';return {};
  }
  assert.equal(action,'focus-editor');return {};
 }};
 const driver=new WebDriver(options);driver.records.set(p.id,r);
 driver.selectModel=async()=>model;driver.inspect=async(_p,assertCurrent=()=>{})=>{assertCurrent();return model;};
 return {driver,r,p,pool,runtime,calls,actions,options,get body(){return body;},get clicks(){return clicks;},get insertions(){return insertions;},
  free(){occupied=false;},edit(text){body=text;},model(value){model=value;},admissionError(value){admissionError=value;},sendError(value){sendError=value;},
  afterAdmission(fn){onAdmission=fn;},beforeSoleSend(fn){onSend=fn;},duringList(fn){onList=fn;}};
}
test('a local-slot race reuses its original verified preparation when free, without reinserting the draft or another Send',async()=>{
 const f=waitingPreparation();await f.driver.tick(f.r);
 assert.match(f.p.status,/等待工作目录空闲/);assert.equal(f.r.bootstrap_state,'pending');
 assert.equal(f.clicks,0);assert.equal(f.insertions,1);assert.equal(f.driver.bootstrapPrepared.size,1);
 const original=f.body;
 await f.driver.tick(f.r);assert.equal(f.clicks,0);assert.equal(f.body,original);assert.equal(f.insertions,1);
 assert.equal(f.driver.bootstrapPrepared.size,1);
 await f.driver.tick({...f.r,bootstrap_wait:{state:'waiting_local_slot'}});
 assert.equal(f.body,original);assert.equal(f.insertions,1);assert.equal(f.calls.filter(([op])=>op==='bootstrap').length,2);
 f.free();await f.driver.tick(f.r);
 assert.equal(f.r.bootstrap_state,'sent');assert.equal(f.clicks,1);assert.equal(f.insertions,1);assert.equal(f.driver.bootstrapPrepared.size,0);
 assert.equal(f.calls.filter(([op,p])=>op==='bootstrap'&&p.state==='sending').length,3);
 assert.ok(!f.calls.some(([op,p])=>op==='page-issue'||op==='bootstrap'&&p.state==='unknown'));
 await f.driver.tick({...f.r,paused:true});assert.equal(f.clicks,1);
});
test('only the unchanged original prepared body, page, scope and model can resume after a local-slot wait',async()=>{
 for(const change of ['user-body','document','account','scope','model']){
  const f=waitingPreparation();await f.driver.tick(f.r);const original=f.body;
  if(change==='user-body')f.edit('用户正在编辑的草稿  ');
  if(change==='document')f.p.documentGeneration++;
  if(change==='account')f.p.account='B';
  if(change==='scope')f.r.write_paths=['other'];
  if(change==='model')f.model({model:'GPT-6',effort:'高'});
  f.free();await f.driver.tick(f.r);
  assert.equal(f.clicks,0,change);assert.equal(f.insertions,1,change);assert.equal(f.r.bootstrap_state,'pending',change);
  assert.equal(f.body,change==='user-body'?'用户正在编辑的草稿  ':original,change);
  assert.equal(f.driver.bootstrapPrepared.size,0,change);
  assert.equal(f.calls.filter(([op,p])=>op==='bootstrap'&&p.state==='sending').length,1,change);
  assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'control_failed',change);
 }
});
test('unknown bootstrap admission or sole-Send replies discard prepared ownership and never replay',async()=>{
 for(const stage of ['admission','send','same-error-after-send']){
  const f=waitingPreparation();await f.driver.tick(f.r);f.free();
  const error=stage==='admission'?'runtime_reply_lost':stage==='send'?'page_dom_timeout':'managed_bootstrap_waiting_local_slot';
  if(stage==='admission')f.admissionError(error);else f.sendError(error);
  await assert.rejects(f.driver.tick(f.r),new RegExp(error));
  assert.equal(f.r.bootstrap_state,'unknown');assert.equal(f.driver.bootstrapPrepared.size,0);assert.equal(f.clicks,stage==='admission'?0:1);
  const calls=f.calls.length,actions=f.actions.length;
  await f.driver.tick({...f.r,paused:true});
  assert.equal(f.clicks,stage==='admission'?0:1);assert.equal(f.insertions,1);
  assert.ok(f.calls.slice(calls).every(([op])=>op!=='bootstrap'));assert.deepEqual(f.actions.slice(actions),['snapshot']);
 }
});
test('changes during accepted cached admission are caught against the live row/model with zero Send and retained unknown admission',async()=>{
 for(const change of ['scope','replaced-row','bootstrap-model-contract','actual-effort','last-moment-effort']){
  const f=waitingPreparation();await f.driver.tick(f.r);const original=f.body;f.free();
  f.afterAdmission(async()=>{
   await Promise.resolve();
   if(change==='scope')f.r.write_paths=['other'];
   if(change==='replaced-row')f.driver.records.set(f.p.id,{...f.r,write_paths:['other']});
   if(change==='bootstrap-model-contract')f.r.bootstrap_model_selection={...f.r.bootstrap_model_selection,effort:'高'};
   if(change==='actual-effort')f.model({...f.r.bootstrap_model_selection,effort:'高'});
  });
  if(change==='last-moment-effort')f.beforeSoleSend(()=>f.model({...f.r.bootstrap_model_selection,effort:'高'}));
  await assert.rejects(f.driver.tick(f.r),error=>error.code==='send_page_identity_changed'||
    /send_preparation_identity_changed|send_preparation_model_changed|send_model_selection_mismatch/.test(error.message));
  assert.equal(f.clicks,0,change);assert.equal(f.insertions,1,change);assert.equal(f.body,original,change);
  assert.equal(f.r.bootstrap_state,'unknown',change);assert.equal(f.driver.bootstrapPrepared.size,0,change);
  const calls=f.calls.length;await f.driver.tick({...f.r,paused:true});
  assert.equal(f.clicks,0,change);assert.ok(f.calls.slice(calls).every(([op])=>op!=='bootstrap'),change);
 }
});
test('a stale cache-formation list cannot overwrite a newer live scope/model contract or acquire prepared ownership',async()=>{
 for(const change of ['scope','bootstrap-model']){
  const f=waitingPreparation();let newer;
  f.duringList(async()=>{
   await Promise.resolve();newer={...f.r,...(change==='scope'?{write_paths:['new-live-scope']}:
    {bootstrap_model_selection:{...f.r.bootstrap_model_selection,effort:'高'}})};
   f.driver.records.set(f.p.id,newer);
  });
  await f.driver.tick(f.r);
  assert.equal(f.driver.records.get(f.p.id),newer,change);assert.equal(f.driver.bootstrapPrepared.size,0,change);
  assert.equal(f.clicks,0,change);assert.equal(f.insertions,1,change);assert.equal(f.r.bootstrap_state,'pending',change);
  assert.equal(f.calls.find(([op])=>op==='page-issue')[1].kind,'control_failed',change);
 }
});
test('restart or an identical user draft cannot create ownership of an unsent bootstrap preparation',async()=>{
 const f=waitingPreparation();await f.driver.tick(f.r);const original=f.body;f.driver.stop();f.free();
 const restarted=new WebDriver(f.options);restarted.records.set(f.p.id,f.r);
 restarted.selectModel=async()=>assert.fail('a restored draft is not an owned preparation');
 await restarted.tick(f.r);
 assert.equal(f.body,original);assert.equal(f.clicks,0);assert.equal(f.insertions,1);assert.equal(f.r.bootstrap_state,'pending');
 assert.equal(restarted.bootstrapPrepared.size,0);assert.equal(f.calls.filter(([op])=>op==='bootstrap').length,1);
});

test('worker uses extra high for enrollment, then verifies Pro without another Send',async()=>{
  const calls=[],choices=[],sends=[];const initial={model:'GPT-5.6 · 最新',effort:'极高'};
  const r={page_id:'worker',parent_target:'master',phase:'reserved',bootstrap_state:'pending',bootstrap_text:'enroll',model:initial.model,effort:'Pro',bootstrap_model_selection:initial,work_model_pending:true,url:'https://chatgpt.com/c/worker'};
  const p={id:r.page_id,view:{webContents:{getURL:()=>r.url}}};
  const runtime=new EventEmitter();runtime.call=async(op,payload)=>{calls.push([op,payload]);return {};};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){},layout(){}},onNotice(){},dom:readyComposer(r.url)});
  d.selectModel=async(_p,expected)=>{choices.push(expected.effort);return {model:expected.model,effort:expected.effort};};
  d.send=async(_p,prompt,_baseline,_marker,_context,beforeSend)=>{await beforeSend();sends.push(prompt);return {};};
  await d.tick(r);
  assert.deepEqual(choices,['极高']);assert.equal(sends.length,1);
  assert.ok(calls.some(([op,p])=>op==='bootstrap-model-ready'&&p.model_selection.effort==='极高'));
  await d.tick({...r,phase:'bound'});
  assert.deepEqual(choices,['极高','Pro']);assert.equal(sends.length,1);
  assert.ok(calls.some(([op,p])=>op==='work-model-ready'&&p.model_selection.effort==='Pro'));
  assert.ok(!calls.some(([op])=>op==='wire'));
});

test('unavailable work model stops branch without dispatching with the enrollment model',async()=>{
  const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
  const p={id:'worker',view:{webContents:{getURL:()=> 'https://chatgpt.com/c/worker'}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async()=>({url:'https://chatgpt.com/c/worker',editor:true,controlKnown:true})});
  d.selectModel=async()=>{throw Object.assign(Error('Pro unavailable'),{code:'worker_model_unavailable'});};
  await d.tick({page_id:p.id,phase:'bound',url:'https://chatgpt.com/c/worker',work_model_pending:true});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'page-issue');assert.equal(calls[0][1].kind,'model_unavailable');
});

test('bare Pro setup pauses as a local configuration issue before Send',async()=>{
  const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
  const p={id:'legacy',view:{webContents:{getURL:()=> 'https://chatgpt.com/c/legacy'}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async()=>({url:'https://chatgpt.com/c/legacy',editor:true,controlKnown:true})});
  d.selectModel=async()=>assert.fail('must not probe Pro for setup');d.send=async()=>assert.fail('must not Send');
  await d.tick({page_id:p.id,phase:'reserved',bootstrap_state:'pending',model:'GPT-6 · 最新',effort:'Pro',first_turn_instructions:''});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'page-issue');assert.equal(calls[0][1].kind,'preparation_required');
});

test('explicit Pro research preparation reaches Send once; paused and uncertain turns are retained',async()=>{
  const calls=[],sends=[],url='https://chatgpt.com/c/preparation';
  const row={page_id:'research',phase:'reserved',bootstrap_state:'pending',model:'GPT-6 · 最新',effort:'Pro',
    bootstrap_model_selection:{model:'GPT-6 · 最新',effort:'Pro'},first_turn_instructions:'Complete the research plan',bootstrap_text:'saved research preparation'};
  const runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);if(op==='bootstrap')row.bootstrap_state=p.state;return {};};
  const p={id:row.page_id,view:{webContents:{getURL:()=>url}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:readyComposer(url)});
  d.selectModel=async()=>row.bootstrap_model_selection;
  d.send=async(_p,text,_baseline,_marker,_context,beforeSend)=>{await beforeSend();sends.push(text);};
  await d.tick({...row,paused:true});assert.equal(sends.length,0);
  await d.tick(row);assert.equal(sends.length,1);assert.match(sends[0],/saved research preparation/);
  assert.equal(calls.find(([op])=>op==='bootstrap-model-ready')[1].model_selection.effort,'Pro');
  await d.tick(row);await d.tick({...row,bootstrap_state:'unknown'});assert.equal(sends.length,1);
  assert.ok(!calls.some(([op,p])=>op==='page-issue'&&['model_unavailable','preparation_required'].includes(p.kind)));
  assert.ok(calls.some(([op,p])=>op==='page-issue'&&p.kind==='bootstrap_receipt_missing'));
});

test('refresh refuses an unresolved receipt and permits only proven idle navigation without Send',async()=>{
  let reloads=0;const pool=new BrowserPool({networkGuard:{ready:true}});
  const p={id:'one',paused:true,status:'idle',domReady:true,observation:{model:{}},view:{webContents:{reload:()=>reloads++,isDestroyed:()=>false}}};
  const other={id:'two',status:'running'};pool.pages.set(p.id,p);pool.pages.set(other.id,other);pool.selected=p.id;
  const runtime=new EventEmitter();runtime.call=async()=>assert.fail('refresh called runtime');
  let snapshot={editor:true,controlKnown:true,generating:false,draft:false,composing:false,approvalRequired:false};const d=new WebDriver({runtime,pool,onNotice(){},dom:async()=>snapshot});
  const original={attempt:'existing-unknown'};d.pending.set(p.id,original);
  await assert.rejects(d.refresh(p),/回执待核对/);assert.equal(reloads,0);assert.equal(d.pending.get(p.id),original);
  d.pending.delete(p.id);await d.refresh(p);assert.equal(reloads,1);assert.equal(p.status,'loading');assert.equal(p.paused,true);
  assert.equal(d.pending.has(p.id),false);assert.equal(pool.pages.get(other.id),other);assert.equal(pool.selected,p.id);
  snapshot={draft:true};await assert.rejects(()=>d.refresh(p),/未发送内容/);assert.equal(reloads,1);
  snapshot={editor:true,controlKnown:true,generating:false,draft:false,composing:false,approvalRequired:false};d.busy.add(p.id);await assert.rejects(()=>d.refresh(p),/回执/);assert.equal(reloads,1);d.busy.clear();
  pool.networkGuard.ready=false;await assert.rejects(()=>d.refresh(p),/VPN/);assert.equal(reloads,1);
});

test('later public enrollment replies update diagnostics under pause; never resend or open model menus',async()=>{
  const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
  const r={page_id:'paused',phase:'reserved',bootstrap_state:'sent',paused:true,attention:'first error'};
  const s={url:'https://chatgpt.com/c/original',complete:true,editor:true,userId:'original',assistantId:'reply-one',publicText:'first reply'};
  const p={id:r.page_id,view:{webContents:{getURL:()=>s.url}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async(_wc,op)=>{assert.equal(op,'snapshot');return s;}});
  await d.tick(r);await d.tick(r);assert.equal(calls.length,1);assert.equal(calls[0][0],'intake-observed');
  s.assistantId='reply-two';s.publicText='平台安全检查拦截';await d.tick(r);
  assert.equal(calls.length,2);assert.equal(calls[1][1].public_text,s.publicText);
  // A restart reuses the persisted public report cursor.
  delete p.intakeReportHash;
  await d.tick({...r,intake:{latest_public_reply:{source_hash:calls[1][1].source_hash}}});
  assert.equal(calls.length,2);assert.ok(calls.every(([op])=>op==='intake-observed'));
});

test('editing enrollment scope cannot run during a live turn and never clicks Send',async()=>{
  const runtime=new EventEmitter(),calls=[];runtime.call=async(op,p)=>{calls.push([op,p]);return {state:'scope_saved'};};
  let generating=true;const page={id:'paused',view:{webContents:{}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]])},onNotice(){},dom:async(_wc,op)=>{assert.equal(op,'snapshot');return {generating};}});
  d.reconcileAll=async()=>{};
  await assert.rejects(()=>d.configureIntake(page,{}),/网页仍在执行/);assert.deepEqual(calls,[]);
  generating=false;await d.configureIntake(page,{access:'write',write_paths:['notes'],expected_access:'read',expected_write_paths:[]});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'configure-intake');assert.equal(calls[0][1].page_id,page.id);
});

test('paused enrollment binds only a complete exact local marker, without resuming or sending',async()=>{
  const calls=[],runtime=new EventEmitter();runtime.call=async(op,p)=>{calls.push([op,p]);return {};};
  const r={page_id:'paused',phase:'receiver_enrolled',bootstrap_state:'sent',paused:true,attention:'old error',marker:'CLW-MANAGED:exact'};
  const s={url:'https://chatgpt.com/c/original',complete:true,editor:true,userId:'original',assistantId:'reply',publicText:'CLW-MANAGED:another'};
  const p={id:r.page_id,view:{webContents:{getURL:()=>s.url}}};
  const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async(_wc,op)=>{assert.equal(op,'snapshot');return s;}});
  await d.tick(r);assert.ok(!calls.some(([op])=>op==='bind'));
  s.publicText=r.marker;s.generating=true;await d.tick(r);assert.ok(!calls.some(([op])=>op==='bind'));
  s.generating=false;await d.tick(r);
  assert.equal(calls.filter(([op])=>op==='bind').length,1);
  assert.ok(calls.every(([op])=>['intake-observed','bind'].includes(op)));
  assert.equal(r.paused,true);
});

test('slow public send confirmation waits beyond five seconds and clicks Send only once',async()=>{
  let polls=0,sends=0,body='';const url='https://chatgpt.com/c/original';
  const p={id:'original',account:'B',documentGeneration:1,view:{webContents:{getURL:()=>url}}};
  const baseline={url,userId:'old',assistantId:'old-answer'};
  const d=new WebDriver({runtime:new EventEmitter(),pool:{pages:new Map([[p.id,p]])},onNotice(){},sleep:async()=>{},dom:async(_wc,op,arg)=>{
    if(op==='connector-state')return {editorCount:1,text:body,selected:['Local-MCP-B'],visibleSelectedCount:1};
    if(op==='insert-plain-text')body=arg.text;
    if(op==='editor-text')return {text:body};
    if(op==='send'){assert.equal(arg.expectedConnector,'Local-MCP-B');assert.equal(arg.expectedText,body);sends++;}
    if(op==='snapshot')return sends?(++polls<30?{...baseline,draft:true}:{...baseline,userId:'new',userText:'goal [CLW:original]',draft:false}):{...baseline,draft:!!body};
    return {};
  }});
  const result=await d.send(p,'goal [CLW:original]',baseline,'[CLW:original]');
  assert.equal(result.userId,'new');assert.equal(polls,30);assert.equal(sends,1);
});
