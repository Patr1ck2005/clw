'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
const {WebDriver}=require('../web-driver.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const home='https://chatgpt.com/',url='https://chatgpt.com/c/original-queued-conversation',manualUrl='https://chatgpt.com/c/manual-conversation';
const clone=value=>JSON.parse(JSON.stringify(value)),hash=value=>createHash('sha256').update(value||'').digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

function fixture(t){
 const row={page_id:'original-page',thread_id:'original-thread',account:'A',phase:'bound',url,paused:false,own_paused:false,
  conversation_mode:'direct',model:'GPT-6 · Latest',effort:'高',
  latest_request:{id:'original-queued-request',phase:'queued',attempt_id:null,cancel_requested:0},attempt:null};
 const snapshot={url:home,editor:true,controlKnown:true,historyAtLatest:true,generating:false,rawStopPresent:false,
  draft:false,composing:false,approvalRequired:false,accessLimited:false,blocked:false,loginRequired:false,
  complete:false,stopped:false,userId:null,assistantId:null,userText:'',publicText:'',html:'',failure:null,
  attemptMarker:null,bootstrapMarker:null,attemptMarkerCount:0,bootstrapMarkerCount:0};
 let location=home,loading=false,destroyed=false,closed=false,reads=0;
 const hooks={},calls=[],actions=[],navigations=[],refreshes=[];
 const wc={getURL:()=>location,isLoading:()=>loading,isDestroyed:()=>destroyed,
  async loadURL(target){navigations.push({kind:'load',url:target});await hooks.navigate?.();location=target;snapshot.url=target;},
  reload(){navigations.push({kind:'reload',url:location});}};
 const page={id:row.page_id,account:'A',url:home,documentGeneration:2,domReady:true,closed:false,view:{webContents:wc}};
 const access={blocked:false,read(){return {blocked:this.blocked};},hold(){this.blocked=true;},assertCanStart(){},
  async admitNavigation(){await hooks.admission?.();}};
 const pool=new BrowserPool({networkGuard:{ready:true},allowedUrl:value=>value.startsWith('https://chatgpt.com/'),accountAccessFor:()=>access});
 pool.pages.set(page.id,page);pool.selected=page.id;pool.running=()=>{};pool.work=()=>{};pool.layout=()=>{};
 const runtime=new EventEmitter();runtime.ready=true;runtime.closed=false;runtime.child={original:true};
 runtime.call=async(action,payload)=>{calls.push([action,clone(payload)]);assert.fail('observing the homepage cannot change Host receipts: '+action);};
 const driver=new WebDriver({runtime,pool,isClosed:()=>closed,onNotice(){},approvals:{busy:new Set()},dom:async(original,action)=>{
  assert.equal(original,wc);assert.equal(action,'snapshot','observation cannot edit the composer or model');actions.push(action);
  await hooks.snapshot?.(++reads);return clone(snapshot);
 }});
 driver.records.set(page.id,row);driver.recordsLoaded=true;
 driver.refresh=async(...args)=>{refreshes.push(args);return WebDriver.prototype.refresh.apply(driver,args);};
 for(const method of ['send','inspect','selectModel'])driver[method]=async()=>assert.fail('passive observation cannot '+method);
 t.after(()=>driver.dispose());
 return {driver,pool,page,wc,row,snapshot,runtime,access,hooks,calls,actions,navigations,refreshes,
  setLocation(value){location=value;snapshot.url=value;},setLoading(value){loading=value;},setDestroyed(value){destroyed=value;},setClosed(value){closed=value;}};
}

test('first and repeated homepage observations preserve the queued original without returning to its URL',async t=>{
 const f=fixture(t),before=clone(f.row);
 for(let count=0;count<5;count++){await f.driver.tick(f.row);f.page.documentGeneration++;}
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.refreshes,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.row,before);
 assert.equal(f.wc.getURL(),home);assert.equal(f.driver.busy.size,0);assert.ok(f.actions.every(action=>action==='snapshot'));
});

test('a late homepage snapshot after manual navigation cannot return to the queued task or fabricate its receipt',async t=>{
 const f=fixture(t),before=clone(f.row),held=deferred(),entered=deferred();
 f.hooks.snapshot=async()=>{entered.resolve();await held.promise;};
 const observing=f.driver.tick(f.row);await entered.promise;
 f.setLocation(manualUrl);f.page.manualControl=true;f.page.manualInteractionSequence=1;f.page.documentGeneration++;
 held.resolve();await observing;
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.refreshes,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.row,before);
 assert.equal(f.wc.getURL(),manualUrl);assert.equal(f.driver.busy.size,0);
});

test('another observer and explicit refresh cannot steal the original read ownership while its snapshot waits',async t=>{
 const f=fixture(t),held=deferred(),entered=deferred();f.hooks.snapshot=async()=>{entered.resolve();await held.promise;};
 const observing=f.driver.tick(f.row);await entered.promise;
 assert.equal(f.driver.busy.has(f.page.id),true);
 await assert.rejects(f.driver.refresh(f.page),/正在提交或核对本轮回执/);await f.driver.tick(f.row);
 assert.equal(f.driver.busy.has(f.page.id),true);held.resolve();await observing;
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.calls,[]);assert.equal(f.driver.busy.size,0);
});

test('exit drains the original observation without introducing a navigation or a new send',async t=>{
 const f=fixture(t),held=deferred(),entered=deferred();f.hooks.snapshot=async()=>{entered.resolve();await held.promise;};
 const observing=f.driver.tick(f.row);await entered.promise;
 const quiescing=f.driver.quiesceObservation({timeoutMs:1000});assert.equal(f.driver.observationQuiesced,true);
 held.resolve();await observing;assert.deepEqual(await quiescing,{state:'quiesced',remaining:0,model_sends:0});
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.calls,[]);assert.equal(f.driver.busy.size,0);
});

test('unsent, accepted, paused and unknown originals all leave a manually selected chat visible',async t=>{
 for(const phase of ['queued','processing','suspended','unknown','blocked','completed'])await t.test(phase,async t=>{
  const f=fixture(t);f.setLocation(manualUrl);f.page.manualControl=true;f.page.manualUrl=manualUrl;
  f.row.latest_request.phase=phase;
  if(phase!=='queued'){f.row.latest_request.attempt_id='control_'+'a'.repeat(32);f.row.attempt={id:f.row.latest_request.attempt_id,state:'unknown',dispatched:123};}
  const before=clone(f.row);await f.driver.tick(f.row);await f.driver.tick(f.row);
  assert.deepEqual(f.navigations,[]);assert.deepEqual(f.refreshes,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.row,before);assert.equal(f.wc.getURL(),manualUrl);
 });
});

test('explicit homepage refresh reloads only that homepage and preserves the unsent queued request',async t=>{
 const f=fixture(t),before=clone(f.row);await f.driver.refresh(f.page);
 assert.deepEqual(f.actions,['snapshot','snapshot']);assert.deepEqual(f.navigations,[{kind:'reload',url:home}]);
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.row,before);assert.equal(f.driver.busy.size,0);
});

test('an unknown refresh reply is not retried by later passive homepage observations',async t=>{
 const f=fixture(t),before=clone(f.row),reload=f.pool.reload.bind(f.pool);
 f.pool.reload=async(...args)=>{await reload(...args);throw Error('original_refresh_reply_unknown');};
 await assert.rejects(f.driver.refresh(f.page),/original_refresh_reply_unknown/);
 await f.driver.tick(f.row);await f.driver.tick(f.row);
 assert.deepEqual(f.navigations,[{kind:'reload',url:home}]);assert.deepEqual(f.calls,[]);assert.deepEqual(f.row,before);
});

test('ordinary refresh rereads the current DOM and rejects late input, generation, unknown state or changed original identity',async t=>{
 const changes={draft:f=>{f.snapshot.draft=true;},generating:f=>{f.snapshot.generating=true;},composing:f=>{f.snapshot.composing=true;},
  approval:f=>{f.snapshot.approvalRequired=true;},unknown:f=>{f.snapshot.unknown=true;},known:f=>{f.snapshot.known=false;},
  error:f=>{f.snapshot.error='original_read_unknown';},controls:f=>{f.snapshot.controlKnown=false;},
  url:f=>f.setLocation(manualUrl),snapshotURL:f=>{f.snapshot.url=manualUrl;},
  request:f=>{f.driver.records.set(f.page.id,{...f.row,latest_request:{...f.row.latest_request,id:'later-request'}});},
  page:f=>{f.pool.pages.set(f.page.id,{...f.page});},renderer:f=>{f.page.view={webContents:f.wc};},
  account:f=>{f.page.account='B';},document:f=>{f.page.documentGeneration++;},destroyed:f=>f.setDestroyed(true),
  quiesce:f=>{f.driver.observationQuiesced=true;},closed:f=>f.setClosed(true),pending:f=>f.driver.pending.set(f.page.id,{state:'unknown'})};
 for(const stage of ['admission','last-snapshot'])for(const [name,change] of Object.entries(changes))await t.test(stage+' '+name,async t=>{
  const f=fixture(t),before=clone(f.row);
  if(stage==='admission')f.hooks.admission=async()=>change(f);else f.hooks.snapshot=async count=>{if(count===2)change(f);};
  await assert.rejects(f.driver.refresh(f.page));assert.deepEqual(f.navigations,[],name);assert.deepEqual(f.calls,[],name);
  assert.equal(f.driver.busy.size,0,name);assert.deepEqual(f.row,before,name);
 });
});

test('ordinary refresh and failed-stream reconnect recheck ownership synchronously after an awaited callback microtask',async t=>{
 const changes={exit:f=>{f.driver.observationQuiesced=true;},stop:f=>{f.driver.stopped=true;},runtime:f=>{f.runtime.closed=true;},
  connection:f=>{f.driver.connectionGeneration++;},pause:f=>{f.row.paused=!f.row.paused;},ownPause:f=>{f.row.own_paused=!f.row.own_paused;},
  request:f=>{f.driver.records.set(f.page.id,{...f.row,latest_request:{...f.row.latest_request,id:'changed-request'}});},
  account:f=>{f.page.account='B';},recordAccount:f=>{f.row.account='B';},thread:f=>{f.row.thread_id='changed-thread';},
  rowURL:f=>{f.row.url=manualUrl;},visibleURL:f=>f.setLocation(manualUrl),page:f=>{f.pool.pages.set(f.page.id,{...f.page});},
  renderer:f=>{f.page.view={webContents:f.wc};},document:f=>{f.page.documentGeneration++;},destroyed:f=>f.setDestroyed(true),
  pending:f=>f.driver.pending.set(f.page.id,{attempt:'foreign',state:'unknown'})};
 for(const mode of ['ordinary','failed-stream'])for(const [name,change] of Object.entries(changes))await t.test(mode+' '+name,async t=>{
  const f=fixture(t);let changed=false;
  if(mode==='failed-stream'){
   const attempt='control_'+'a'.repeat(32),user='original-failed-stream-user';f.setLocation(url);
   f.row.latest_request={...f.row.latest_request,phase:'processing',attempt_id:attempt,sent_user_hash:hash(user)};
   Object.assign(f.snapshot,{userId:user,userText:'original [CLW:'+attempt+']',rawStopPresent:true,failure:'无法思考',
    attemptMarker:'[CLW:'+attempt+']',attemptMarkerCount:1});
  }
  const reload=f.pool.reload.bind(f.pool);
  f.pool.reload=async(id,target,options)=>{
   assert.equal(typeof options.assertNavigationCurrent,'function');const original=options.assertCurrent;
   return reload(id,target,{...options,assertCurrent:async()=>{await original();queueMicrotask(()=>{changed=true;change(f);});}});
  };
  await assert.rejects(mode==='ordinary'?f.driver.refresh(f.page):f.driver.reconnectFailedStream(f.page,f.row,clone(f.snapshot)));
  assert.equal(changed,true,name);assert.deepEqual(f.navigations,[],name);assert.deepEqual(f.calls,[],name);assert.equal(f.driver.busy.size,0,name);
 });
});
