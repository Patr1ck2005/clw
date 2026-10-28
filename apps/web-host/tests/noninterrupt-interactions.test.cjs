'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
const {WebDriver,knownIdleSnapshot}=require('../web-driver.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const {WorkspaceState}=require('../workspace-state.cjs'),{startExistingTask,TaskSubmission}=require('../task-submission.cjs');
const {activeRequestId}=require('../task-action-identity.cjs');
const maintenanceExit=require('../maintenance-exit.cjs');
const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8').replace(/\r\n/g,'\n'),hash=text=>createHash('sha256').update(text).digest('hex');
const idle={editor:true,controlKnown:true,generating:false,draft:false,composing:false,approvalRequired:false,historyAtLatest:true};
function coldQuitFixture(t){
 const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'clw-cold-exit-'));t.after(()=>fs.rmSync(ROOT,{recursive:true,force:true}));
 const context={exitLifecycle:require('../exit-lifecycle.cjs').createExitLifecycle(),createOrdinaryExit:require('../ordinary-exit.cjs').createOrdinaryExit,appControl:null,maintenanceExit,exitFailureReasons:require('../exit-lifecycle.cjs').reason,ROOT,fs,path,workspaceRestored:true,nativeInitialization:{state:'disabled',ownerStarted:false},nativeBridge:null,nativePreviewPool:null,runtimeEverReady:false,runtime:{child:null,pending:new Map()},runtimeGeneration:1,driver:null,submissions:null,creating:false,quitting:false,maintenanceChecking:false,maintenanceSerial:0,coldQuitContext:null,maintenanceClosingContext:null,pool:{pages:new Map()},workspace:{tasks:new Map(),pendingStarts:{}},knownIdleSnapshot,requiresRenderer:()=>false,loaded:p=>!!p.view,runDom:async wc=>({...idle,url:wc.getURL()}),app:{quit(){context.quits++;}},quits:0,publish:()=>{}};
 const start=main.indexOf('function coldExitIdle('),end=main.indexOf('async function closeTask(',start),ordinaryStart=main.indexOf('const ordinaryExit=createOrdinaryExit('),ordinaryEnd=main.indexOf('const loadedMainSha=',ordinaryStart);
 assert.ok(start>=0&&end>start&&ordinaryStart>=0&&ordinaryEnd>ordinaryStart);
 const routes=vm.runInNewContext('(function(){'+main.slice(ordinaryStart,ordinaryEnd)+main.slice(start,end)+'return {prepareQuit,requestQuit,ordinaryExit};})()',context);
 return {context,...routes};
}

test('hiding with a failed snapshot never destroys the accepted original renderer',async()=>{
 const id='owned',page={id,title:'Owned',view:{webContents:{isDestroyed:()=>false}}},record={thread_id:'original-thread',paused:false,latest_request:{id:'original',phase:'processing'}},calls=[];
 const context={pageById:key=>{assert.equal(key,id);return page;},driver:{records:new Map([[id,record]])},runtimeGeneration:3,runtime:{ready:true,call:async(op,p)=>calls.push([op,p])},loaded:()=>true,runDom:async()=>{throw Error('snapshot unavailable');},knownIdleSnapshot,activeRequestId,pool:{selected:id,pages:new Map([[id,page]]),inspect:()=>[{id,closed:!!page.hidden}],close:()=>assert.fail('list hide cannot destroy an unverified page')},workspace:{pendingStarts:{},update(){}},chooseNext:()=>calls.push('choose-next'),savePages(){},publish(){}};
 const start=main.indexOf('async function closeTask('),end=main.indexOf('async function reopen(',start),close=vm.runInNewContext('('+main.slice(start,end).trim()+')',context);
 assert.equal((await close(id,true)).closed,true);assert.equal(page.hidden,true);assert.notEqual(page.closed,true);assert.equal(calls[0][1].expected_request_id,'original');assert.equal(calls[0][0],'pause');
});

test('persisted hidden descriptors can hydrate for collection while remaining absent from the task list',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-hidden-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const id='web-11111111-2222-3333-4444-555555555555',url='https://chatgpt.com/c/original',workspace=new WorkspaceState(home,()=>true),pool=new BrowserPool({allowedUrl:()=>true});
 const page=pool.register(id,url,{title:'Original',closed:true});assert.equal(page.hidden,true);assert.equal(page.closed,false);
 pool.hydrate=async p=>{p.view={webContents:{getURL:()=>url,isDestroyed:()=>false}};return p;};await pool.ensure(id);
 workspace.capture(pool);workspace.save();const restored=new WorkspaceState(home,()=>true);assert.equal(restored.isClosed(id),true);assert.equal(pool.inspect()[0].closed,true);assert.ok(page.view);
});

test('a hidden paused original receives its final result without pulse, Send or resume',async()=>{
 const url='https://chatgpt.com/c/original',attempt='control_'+'1'.repeat(32),snapshot={...idle,url,userId:'original-user',assistantId:'final-answer',complete:true,html:'<p>Complete original result</p>'},calls=[];
 const record={page_id:'original',phase:'bound',url,paused:true,pause_origin:{source:'operator'},latest_request:{id:'same-request',phase:'processing',attempt_id:attempt,sent_user_hash:hash(snapshot.userId)}};
 const page={id:record.page_id,hidden:true,view:{webContents:{getURL:()=>url}}},runtime=new EventEmitter();
 runtime.call=async op=>{calls.push(op);if(op==='pending-receipt')return {state:'browser_result_pending',attempt_id:attempt,sent_user_hash:hash(snapshot.userId),assistant_before_hash:hash('old-answer')};if(op==='artifact')return {path:'saved.md',sha256:'a'.repeat(64)};assert.fail(op);};
 const d=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),running(){},work(){}},dom:async()=>snapshot,isClosed:()=>true,onNotice(){}});d.records.set(page.id,record);
 d.wire=async(_r,action)=>{calls.push(action);assert.equal(action,'result');return {state:'completed'};};d.send=async()=>assert.fail('hiding cannot send');
 await d.tick(record);d.resultCandidates.get(attempt).at-=2000;await d.tick(record);assert.deepEqual(calls,['pending-receipt','pending-receipt','artifact','result']);assert.ok(d.completed.has(attempt));assert.equal(record.paused,true);
});

test('a hidden unknown turn rehydrates its original binding and cannot be released as idle',async()=>{
 const record={page_id:'hidden',thread_id:'same-thread',phase:'bound',url:'https://chatgpt.com/c/original',paused:true,own_paused:true,attention:'original unknown',latest_request:{id:'same-request',phase:'processing'}},runtime=new EventEmitter(),pool=new BrowserPool({allowedUrl:()=>true});runtime.ready=true;runtime.call=async op=>{assert.equal(op,'list');return {pages:[record]};};
 let hydrated=0;pool.hydrate=async p=>{hydrated++;p.view={webContents:{getURL:()=>record.url,isDestroyed:()=>false}};return p;};pool.suspend=()=>assert.fail('unknown accepted page cannot be released');
 const d=new WebDriver({runtime,pool,metadata:()=>({closed:true}),isClosed:()=>true,onNotice(){}});let ticks=0;d.tick=async()=>{ticks++;};await d.reconcileAll();assert.equal(hydrated,1);assert.equal(ticks,1);assert.equal(pool.pages.get('hidden').hidden,true);assert.equal(pool.pages.get('hidden').url,record.url);
});

test('refresh rejects generation, bad reads, unknown receipts and admission during its final navigation await',async()=>{
 const url='https://chatgpt.com/c/original',p={id:'owned',view:{webContents:{getURL:()=>url,isDestroyed:()=>false,reload:()=>assert.fail('no reload')}},documentGeneration:2},runtime=new EventEmitter(),pool=new BrowserPool({networkGuard:{ready:true}});pool.pages.set(p.id,p);
 const d=new WebDriver({runtime,pool,dom:async()=>({...idle,url,generating:true}),onNotice(){}});await assert.rejects(d.refresh(p),/仍在生成/);
 d.dom=async()=>{throw Error('snapshot failed');};await assert.rejects(d.refresh(p),/snapshot failed/);
 d.dom=async()=>({...idle,url});pool.accountAccessFor=()=>({assertCanStart(){},admitNavigation:async()=>{d.records.set(p.id,{phase:'bound',latest_request:{id:'new-original',phase:'processing'}});}});await assert.rejects(d.refresh(p),/原任务状态已变化/);assert.equal(p.documentGeneration,2);
});

test('supplementing a paused accepted request saves only its original note and cannot resume',async()=>{
 const page={id:'original'},calls=[],driver={resume:async()=>assert.fail('saving a note must not resume')},submissions={start:async(id,text,request)=>{calls.push([id,text,request]);return {state:'note_saved_not_native_interrupt',request_id:request};}};
 const result=await startExistingTask({pageById:()=>page,driver,submissions},{id:page.id,objective:'Preserved complete addition',expected_request_id:'same-request',resume:false});assert.equal(result.state,'note_saved_not_native_interrupt');assert.deepEqual(calls,[[page.id,'Preserved complete addition','same-request']]);
});

test('an unknown future hold reads the same owner state instead of sending pause again',async()=>{
 const runtime=new EventEmitter();runtime.store='original-store';runtime.child={pid:123};const calls=[];let paused=false;
 runtime.call=async op=>{calls.push(op);if(op==='pause-all')throw Error('runtime_receipt_unknown_reconcile_original');return {store_id:'original-store',pages:[{page_id:'root',own_paused:paused}]};};
 const d=new WebDriver({runtime,pool:{},onNotice(){}});await assert.rejects(d.pauseAll(),/unknown/);await assert.rejects(d.pauseAll(),/原暂停回执仍待核对/);paused=true;await d.pauseAll();assert.deepEqual(calls,['pause-all','list','list']);
});
test('automatic renderer recovery preserves accepted and unknown originals without reload',async()=>{
 const runtime=new EventEmitter(),url='https://chatgpt.com/c/original',page={id:'same-page',view:{webContents:{isDestroyed:()=>false,getURL:()=>url}}};let reloads=0,reads=0;
 const d=new WebDriver({runtime,pool:{pages:new Map([[page.id,page]]),emit(){},reload:async()=>reloads++},dom:async()=>{reads++;throw Error('unreadable');},sleep:async()=>{},onNotice(){}});
 d.records.set(page.id,{paused:true,latest_request:{id:'same-request',phase:'processing',attempt_id:'control_'+'a'.repeat(32)}});await d.reconcile(page.id);assert.equal(reloads,0);assert.equal(reads,0);assert.equal(page.observation.error,'renderer_crashed');
 d.records.set(page.id,{paused:true,attention:'unknown original',latest_request:{id:'same-request',phase:'unknown'}});await d.reconcile(page.id);assert.equal(reloads,0);
});

test('ordinary submissions cannot restore automation even through an old resume payload',async()=>{
 const page={id:'idle-original'},driver={records:new Map([[page.id,{paused:true}]]),resume:async()=>assert.fail('ordinary input cannot resume')},submissions={start:async()=>assert.fail('paused idle input cannot send')};
 const scope={pageById:()=>page,driver,submissions};
 await assert.rejects(startExistingTask(scope,{id:page.id,objective:'Next package',resume:true}),/单独操作/);
 await assert.rejects(startExistingTask(scope,{id:page.id,objective:'Next package',resume:false}),/仍暂停/);
 await assert.rejects(startExistingTask(scope,{id:page.id,objective:'Supplement',expected_request_id:'original-request',resume:true}),/单独操作/);
});

test('an idle pause reconciles its original persisted operation without sending or restoring',async()=>{
 const page={id:'idle-reconcile'},workspace={pendingStarts:{[page.id]:{operation_id:'accepted-original',objective:'Original text'}},save(){}};
 const calls=[],runtime={call:async(name,payload)=>{calls.push([name,payload]);assert.equal(name,'receipt');return {state:'completed',result:{state:'queued_for_web_host'}};}};
 const driver={records:new Map([[page.id,{paused:true}]]),resume:async()=>assert.fail('reconciliation cannot restore')};
 const result=await startExistingTask({pageById:()=>page,driver,submissions:new TaskSubmission(runtime,workspace)},{id:page.id,objective:'Original text',resume:false});
 assert.equal(result.state,'queued_for_web_host');assert.deepEqual(calls,[['receipt',{operation_id:'accepted-original'}]]);assert.equal(driver.records.get(page.id).paused,true);
});
test('exit input fence blocks only new original-page input and always removes its own listeners',()=>{
 const start=main.indexOf('function lockQuitPageInput('),end=main.indexOf('\n}',start)+2;
 assert.ok(start>=0&&end>start);const lock=vm.runInNewContext('('+main.slice(start,end).trim()+')');
 const original=new EventEmitter(),other=new EventEmitter();let existing=0,blocked=0;original.on('before-input-event',()=>existing++);
 const release=lock([{contents:original}]);original.emit('before-input-event',{preventDefault(){blocked++;}});original.emit('before-mouse-event',{preventDefault(){blocked++;}});other.emit('before-input-event',{preventDefault(){assert.fail('unowned page');}});
 assert.equal(blocked,2);assert.equal(existing,1);release();release();assert.equal(original.listenerCount('before-input-event'),1);assert.equal(original.listenerCount('before-mouse-event'),0);
 assert.throws(()=>lock([{contents:original},{contents:{}}]),/input_gate_unavailable/);assert.equal(original.listenerCount('before-input-event'),1);
});
test('main keeps the exact failed Native owner unless startup explicitly proves never-started or typed clean exit',()=>{
 const start=main.indexOf('    catch(e){',main.indexOf("nativeInitialization={state:'starting'")),end=main.indexOf('\n    }\n  }',start),body=main.slice(start+'    catch(e){'.length,end),owner={original:true};
 const receipt={version:1,kind:'native_maintenance_exit',state:'exited',runtimePid:123,ownerEpoch:'11111111-2222-3333-4444-555555555555',fenceId:'66666666-7777-8888-9999-aaaaaaaaaaaa',shutdownDispatched:true,runtimeExit:{pid:123,code:0,signal:null},listenerExit:null,tunnelExit:null};
 for(const state of ['unknown','never','clean','unclean','contradictory']){
  const c={nativeBridge:null,nativeInitialization:{state:'starting',ownerStarted:true},notice:'',maintenanceExit},consume=vm.runInNewContext('(function(e){'+body+'})',c),e=Object.assign(Error('original startup'),{nativeOwner:owner});
  if(state==='never'){delete e.nativeOwner;e.nativeStartup={state:'not_started',ownerStarted:false,reason:'execution_owner_never_started'};}
  if(['clean','unclean','contradictory'].includes(state)){e.nativeStartup={state:'cleaned',ownerStarted:false,receipt:{...receipt,runtimeExit:{...receipt.runtimeExit,code:state==='unclean'?1:0}}};if(state!=='contradictory')delete e.nativeOwner;}
  consume(e);assert.equal(c.nativeInitialization.ownerStarted,!['never','clean'].includes(state));if(state==='unknown'||state==='contradictory')assert.equal(c.nativeBridge,owner);
 }
});

test('cold close proof requires both owner absence and fresh idle account pages, without closing a proxy',async t=>{
 const {context,prepareQuit:run}=coldQuitFixture(t);
  await run({});assert.equal(context.quits,1);context.coldQuitContext=null;context.maintenanceChecking=false;const url='https://chatgpt.com/c/manual',page={id:'account',view:{webContents:Object.assign(new EventEmitter(),{id:1,getURL:()=>url})}};context.pool.pages.set(page.id,page);context.workspace.tasks.set(page.id,{kind:'account'});
 context.runDom=async()=>({...idle,url,generating:true});await assert.rejects(run({}),/原网页仍在工作/);assert.equal(context.quits,1);
 context.runDom=async()=>{throw Error('unknown DOM');};await assert.rejects(run({}),/unknown DOM/);assert.equal(context.quits,1);
 context.runDom=async()=>({...idle,url});await run({});assert.equal(context.quits,2);
  context.coldQuitContext=null;context.maintenanceChecking=false;
  const second={id:'second',view:{webContents:Object.assign(new EventEmitter(),{id:2,getURL:()=>url})}};context.pool.pages.set(second.id,second);context.workspace.tasks.set(second.id,{kind:'account'});let generating=false;
  context.runDom=async wc=>{const s={...idle,url,generating:wc.id===1&&generating};if(wc.id===2)generating=true;return s;};
  await assert.rejects(run({}),/原网页仍在工作/);assert.equal(context.quits,2);
  context.runtimeEverReady=true;await assert.rejects(run({}),/原任务仍待核对/);assert.equal(context.quits,2);
});

test('ordinary cold exit waits for the original account turn and closes after its fresh idle proof',async t=>{
 const {context,requestQuit,ordinaryExit}=coldQuitFixture(t),url='https://chatgpt.com/c/manual',page={id:'account',view:{webContents:Object.assign(new EventEmitter(),{id:1,getURL:()=>url})}};
 context.pool.pages.set(page.id,page);context.workspace.tasks.set(page.id,{kind:'account'});context.runDom=async()=>({...idle,url,generating:true});
 const waiting=await requestQuit({});assert.equal(waiting.waiting,true);assert.equal(waiting.exit.state,'waiting-current-turn');assert.equal(waiting.exit.active_conversations[0].page_id,page.id);assert.equal(context.quits,0);
 context.runDom=async()=>({...idle,url});await ordinaryExit.reconcile();assert.equal(ordinaryExit.snapshot().state,'closing');assert.equal(context.quits,1);assert.ok(context.coldQuitContext);
});

test('ordinary cold exit preserves the application when its account observation or original owner is unknown',async t=>{
 const {context,requestQuit}=coldQuitFixture(t),url='https://chatgpt.com/c/manual',page={id:'account',view:{webContents:Object.assign(new EventEmitter(),{id:1,getURL:()=>url})}};
 context.pool.pages.set(page.id,page);context.workspace.tasks.set(page.id,{kind:'account'});context.runDom=async()=>{throw Error('unknown DOM');};
 const blocked=await requestQuit({});assert.equal(blocked.exit.state,'blocked');assert.equal(blocked.exit.blocked_reasons[0].code,'exit_browser_observation_unavailable');assert.equal(context.quits,0);
 context.runDom=async()=>({...idle,url});context.runtimeEverReady=true;const original=await requestQuit({});assert.equal(original.exit.state,'blocked');assert.match(original.exit.blocked_reasons[0].code,/原任务仍待核对/);assert.equal(context.quits,0);
});
