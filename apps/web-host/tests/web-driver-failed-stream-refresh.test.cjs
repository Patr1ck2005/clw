'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
const {WebDriver}=require('../web-driver.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const hash=value=>createHash('sha256').update(value||'').digest('hex');
const url='https://chatgpt.com/c/original',attempt='control_683c4994d6394c97abea76eb53969a7e',marker=`[CLW:${attempt}]`;
const clone=value=>JSON.parse(JSON.stringify(value));

function fixture({phase='processing',paused=true}={}){
  const record={page_id:'original-page',thread_id:'original-thread',account:'A',root:'D:/isolated-original',phase:'bound',url,paused,own_paused:paused,
    model:'GPT-6 · Latest',effort:'Pro',collaboration_protocol:'tool_v1',
    latest_request:{id:'original-request',phase,attempt_id:attempt,sent_user_hash:hash(`managed-public:${marker}:user`),cancel_requested:0}};
  const snapshot={url,editor:true,controlKnown:true,historyAtLatest:true,generating:false,rawStopPresent:true,streamInterrupted:true,processingNotice:true,
    draft:false,composing:false,approvalRequired:false,accessLimited:false,blocked:false,loginRequired:false,complete:false,stopped:false,
    userId:`managed-public:${marker}:user`,assistantId:`managed-public:${marker}:failed-assistant:无法思考`,
    userText:'Original work '+marker,userTextComplete:true,attemptMarker:marker,attemptMarkerCount:1,failure:'无法思考',publicText:'',html:''};
  const calls=[],actions=[],reloads=[],navigations=[],hooks={},modelCalls=[];
  let currentUrl=url;
  const wc={getURL:()=>currentUrl,isDestroyed:()=>false,
    reload(){reloads.push(currentUrl);hooks.reload?.();},
    async loadURL(target){navigations.push(target);currentUrl=target;}};
  const page={id:record.page_id,account:'A',url,paused,documentGeneration:2,domReady:true,view:{webContents:wc}};
  const access={read:()=>({blocked:false}),hold(){},assertCanStart(){},async admitNavigation(){await hooks.admission?.();}};
  const pool=new BrowserPool({networkGuard:{ready:true},allowedUrl:value=>value.startsWith('https://chatgpt.com/'),accountAccessFor:()=>access});
  pool.pages.set(page.id,page);pool.selected=page.id;pool.layout=()=>{};
  const runtime=new EventEmitter();runtime.closed=false;
  let receipt={state:'offer',attempt_id:attempt,request_id:record.latest_request.id};
  runtime.call=async(op,payload)=>{
    calls.push([op,clone(payload)]);
    if(op==='wire'){assert.equal(payload.data.action,'pulse','observation may collect the original failure but cannot dispatch/prepare/Send');return clone(receipt);}
    assert.equal(op,'pending-receipt','a paused task only reads the original receipt');return clone(receipt);
  };
  const composer={editorCount:1,text:'',selected:['Local-MCP'],visibleSelectedCount:1};
  const driver=new WebDriver({runtime,pool,onNotice(){},sleep:async()=>{},dom:async(original,action,arg)=>{
    assert.equal(original,wc);actions.push([action,arg]);
    if(action==='snapshot'){await hooks.snapshot?.();return {...snapshot};}
    assert.equal(action,'connector-state','reconnection never opens a model menu or edits the composer');return {...composer};
  }});
  driver.records.set(page.id,record);
  for(const method of ['inspect','selectModel','send'])driver[method]=async()=>{modelCalls.push(method);assert.fail('failed-stream observation cannot '+method);};
  return {driver,pool,page,wc,record,snapshot,composer,calls,actions,reloads,navigations,hooks,modelCalls,
    currentUrl(value){currentUrl=value;},receipt(value){receipt=value;}};
}

for(const phase of ['processing','suspended'])test('formal refresh reloads only the exact failed '+phase+' original and preserves pause/request with zero business calls',async()=>{
  const f=fixture({phase}),before=clone(f.record),generation=f.page.documentGeneration;
  const result=await f.driver.refresh(f.page);
  assert.deepEqual(f.reloads,[url]);assert.deepEqual(f.navigations,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.modelCalls,[]);
  assert.deepEqual(f.record,before);assert.equal(f.driver.records.get(f.page.id),f.record);assert.equal(f.page.paused,true);
  assert.equal(f.page.documentGeneration,generation+1);assert.equal(f.driver.busy.size,0);assert.match(result.message,/原任务和发送回执保留/);
});

test('failure-aware refresh and automatic reconnection refuse normal long generation, pure stream waiting and incomplete public identity',async()=>{
  const changes=[{generating:true},{failure:''},{failure:'我们的系统正在进一步处理此请求'},{failure:'连接已中断，正在等待完整答复'},
    {failure:'You have reached your Pro usage limit'},{rawStopPresent:false},{url:'https://chatgpt.com/c/foreign'},
    {attemptMarker:'[CLW:control_'+'a'.repeat(32)+']'},{attemptMarkerCount:2},{attemptMarkerCount:0},
    {userId:'foreign-user'},{historyAtLatest:false},{historyAtLatest:null},{editor:false},{controlKnown:false},{generating:undefined},
    {draft:true},{composing:true},{approvalRequired:true},{loginRequired:true},{blocked:true},{accessLimited:true},
    {loginRequired:undefined},{blocked:undefined},{accessLimited:undefined},{unknown:true},{known:false},{error:'snapshot_unknown'}];
  for(const change of changes){
    const f=fixture();Object.assign(f.snapshot,change);const before=clone(f.record);
    assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),false,JSON.stringify(change));
    await assert.rejects(f.driver.refresh(f.page),undefined,JSON.stringify(change));
    assert.deepEqual(f.reloads,[],JSON.stringify(change));assert.deepEqual(f.navigations,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.record,before);
  }
});

test('the narrow exception cannot adopt an unbound, wrong-account, unsent, unknown or cancelled original',async()=>{
  const changes=[f=>{f.record.phase='reserved';},f=>{f.record.thread_id=null;},f=>{f.record.latest_request.id=null;},
    f=>{f.record.account='B';},f=>{f.record.latest_request.phase='unknown';},f=>{f.record.latest_request.phase='queued';},
    f=>{f.record.latest_request.attempt_id='unverified';},f=>{f.record.latest_request.sent_user_hash=hash('foreign');},
    f=>{f.record.latest_request.cancel_requested=1;}];
  for(const change of changes){const f=fixture();change(f);
    assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),false);await assert.rejects(f.driver.refresh(f.page));
    assert.deepEqual(f.reloads,[]);assert.deepEqual(f.navigations,[]);assert.deepEqual(f.calls,[]);
  }
});

for(const ownership of ['foreign-pending','unknown-send','result'])test('an original '+ownership+' receipt prevents both reconnect paths without disturbing its ownership',async()=>{
  const f=fixture(),original={attempt,state:'unknown',signature:'original-signature'};
  if(ownership==='foreign-pending'){original.attempt='control_'+'d'.repeat(32);f.driver.pending.set(f.page.id,original);}
  else if(ownership==='unknown-send'){delete f.record.latest_request.sent_user_hash;f.driver.pending.set(f.page.id,original);}
  else f.driver.resultCandidates.set(attempt,original);
  assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),false);await assert.rejects(f.driver.refresh(f.page),/回执待核对/);
  assert.deepEqual(f.reloads,[]);assert.deepEqual(f.calls,[]);assert.equal(ownership==='result'?f.driver.resultCandidates.get(attempt):f.driver.pending.get(f.page.id),original);
});

for(const mode of ['formal','automatic'])test(mode+' navigation revalidates original request, renderer, account and connection after admission awaits',async t=>{
  const changes={
    request:f=>{f.driver.records.set(f.page.id,{...f.record,latest_request:{...f.record.latest_request,id:'later-request'}});},
    attempt:f=>{f.record.latest_request.attempt_id='control_'+'b'.repeat(32);},
    sentHash:f=>{f.record.latest_request.sent_user_hash=hash('new-user');},
    recordAccount:f=>{f.record.account='B';},
    pageAccount:f=>{f.page.account='B';},
    renderer:f=>{f.page.view={webContents:f.wc};},
    document:f=>{f.page.documentGeneration++;},
    connection:f=>{f.driver.connectionGeneration++;},
    url:f=>{f.currentUrl('https://chatgpt.com/c/foreign');},
    pending:f=>{f.driver.pending.set(f.page.id,{attempt:'control_'+'d'.repeat(32),state:'unknown'});},
    result:f=>{f.driver.resultCandidates.set(attempt,{state:'collecting'});},
    stopped:f=>{f.driver.stopped=true;},
    runtime:f=>{f.driver.runtime.closed=true;}
  };
  for(const [name,change] of Object.entries(changes))await t.test(name,async()=>{
    const f=fixture();f.hooks.admission=async()=>{await Promise.resolve();change(f);};
    await assert.rejects(mode==='formal'?f.driver.refresh(f.page):f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),undefined,name);
    assert.deepEqual(f.reloads,[],name);assert.deepEqual(f.navigations,[],name);assert.deepEqual(f.calls,[],name);assert.equal(f.driver.busy.size,0,name);
  });
});

for(const mode of ['formal','automatic'])test(mode+' reconnect preserves the normal dispatch/sent pending object for the positively confirmed same original attempt',async()=>{
  const f=fixture(),original={attempt,assistantBefore:hash('assistant-before-dispatch')},before=clone(f.record);
  // observePage creates this before Send and retains it after wire-sent until
  // result collection. The durable sent hash plus exact current marker prove
  // this object is the accepted original, rather than an unknown new Send.
  f.driver.pending.set(f.page.id,original);
  if(mode==='formal')await f.driver.refresh(f.page);else assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),true);
  assert.deepEqual(f.reloads,[url]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.record,before);assert.equal(f.driver.pending.get(f.page.id),original);
});

test('automatic reconnect is once per original turn even after its document changes or records are re-read',async()=>{
  const f=fixture(),before=clone(f.record);
  assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),true);
  assert.equal(await f.driver.reconnectFailedStream(f.page,clone(f.record),f.snapshot),false);
  f.page.documentGeneration+=3;
  assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),false);
  assert.deepEqual(f.reloads,[url]);assert.equal(f.driver.failedStreamReconnects.size,1);assert.deepEqual(f.calls,[]);assert.deepEqual(f.record,before);
});

test('a lost navigation reply remains attempted and cannot generate a second reload for the original turn',async()=>{
  const f=fixture();f.hooks.reload=()=>{throw Error('navigation_ack_unknown');};
  await assert.rejects(f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),/navigation_ack_unknown/);
  const original=[...f.driver.failedStreamReconnects.values()][0];assert.equal(original.state,'attempted');assert.equal(original.attempt_id,attempt);
  f.page.documentGeneration++;delete f.hooks.reload;
  assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),false);
  assert.deepEqual(f.reloads,[url]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.modelCalls,[]);
});

test('a later independently accepted original attempt has a distinct reconnect identity and no business replay',async()=>{
  const f=fixture();await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot);
  const later='control_'+'c'.repeat(32),laterMarker=`[CLW:${later}]`;
  f.record.latest_request={...f.record.latest_request,attempt_id:later,sent_user_hash:hash(`managed-public:${laterMarker}:user`)};
  Object.assign(f.snapshot,{attemptMarker:laterMarker,userId:`managed-public:${laterMarker}:user`});
  assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),true);
  assert.equal(await f.driver.reconnectFailedStream(f.page,f.record,f.snapshot),false);
  assert.deepEqual(f.reloads,[url,url]);assert.equal(f.driver.failedStreamReconnects.size,2);assert.deepEqual(f.calls,[]);
});

for(const paused of [false,true])test('real observePage reloads once then preserves '+(paused?'paused receipt collection':'failure pulse')+' while a retained Stop forbids model preparation and dispatch',async()=>{
  const f=fixture({paused}),before=clone(f.record),accepted={attempt,assistantBefore:hash('assistant-before-dispatch')};
  f.driver.pending.set(f.page.id,accepted);
  await f.driver.tick(f.record);
  assert.deepEqual(f.reloads,[url]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.record,before);
  await f.driver.tick(f.record);
  assert.deepEqual(f.reloads,[url]);assert.equal(f.calls.length,1);assert.deepEqual(f.modelCalls,[]);assert.deepEqual(f.record,before);
  assert.equal(f.driver.busy.size,0);assert.equal(f.page.residentRequired,true);
  assert.equal(f.page.observation.rawStopPresent,true);assert.equal(f.page.observation.streamInterrupted,true);assert.equal(f.page.observation.processingNotice,true);
  if(paused){assert.equal(f.calls[0][0],'pending-receipt');assert.deepEqual(f.calls[0][1],{page_id:f.page.id,url});}
  else{assert.equal(f.calls[0][0],'wire');assert.equal(f.calls[0][1].data.action,'pulse');assert.equal(f.calls[0][1].data.public_failure.terminal_failure,'无法思考');
    assert.equal(f.calls[0][1].data.public_failure.marker,marker);assert.equal(f.calls[0][1].data.public_failure.marker_count,1);}
  assert.equal(f.driver.pending.size,1);assert.equal(f.driver.pending.get(f.page.id),accepted);assert.equal(f.driver.resultCandidates.size,0);
});

test('real observePage does not reconnect a snapshot without explicit terminal failure and leaves long thinking untouched',async()=>{
  for(const generating of [false,true]){
    const f=fixture({paused:false});Object.assign(f.snapshot,{failure:'',generating});
    await f.driver.tick(f.record);await f.driver.tick(f.record);
    assert.deepEqual(f.reloads,[]);assert.deepEqual(f.modelCalls,[]);
    assert.equal(f.calls.length,generating?0:2);assert.equal(f.page.observation.failure,null);assert.equal(f.page.observation.generating,generating);
    assert.equal(f.driver.failedStreamReconnects?.size||0,0);
  }
});

test('real observePage retains an unknown navigation attempt and only polls the original receipt on the next observation',async()=>{
  const f=fixture({paused:false}),accepted={attempt,assistantBefore:hash('prior-assistant')},before=clone(f.record);
  f.driver.pending.set(f.page.id,accepted);f.hooks.reload=()=>{throw Error('navigation_ack_unknown');};
  await assert.rejects(f.driver.tick(f.record),/navigation_ack_unknown/);assert.equal(f.driver.busy.size,0);
  const original=[...f.driver.failedStreamReconnects.values()][0];delete f.hooks.reload;
  await f.driver.tick(f.record);
  assert.deepEqual(f.reloads,[url]);assert.equal([...f.driver.failedStreamReconnects.values()][0],original);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].data.action,'pulse');assert.deepEqual(f.modelCalls,[]);
  assert.equal(f.driver.pending.get(f.page.id),accepted);assert.deepEqual(f.record,before);
});

test('the real observer and formal refresh cannot overlap an active same-page Send or control transaction',async()=>{
  const f=fixture();f.driver.busy.add(f.page.id);
  await f.driver.tick(f.record);await assert.rejects(f.driver.refresh(f.page),/提交或核对本轮回执/);
  assert.deepEqual(f.actions,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.reloads,[]);
  assert.equal(f.driver.busy.has(f.page.id),true); // The original owner, not this refused operation, releases it.
});

test('observeTask exports exactly the three public stream indicators and hashed composer/turn evidence, never transcript or raw draft',async()=>{
  const f=fixture();Object.assign(f.snapshot,{privateInternal:'must-not-export',userText:'private transcript',publicText:'private answer',html:'<p>private answer</p>'});
  f.composer.text='未发送正文';
  const result=await f.driver.observeTask(f.page);
  for(const name of ['rawStopPresent','streamInterrupted','processingNotice'])assert.equal(result.snapshot[name],true);
  for(const name of ['privateInternal','userId','assistantId','userText','publicText','html'])assert.equal(Object.hasOwn(result.snapshot,name),false,name);
  assert.equal(result.user_turn_sha256,hash(f.snapshot.userId));assert.equal(result.assistant_turn_sha256,hash(f.snapshot.assistantId));
  assert.equal(result.composer.text_sha256,hash(f.composer.text));assert.equal(result.composer.text_utf8_bytes,Buffer.byteLength(f.composer.text,'utf8'));
  assert.equal(Object.hasOwn(result.composer,'text'),false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.reloads,[]);
  assert.equal(result.snapshot.stopped,false);
  assert.deepEqual(f.actions.map(([action])=>action),['snapshot','connector-state']);assert.equal(f.actions[1][1].expectedConnector,'Local-MCP');assert.equal(f.actions[1][1].diagnostics,true);
});
