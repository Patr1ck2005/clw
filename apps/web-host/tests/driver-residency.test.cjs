'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {BrowserPool}=require('../browser-pool.cjs');
const {WebDriver}=require('../web-driver.cjs');

const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function settled(){await turn();await turn();}
function record(id,extra={}){
  return {page_id:id,url:`https://chatgpt.com/c/${id}`,title:`History ${id}`,root:'D:/owned-project',
    account:'B',phase:'bound',paused:true,model:'GPT-6',effort:'Pro',
    latest_request:{id:`request-${id}`,phase:'completed'},...extra};
}
function fixture(initial,{snapshot,onAdmission,approvals}={}){
  let rows=initial;
  const created=[],closed=[],navigations=[],domCalls=[],runtimeCalls=[],notices=[];
  class View{
    constructor(options){
      this.options=options;created.push(this);let destroyed=false,currentUrl='about:blank';
      this.webContents=Object.assign(new EventEmitter(),{
        session:{partition:options.webPreferences.partition},
        setWindowOpenHandler(){},isDestroyed:()=>destroyed,getURL:()=>currentUrl,
        loadURL:async url=>{currentUrl=url;navigations.push({view:this,url});},
        close:()=>{destroyed=true;closed.push(this);},
        debugger:{isAttached:()=>true,sendCommand:async()=>({})},
      });
    }
    setBounds(bounds){this.bounds=bounds;}
    setVisible(visible){this.visible=visible;}
  }
  const pool=new BrowserPool({
    window:{getContentSize:()=>[1440,960],isVisible:()=>true,isMinimized:()=>false,isFocused:()=>false,
      contentView:{addChildView(){},removeChildView(){}}},
    WebContentsView:View,partitionForAccount:account=>`persist:residency-${account}`,
    allowedUrl:url=>url.startsWith('https://chatgpt.com/'),
    ...(onAdmission?{accountAccessFor:account=>({assertCanStart(){},admitNavigation:()=>onAdmission(account),read:()=>({blocked:false})})}:{}),
  });
  const runtime=new EventEmitter();runtime.ready=true;
  runtime.call=async(op,args)=>{
    runtimeCalls.push({op,args});
    if(op==='list')return {pages:rows};
    if(op==='pending-receipt')return {state:'idle'};
    if(op==='wire'){
      assert.equal(args.data.action,'pulse','a ready page may observe its original request but cannot dispatch');
      return {state:'idle'};
    }
    // Ready public pages may read receipts; residency never initiates work.
    assert.fail(`unexpected runtime mutation: ${op}`);
  };
  const driver=new WebDriver({runtime,pool,onNotice:message=>notices.push(message),approvals,
    metadata:id=>({kind:'task',logicalId:id}),
    dom:async(wc,op)=>{
      domCalls.push({wc,op});assert.equal(op,'snapshot','residency never opens model menus or sends');
      return snapshot?await snapshot(wc,pool,driver):{
        url:wc.getURL(),editor:true,controlKnown:true,generating:false,
        userId:'original-public-user-turn',historyAtLatest:true,
        draft:false,composing:false,approvalRequired:false,known:true,
      };
    },
    input:{key:async()=>assert.fail('residency sent keyboard input'),insert:async()=>assert.fail('residency inserted text')},
  });
  return {pool,driver,created,closed,navigations,domCalls,runtimeCalls,notices,
    rows:()=>rows,setRows:next=>{rows=next;},
    reconcile:async()=>{await driver.reconcileAll();await settled();}};
}
function assertReadOnly(f){
  assert.ok(f.runtimeCalls.every(call=>
    ['list','pending-receipt'].includes(call.op)||(call.op==='wire'&&call.args.data.action==='pulse')));
  assert.ok(f.domCalls.every(call=>call.op==='snapshot'),'no swallowed driver failure can hide a Send or model action');
}

test('many paused and completed histories stay logical across repeated reconciliation without DOM or Send',async()=>{
  const rows=Array.from({length:120},(_,n)=>record(`history-${n}`,n%3===0
    ?{latest_request:{id:`queued-${n}`,phase:'queued'}}:n%3===1
      ?{paused:false,latest_request:{id:`completed-${n}`,phase:'completed'}}:{}));
  const f=fixture(rows);
  for(let n=0;n<4;n++)await f.reconcile();
  assert.equal(f.pool.pages.size,120);assert.equal(f.driver.records.size,120);
  assert.equal(f.created.length,0);assert.equal(f.navigations.length,0);assert.equal(f.domCalls.length,0);
  assert.ok(f.pool.inspect().every(page=>page.resident===false&&page.rendererState==='unloaded'));
  for(const row of rows){const page=f.pool.pages.get(row.page_id);assert.equal(page.url,row.url);assert.equal(page.account,row.account);}
  assertReadOnly(f);
});

test('closed terminal attention and explicit pre-send refusal stay logical without hydrating historical renderers',async()=>{
  const rows=[record('completed-attention',{attention:'original unresolved note'}),
    record('blocked-refusal',{attention:'original refusal',issue_kind:'control_failed',latest_request:{id:'original-refusal',phase:'blocked'}}),
    record('setup-refusal',{phase:'reserved',bootstrap_state:'pending',issue_kind:'model_unavailable',latest_request:null})];
  const f=fixture(rows);f.driver.isClosed=()=>true;
  for(let n=0;n<20;n++)await f.reconcile();
  assert.equal(f.created.length,0);assert.equal(f.navigations.length,0);assert.equal(f.domCalls.length,0);
  for(const row of rows){assert.equal(f.driver.records.get(row.page_id),row);assert.equal(row.attention,rows.find(r=>r.page_id===row.page_id).attention);}
  assertReadOnly(f);
});

test('a closed completed page with retained attention releases only after a fresh idle observation',async()=>{
  const original=record('closed-completed',{account:'A',attention:'original attention stays',issue_kind:'control_failed'});
  const f=fixture([original]);f.driver.isClosed=()=>true;const page=await f.pool.create(original.page_id,original.url,{account:'A'});await settled();page.domReady=true;
  const view=page.view;await f.reconcile();
  assert.equal(page.view,null);assert.equal(view.webContents.isDestroyed(),true);assert.equal(f.closed.length,1);assert.equal(f.domCalls.length,1);
  assert.equal(f.driver.records.get(original.page_id).latest_request.id,original.latest_request.id);assert.equal(original.attention,'original attention stays');assert.equal(original.issue_kind,'control_failed');
  await f.reconcile();assert.equal(f.created.length,1,'history remains unloaded after release');assertReadOnly(f);
});

test('closed attention still pins accepted and unknown original turns while independent terminal histories unload',async()=>{
  const rows=['processing','suspended','unknown'].map(phase=>record('closed-'+phase,{attention:'original issue',issue_kind:'control_failed',latest_request:{id:'original-'+phase,phase,attempt_id:'same-accepted-'+phase}}));
  rows.push(record('closed-sent-bootstrap',{phase:'reserved',bootstrap_state:'sent',issue_kind:'bootstrap_receipt_missing',latest_request:null}));
  const f=fixture(rows);f.driver.isClosed=()=>true;await f.reconcile();await f.reconcile();
  assert.equal(f.created.length,rows.length);assert.equal(f.closed.length,0);assert.ok(f.pool.inspect().every(page=>page.resident));
  assertReadOnly(f);
});

test('seventy independently processing conversations all materialize with usable viewports and no hard cap',async()=>{
  const rows=Array.from({length:70},(_,n)=>record(`live-${n}`,{
    account:n%2?'A':'B',paused:false,active_work:true,
    latest_request:{id:`accepted-${n}`,phase:'processing',attempt_id:`original-${n}`},
  }));
  const f=fixture(rows);await f.reconcile();await f.reconcile();
  assert.equal(f.pool.pages.size,70);assert.equal(f.created.length,70);assert.equal(f.navigations.length,70);
  assert.ok(f.pool.inspect().every(page=>page.resident));
  for(const row of rows){const page=f.pool.pages.get(row.page_id);
    assert.equal(page.view.options.webPreferences.partition,`persist:residency-${row.account}`);
    assert.ok(page.view.visible&&page.view.bounds.width>=800&&page.view.bounds.height>=600);
    assert.ok(f.domCalls.some(call=>call.wc===page.view.webContents));
  }
  assert.equal(f.closed.length,0);assertReadOnly(f);
});

test('paused accepted requests and unknown enrollment sends remain resident for their original receipts',async()=>{
  const rows=[
    record('processing',{latest_request:{id:'original-processing',phase:'processing',cancel_requested:true}}),
    record('suspended',{latest_request:{id:'original-suspended',phase:'suspended'}}),
    record('queued-attempt',{latest_request:{id:'original-attempt',phase:'queued',attempt_id:'accepted-attempt'}}),
    record('queued-hash',{latest_request:{id:'original-hash',phase:'queued',sent_user_hash:'accepted-user-hash'}}),
    ...['sending','sent','unknown'].map(state=>record(`bootstrap-${state}`,{phase:'reserved',bootstrap_state:state,latest_request:null})),
    record('enrolled',{phase:'receiver_enrolled',bootstrap_state:'pending',latest_request:null}),
  ];
  const f=fixture(rows);await f.reconcile();await f.reconcile();
  assert.equal(f.created.length,rows.length);assert.ok(f.pool.inspect().every(page=>page.resident));
  assert.equal(f.closed.length,0);assertReadOnly(f);
});

test('resuming an unsent original queue restores the same logical page, account and URL exactly once',async()=>{
  const original=record('same-history',{account:'A',latest_request:{id:'same-request',phase:'queued',payload_hash:'original-payload'}});
  const f=fixture([original]);await f.reconcile();const logical=f.pool.pages.get(original.page_id);
  assert.equal(f.created.length,0);
  const resumed={...original,paused:false};f.setRows([resumed]);await f.reconcile();await f.reconcile();await f.reconcile();
  assert.equal(f.pool.pages.get(original.page_id),logical);assert.equal(logical.id,original.page_id);
  assert.equal(logical.account,'A');assert.equal(logical.url,original.url);
  assert.equal(logical.view.options.webPreferences.partition,'persist:residency-A');
  assert.equal(f.driver.records.get(original.page_id).latest_request.id,'same-request');
  assert.equal(f.driver.records.get(original.page_id).latest_request.payload_hash,'original-payload');
  assert.equal(f.created.length,1);assert.equal(f.navigations.length,1);assert.equal(f.navigations[0].url,original.url);
  assertReadOnly(f);
});

test('a pre-registered saved homepage restores the canonical bound conversation in the same account exactly once',async()=>{
  const row=record('bound-original',{account:'A',latest_request:{id:'accepted-original-request',phase:'processing'}});
  const f=fixture([row]);
  const savedWorkspace=new Map([[row.page_id,{url:'https://chatgpt.com/',account:'A'}]]);
  const logical=f.pool.register(row.page_id,savedWorkspace.get(row.page_id).url,{account:'A'});
  // Main registers saved descriptors first; syncBindings then updates workspace
  // metadata. That metadata update alone cannot change an existing descriptor.
  f.driver.onRecords=rows=>{for(const current of rows)savedWorkspace.set(current.page_id,{url:current.url,account:current.account});};
  await f.reconcile();await f.reconcile();await f.reconcile();
  assert.equal(savedWorkspace.get(row.page_id).url,row.url);
  assert.equal(f.pool.pages.get(row.page_id),logical);assert.equal(logical.account,'A');
  assert.equal(logical.url,row.url);assert.equal(logical.view.webContents.getURL(),row.url);
  assert.equal(logical.view.options.webPreferences.partition,'persist:residency-A');
  assert.equal(f.navigations.length,1);assert.equal(f.navigations[0].url,row.url);assert.equal(f.created.length,1);
  assert.equal(f.driver.records.get(row.page_id).latest_request.id,'accepted-original-request');
  assertReadOnly(f);
});

test('a selected logical history remains resident while the native browser view is hidden',async()=>{
  const row=record('selected-nonnative'),f=fixture([row]);
  const logical=f.pool.register(row.page_id,row.url,{account:row.account});f.pool.select(row.page_id);
  assert.equal(f.pool.native,false);
  await f.reconcile();await f.reconcile();await f.reconcile();
  assert.equal(f.pool.pages.get(row.page_id),logical);assert.equal(f.pool.selected,row.page_id);
  assert.equal(f.pool.isLoaded(row.page_id),true);assert.equal(f.created.length,1);assert.equal(f.closed.length,0);
  assert.ok(f.domCalls.length>0);assertReadOnly(f);
});

for(const incomplete of [{editor:false,controlKnown:false},{editor:false,controlKnown:true},{editor:true,controlKnown:false}]){
  test(`DOM-ready idle with editor=${incomplete.editor} controlKnown=${incomplete.controlKnown} stays resident until the public page is ready`,async()=>{
    const row=record(`incomplete-${Number(incomplete.editor)}-${Number(incomplete.controlKnown)}`);let ready=false;
    const f=fixture([row],{snapshot:async wc=>({
      url:wc.getURL(),editor:ready||incomplete.editor,controlKnown:ready||incomplete.controlKnown,
      userId:'original-public-user-turn',historyAtLatest:true,generating:false,
      draft:false,composing:false,approvalRequired:false,known:true,
    })});
    const logical=await f.pool.create(row.page_id,row.url);await settled();logical.domReady=true;
    logical.observation={at:Date.now()-100,generating:false,draft:false,composing:false,approvalRequired:false};
    const oldView=logical.view;await f.reconcile();await f.reconcile();
    assert.equal(logical.view,oldView);assert.equal(oldView.webContents.isDestroyed(),false);assert.equal(f.closed.length,0);
    ready=true;await f.reconcile();
    assert.equal(logical.view,null);assert.equal(oldView.webContents.isDestroyed(),true);assert.equal(f.closed.length,1);
    assert.equal(f.pool.pages.get(row.page_id),logical);assert.equal(f.created.length,1);assertReadOnly(f);
  });
}

test('a freshly verified idle renderer is released while its original task and request remain intact',async()=>{
  const row=record('idle-original',{account:'A'}),f=fixture([row]);
  const page=await f.pool.create(row.page_id,row.url,{account:row.account});await settled();
  page.domReady=true;page.observation={at:Date.now()-1000,generating:true};
  const oldView=page.view;await f.reconcile();
  assert.equal(f.pool.pages.get(row.page_id),page);assert.equal(page.view,null);
  assert.equal(oldView.webContents.isDestroyed(),true);assert.equal(f.closed.length,1);
  assert.equal(f.driver.records.get(row.page_id).latest_request.id,row.latest_request.id);
  assert.equal(page.url,row.url);assert.equal(page.account,'A');
  assert.equal(f.domCalls.length,1,'release performs a fresh read instead of trusting cached activity');
  await f.reconcile();assert.equal(f.created.length,1);assert.equal(f.domCalls.length,1);assertReadOnly(f);
});

for(const hazard of ['draft','generating','composing','approvalRequired','navigation','selection']){
  test(`a fresh ${hazard} after cached idle keeps the renderer resident`,async()=>{
    const row=record(`protected-${hazard}`);let reads=0;
    const f=fixture([row],{snapshot:async(wc,pool)=>{
      reads++;
      if(hazard==='navigation'&&reads===1){
        wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});wc.emit('did-start-loading');
      }
      if(hazard==='selection'&&reads===1){pool.native=true;pool.select(row.page_id);}
      return {url:wc.getURL(),editor:true,controlKnown:true,generating:false,known:true,
        userId:'original-public-user-turn',historyAtLatest:true,
        draft:false,composing:false,approvalRequired:false,
        ...(['draft','generating','composing','approvalRequired'].includes(hazard)?{[hazard]:true}:{}),
      };
    }});
    const page=await f.pool.create(row.page_id,row.url);await settled();page.domReady=true;
    page.observation={at:Date.now()-100,generating:false,draft:false,composing:false,approvalRequired:false};
    const oldView=page.view;await f.reconcile();
    assert.equal(page.view,oldView);assert.equal(oldView.webContents.isDestroyed(),false);assert.equal(f.closed.length,0);
    assert.ok(reads>=1);assertReadOnly(f);
  });
}

test('an unreadable fresh page stays resident and does not stop an independent live conversation',async()=>{
  const unreadable=record('unreadable'),live=record('independent-live',{paused:false,latest_request:{id:'live-request',phase:'processing'}});
  const f=fixture([unreadable,live],{snapshot:async wc=>{
    if(wc.getURL()===unreadable.url)throw Error('public_dom_temporarily_unreadable');
    return {url:wc.getURL(),editor:true,controlKnown:true,generating:false,known:true,userId:'original-live-turn',historyAtLatest:true};
  }});
  const oldPage=await f.pool.create(unreadable.page_id,unreadable.url);await settled();oldPage.domReady=true;
  oldPage.observation={at:Date.now()-100,generating:false};const oldView=oldPage.view;
  await f.reconcile();
  assert.equal(oldPage.view,oldView);assert.equal(f.pool.isLoaded(live.page_id),true);
  assert.ok(f.domCalls.some(call=>call.wc===f.pool.pages.get(live.page_id).view.webContents));
  assert.equal(f.closed.length,0);assertReadOnly(f);
});

test('one renderer admission failure preserves its descriptor and permits another live page to load',async()=>{
  const failed=record('failed-admission',{account:'A',latest_request:{id:'failed-original',phase:'processing'}});
  const live=record('healthy-admission',{account:'B',paused:false,latest_request:{id:'healthy-original',phase:'processing'}});
  const f=fixture([failed,live],{onAdmission:async account=>{if(account==='A')throw Error('renderer_admission_temporary_failure');}});
  await f.reconcile();
  assert.equal(f.pool.pages.get(failed.page_id).account,'A');assert.equal(f.pool.isLoaded(failed.page_id),false);
  assert.equal(f.driver.records.get(failed.page_id).latest_request.id,'failed-original');
  assert.equal(f.pool.isLoaded(live.page_id),true);assert.equal(f.created.length,1);
  assert.ok(f.notices.some(message=>/renderer_admission_temporary_failure/.test(message)));
  assertReadOnly(f);
});

test('hydration retries use bounded batches and recover the unchanged original state after cooldown',async()=>{
  const original=record('retry-original',{account:'A',latest_request:{id:'same-original-request',phase:'processing'}});
  const live=record('retry-independent',{account:'B',paused:false,latest_request:{id:'live-original-request',phase:'processing'}});
  let attempts=0,allow=false;
  const f=fixture([original,live],{onAdmission:async account=>{
    if(account==='A'){attempts++;if(!allow)throw Error('renderer_retry_original_failure');}
  }});
  await f.reconcile();assert.equal(attempts,1);
  assert.ok(f.driver.hydrationFailures.get(original.page_id).next>Date.now());
  await f.reconcile();await f.reconcile();assert.equal(attempts,1,'backoff prevents immediate admission loops');
  for(let count=2;count<=3;count++){
    f.driver.hydrationFailures.get(original.page_id).next=0;await f.reconcile();
    assert.equal(attempts,count);assert.equal(f.driver.hydrationFailures.get(original.page_id).count,count);
    await f.reconcile();assert.equal(attempts,count);
  }
  for(let n=0;n<5;n++)await f.reconcile();
  assert.equal(attempts,3,'the same state does not retry during cooldown after the third failed admission');
  assert.equal(f.notices.filter(message=>message==='renderer_retry_original_failure').length,2);
  assert.equal(f.pool.isLoaded(live.page_id),true);assert.equal(f.pool.isLoaded(original.page_id),false);
  const logical=f.pool.pages.get(original.page_id);
  allow=true;f.driver.hydrationFailures.get(original.page_id).next=0;await f.reconcile();await f.reconcile();
  assert.equal(attempts,4);assert.equal(f.pool.pages.get(original.page_id),logical);
  assert.equal(f.pool.isLoaded(original.page_id),true);assert.equal(f.driver.hydrationFailures.has(original.page_id),false);
  assert.equal(f.driver.records.get(original.page_id).latest_request.id,'same-original-request');
  assert.equal(f.driver.records.get(original.page_id).paused,true,'recovery never clears explicit pause');
  assertReadOnly(f);
});

test('an original attempt result candidate pins its owning page until collection finishes',async()=>{
  const attempt='control_original_result';
  const row=record('result-owner',{latest_request:{id:'same-result-request',phase:'completed',attempt_id:attempt}});
  const f=fixture([row]);f.driver.resultCandidates.set(attempt,{signature:'original-candidate',at:Date.now()});
  await f.reconcile();await f.reconcile();const logical=f.pool.pages.get(row.page_id);
  assert.equal(f.created.length,1);assert.equal(f.pool.isLoaded(row.page_id),true);assert.equal(f.closed.length,0);
  assert.equal(f.driver.resultCandidates.get(attempt).signature,'original-candidate');
  logical.domReady=true;f.driver.resultCandidates.delete(attempt);await f.reconcile();
  assert.equal(f.pool.isLoaded(row.page_id),false);assert.equal(f.closed.length,1);
  assert.equal(f.driver.records.get(row.page_id).latest_request.id,'same-result-request');assertReadOnly(f);
});

for(const pin of ['pending','approvalBusy']){
  test(`a local ${pin} protects a logical history through reconciliation`,async()=>{
    const row=record(`local-${pin}`),approvals={busy:new Set()},f=fixture([row],{approvals});
    if(pin==='pending')f.driver.pending.set(row.page_id,{attempt:'accepted-original-attempt'});
    if(pin==='approvalBusy')approvals.busy.add(row.page_id);
    await f.reconcile();await f.reconcile();
    assert.equal(f.created.length,1);assert.equal(f.pool.isLoaded(row.page_id),true);assert.equal(f.closed.length,0);
    assertReadOnly(f);
  });
}

test('a saved safety hint restores the original page before fresh inspection and releases after safe observation',async()=>{
  const row=record('saved-safety-hint'),f=fixture([row]);
  const logical=f.pool.register(row.page_id,row.url,{account:row.account,residentRequired:true});
  await f.reconcile();
  assert.equal(f.created.length,1);assert.equal(f.pool.isLoaded(row.page_id),true);
  assert.equal(f.closed.length,0);assert.equal(logical.residentRequired,false);
  assert.ok(f.domCalls.some(call=>call.wc===logical.view.webContents));
  await f.reconcile();
  assert.equal(f.pool.pages.get(row.page_id),logical);assert.equal(f.pool.isLoaded(row.page_id),false);
  assert.equal(f.created.length,1);assert.equal(f.closed.length,1);assertReadOnly(f);
});

function lifecycle(row,required=false,reason='carrier_reply_saved'){
  return {...row,thread_id:row.thread_id||`thread-${row.page_id}`,renderer_lifecycle:{version:1,page_id:row.page_id,
    thread_id:row.thread_id||`thread-${row.page_id}`,request_id:row.latest_request?.id??null,
    request_phase:row.latest_request?.phase??null,attempt_id:row.latest_request?.attempt_id??null,required,reason}};
}
test('saved carrier attention and yielded business histories remain untouched without a renderer',async()=>{
  const rows=['processing','suspended'].map(phase=>lifecycle(record(`saved-${phase}`,{
    attention:'Original unresolved business',latest_request:{id:`original-${phase}`,phase,attempt_id:`attempt-${phase}`}})));
  const f=fixture(rows);f.driver.isClosed=()=>true;
  for(let n=0;n<100;n++)await f.reconcile();
  assert.equal(f.created.length,0);assert.equal(f.domCalls.length,0);
  for(const row of rows){assert.equal(f.driver.records.get(row.page_id),row);assert.equal(row.attention,'Original unresolved business');}
  assertReadOnly(f);
});
test('closed unknown bootstrap without its original conversation keeps history and never creates a pseudo homepage',async()=>{
  const rows=['reserved','receiver_enrolled'].map(phase=>lifecycle(record(`missing-original-${phase}`,{
    url:'https://chatgpt.com/',phase,bootstrap_state:'unknown',latest_request:null,attention:'Original unknown remains'}),true,'bootstrap_original_page_only'));
  const f=fixture(rows);f.driver.isClosed=()=>true;f.driver.metadata=id=>({id,account:'B',url:'https://chatgpt.com/',residentRequired:true});
  for(let n=0;n<100;n++)await f.reconcile();
  assert.equal(f.created.length,0);assert.equal(f.navigations.length,0);assert.equal(f.domCalls.length,0);
  assert.ok(rows.every(row=>row.bootstrap_state==='unknown'&&row.paused===true));assertReadOnly(f);
});
test('a same-account saved original conversation still restores and monitors an unknown bootstrap',async()=>{
  const row=lifecycle(record('recoverable-original',{url:'https://chatgpt.com/',phase:'reserved',bootstrap_state:'unknown',latest_request:null,attention:'Original unknown'}),true,'bootstrap_original_page_only');
  const f=fixture([row]);f.driver.isClosed=()=>true;
  f.driver.metadata=id=>({id,account:'B',url:'https://chatgpt.com/c/same-original-conversation'});
  await f.reconcile();assert.equal(f.created.length,1);assert.equal(f.navigations[0].url,'https://chatgpt.com/c/same-original-conversation');
  assert.equal(f.closed.length,0);assertReadOnly(f);
});
test('stale carrier projection cannot release a successor attempt or changed current request',async()=>{
  for(const replacement of [{id:'later-request',phase:'processing',attempt_id:'later-attempt'},
      {id:'original-request',phase:'processing',attempt_id:'later-attempt'}]){
    const original=lifecycle(record('newer-request',{latest_request:{id:'original-request',phase:'processing',attempt_id:'old-attempt'}}));
    const row={...original,latest_request:replacement},f=fixture([row]);f.driver.isClosed=()=>true;
    await f.reconcile();assert.equal(f.created.length,1);assert.equal(f.closed.length,0);assertReadOnly(f);
  }
});
for(const hazard of ['generating','draft','composing','approvalRequired','reading','pending','resultPending','approvalBusy']){
  test(`saved carrier business history still protects a current ${hazard}`,async()=>{
    const row=lifecycle(record(`saved-hazard-${hazard}`,{latest_request:{id:'same-request',phase:'processing',attempt_id:'same-attempt'}}));
    const approvals={busy:new Set()},f=fixture([row],{approvals,snapshot:async wc=>({url:wc.getURL(),editor:true,controlKnown:true,
      historyAtLatest:true,userId:'original-user',generating:false,draft:false,composing:false,approvalRequired:false,
      ...(['generating','draft','composing','approvalRequired'].includes(hazard)?{[hazard]:true}:{})})});
    f.driver.isClosed=()=>true;const page=await f.pool.create(row.page_id,row.url);await settled();page.domReady=true;
    if(hazard==='reading')page.pins.add('original-read');
    if(hazard==='pending')f.driver.pending.set(row.page_id,{attempt:'same-attempt'});
    if(hazard==='resultPending')f.driver.resultCandidates.set('same-attempt',{signature:'original-result'});
    if(hazard==='approvalBusy')approvals.busy.add(row.page_id);
    const original=page.view;await f.reconcile();assert.equal(page.view,original);assert.equal(f.closed.length,0);assertReadOnly(f);
  });
}
test('an already loaded saved carrier page releases from fresh idle and does not hydrate again',async()=>{
  const row=lifecycle(record('loaded-finished',{latest_request:{id:'same-request',phase:'processing',attempt_id:'same-attempt'}}));
  const f=fixture([row]);f.driver.isClosed=()=>true;const page=await f.pool.create(row.page_id,row.url);await settled();page.domReady=true;
  const view=page.view;await f.reconcile();assert.equal(view.webContents.isDestroyed(),true);assert.equal(f.closed.length,1);
  for(let n=0;n<20;n++)await f.reconcile();assert.equal(f.created.length,1);assert.equal(row.latest_request.phase,'processing');assertReadOnly(f);
});
