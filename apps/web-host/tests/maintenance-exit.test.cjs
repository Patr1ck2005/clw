'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const maintenanceExit=require('../maintenance-exit.cjs'),shutdownPolicy=require('../shutdown-policy.cjs');
const {verifyNativeMaintenanceReceipt}=require('../native-turn-reads.cjs');
const {EventEmitter}=require('node:events');
const {knownIdleSnapshot}=require('../web-driver.cjs');
const {WorkspaceState,restoreConversationUrl}=require('../workspace-state.cjs');
const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),start=main.indexOf('function ownedQuitPages('),end=main.indexOf('async function closeTask(',start);
// These tests exercise the retained owner proof. Current-turn waiting is tested
// independently with the real ordinary-exit controller.
const source='(function(){const ordinaryExit={pending:null,snapshot:()=>null,begin(){return this.pending??=(async()=>{try{return {...await prepareQuit({}),state:"closing"};}catch(error){exitLifecycle.block(error);throw error;}})();}};'+main.slice(start,end)+';return requestQuit;})()';
function fixture(t){
 const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'clw-maintenance-'));t.after(()=>fs.rmSync(ROOT,{recursive:true,force:true}));
 const url='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',wc=Object.assign(new EventEmitter(),{id:1,getURL:()=>url}),page={id:'original',kind:'task',view:{webContents:wc}},runtime={ready:true,child:{pid:123},pending:new Map(),store:'store',info:{store_id:'store',instance_id:'a'.repeat(32)}};
 const context={exitLifecycle:require('../exit-lifecycle.cjs').createExitLifecycle(),appControl:null,exitFailureReasons:require('../exit-lifecycle.cjs').reason,ROOT,maintenanceExit,shutdownPolicy,verifyNativeMaintenanceReceipt,runtime,runtimeGeneration:4,workspaceRestored:true,nativeInitialization:{state:'ready',ownerStarted:true},driver:{stopped:false,recordsLoaded:true,records:new Map([['original',{thread_id:'original-thread',url,paused:true,latest_request:{id:'original-request',phase:'suspended'}}]]),busy:new Set(),pending:new Map()},pool:{pages:new Map([['original',page]])},workspace:{tasks:new Map([['original',{kind:'task',account:'A'}]]),pendingStarts:{}},nativeBridge:{},nativePreviewPool:null,connectionSettings:{readSettledTurns:()=>{throw Error('historical disk cannot certify current process owner');}},submissions:{busy:new Set()},creating:false,quitting:false,maintenanceQuit:false,maintenanceChecking:false,maintenanceSerial:0,loaded:()=>true,requiresRenderer:()=>true,knownIdleSnapshot,runDom:async()=>({url,editor:true,controlKnown:true,generating:false,rawStopPresent:false,draft:false,composing:false,approvalRequired:false}),nativeMaintenanceTurns:()=>{throw Error('display history must not certify current owner');},app:{quit(){context.quitCount++;}},quitCount:0,setImmediate:fn=>fn(),coldExitIdle:()=>false,publish:()=>{}};
 const nativeProof=()=>({version:1,kind:'native_owner_maintenance',runtimePid:456,ownerEpoch:'11111111-2222-3333-4444-555555555555',fenceId:'66666666-7777-8888-9999-aaaaaaaaaaaa',acceptingTurns:false,admissionSha256:'a'.repeat(64),activeHttp:0,activeBrowser:0,brokerPending:0,externalOwners:0,physicalCleanup:0,pendingCompactions:0,nativeTurns:[],historyAttention:[{traceId:'deadbeef0000',state:'needs_reconciliation'}],claimsVerified:false,claimReleaseAuthorized:false,taskAcceptance:'unverified'});
 const calls=[];context.nativeBridge={prepareMaintenance:async()=>{calls.push('prepare');return nativeProof();},verifyMaintenance:async p=>{calls.push('verify');return {...p};},finalVerifyMaintenance:p=>{calls.push('final');return p;},resumeMaintenance:async()=>{calls.push('release');return {state:'native_fence_released'};},onMaintenanceExit:()=>()=>{}};
 context.maintenanceClosingContext=null;context.coldQuitContext=null;
 const proof=()=>({version:1,source:'original_host_maintenance_readonly',idle:true,permitId:'c'.repeat(32),instanceId:'a'.repeat(32),hostPid:123,storeId:'store',root:ROOT,observedAt:Date.now()/1000,ledgerFingerprint:maintenanceExit.ledgerFingerprint(ROOT),jobs:{clientId:'fixture',ownedActiveJobs:0,inventoryComplete:true}});
 runtime.call=async(op,p)=>{assert.equal(op,'maintenance-readiness');assert.equal(p.store_id,'store');assert.equal(p.ledger_fingerprint,maintenanceExit.ledgerFingerprint(ROOT));assert.equal(p.page_bindings[0].page_id,'original');assert.equal(p.page_bindings[0].thread_id,'original-thread');assert.equal(p.page_bindings[0].request_id,'original-request');return {...proof(),...(p.exit_mode?{exitMode:p.exit_mode,jobs:{source:'independent_execution_retained',desktopShutdownBlocked:false,remoteInventoryRead:false}}:{})};};
 context.restoreConversationUrl=restoreConversationUrl;
 return {context,run:vm.runInNewContext(source,context),proof,nativeProof,calls,ROOT};
}

function blankPausedOffer(f){
 const record=f.context.driver.records.get('original');
 Object.assign(record,{phase:'bound',bootstrap_state:'sent',account:'A',model:'GPT-5.6',effort:'high',root:f.ROOT,access:'write',write_paths:['.local/qa']});
 f.context.pool.pages.get('original').account='A';
 record.latest_request={id:'original-request',phase:'suspended',attempt_id:'original-offer',sent_user_hash:null};
 const snapshot={url:record.url,editor:false,controlKnown:false,generating:false,rawStopPresent:false,draft:false,composing:false,
  approvalRequired:false,blocked:false,loginRequired:false,accessLimited:false,complete:false,failure:'',
  userId:'',assistantId:'',userText:'',publicText:'',html:''};
 const originalView={page_id:'original',thread_id:'original-thread',request:{id:'original-request',phase:'suspended'},
  latest_request:{...record.latest_request},attempt:{id:'original-offer',state:'offered',dispatched:null,acknowledged:null},
  pause_origin:{page_id:'original',source:'operator',inherited:false},access:record.access,write_paths:[...record.write_paths],
  renderer_lifecycle:{version:1,page_id:'original',thread_id:'original-thread',request_id:'original-request',
   request_phase:'suspended',attempt_id:'original-offer',required:true,reason:'original_attempt_unsettled'}};
 let reads=0;const originalCall=f.context.runtime.call;
 f.context.runtime.call=async(op,p)=>{if(op!=='view')return originalCall(op,p);reads++;
  assert.deepEqual(JSON.parse(JSON.stringify(p)),{page_id:'original',record_summaries:true});return originalView;};
 const composer={editorCount:1,text:'',generating:false,composing:false,approvalRequired:false,blocked:false,accessLimited:false};
 f.context.runDom=async(contents,action)=>action==='connector-state'?composer:snapshot;
 return {record,snapshot,composer,originalView,reads:()=>reads};
}

function homePausedOffer(f,{history=null,queued=false}={}){
 const offer=blankPausedOffer(f),page=f.context.pool.pages.get('original');
 page.view.webContents.getURL=()=> 'https://chatgpt.com/';
 Object.assign(offer.snapshot,{url:'https://chatgpt.com/',editor:true,controlKnown:true,historyAtLatest:history,
  attemptMarker:null,attemptMarkerCount:0,bootstrapMarker:null,bootstrapMarkerCount:0});
 if(queued){offer.record.latest_request.phase=offer.originalView.latest_request.phase=offer.originalView.request.phase='queued';
  offer.originalView.attempt.state='not_sent';offer.originalView.attempt.dispatched=123;
  Object.assign(offer.originalView.renderer_lifecycle,{request_phase:'queued',required:false,reason:'original_attempt_not_sent'});
 }else{offer.originalView.request.claim_id='retained-earlier-original-claim';
  offer.originalView.events=[{kind:'control_received',data:{attempt_id:'earlier-acknowledged'}},
   {kind:'host_turn_yielded',data:{attempt_id:'earlier-acknowledged',task_completed:false}}];}
 return offer;
}

for(const history of [null,true])for(const queued of [false,true])test('ordinary quit accepts exact empty HOME with '+(queued?'known not-sent queued':'paused unsent suspended')+' original and '+history+' history',async t=>{
 const f=fixture(t),offer=homePausedOffer(f,{history,queued});f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 const before=JSON.stringify([offer.record,offer.originalView]);const result=await f.run({});
 assert.equal(result.exiting,true);assert.equal(f.context.quitCount,1);assert.equal(offer.reads(),0);
 assert.equal(JSON.stringify([offer.record,offer.originalView]),before);
 assert.equal(offer.originalView.attempt.dispatched,queued?123:null);
});

function unavailableHomeOffer(f,options){
 const offer=homePausedOffer(f,options);
 Object.assign(offer.snapshot,{editor:false,controlKnown:false});offer.composer.editorCount=0;
 return offer;
}

for(const history of [null,true])test('ordinary quit accepts an unloaded HOME only with the exact original paused never-sent offer and '+history+' history',async t=>{
 const f=fixture(t),offer=unavailableHomeOffer(f,{history});
 f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 const before=JSON.stringify([offer.record,offer.originalView]);const result=await f.run({});
 assert.equal(result.exiting,true);assert.equal(f.context.quitCount,1);assert.equal(offer.reads(),0);
 assert.equal(JSON.stringify([offer.record,offer.originalView]),before);
});

for(const change of ['queued','dispatched','acknowledged','lease','scope','marker','history','composer','editor','model','draft','generation','pending'])
 test('unloaded HOME does not hide '+change,async t=>{
  const f=fixture(t),offer=unavailableHomeOffer(f,{queued:change==='queued'});
  if(change==='dispatched')offer.originalView.attempt.dispatched=123;
  if(change==='acknowledged')offer.originalView.attempt.acknowledged=123;
  if(change==='lease')offer.originalView.renderer_lifecycle.reason='execution_lease';
  if(change==='scope')offer.originalView.write_paths=['different'];
  if(change==='marker')offer.snapshot.attemptMarkerCount=1;
  if(change==='history')offer.snapshot.historyAtLatest=false;
  if(change==='composer')offer.composer.text='draft';
  if(change==='editor')offer.composer.editorCount=1;
  if(change==='model')delete offer.record.model;
  if(change==='draft')offer.snapshot.draft=true;
  if(change==='generation')offer.snapshot.generating=true;
  if(change==='pending')f.context.driver.pending.set('original',{});
  await assert.rejects(f.run({maintenance:true}),/binding_unavailable|execution_unresolved/);
  assert.equal(f.context.quitCount,0);
 });

for(const change of ['draft','generating','composing','approvalRequired','blocked','loginRequired','accessLimited',
 'userId','assistantId','userText','publicText','html','failure','complete','marker','bootstrap','history-false','history-missing',
 'other-url','query','fragment','composer-text','composer-ime','composer-editor','composer-unknown','scope','model-unknown'])
 test('empty HOME does not hide '+change,async t=>{
  const f=fixture(t),offer=homePausedOffer(f);
  if(['userId','assistantId','userText','publicText','html','failure'].includes(change))offer.snapshot[change]='original content';
  if(['draft','generating','composing','approvalRequired','blocked','loginRequired','accessLimited','complete'].includes(change))offer.snapshot[change]=true;
  if(change==='marker')offer.snapshot.attemptMarkerCount=1;if(change==='bootstrap')offer.snapshot.bootstrapMarker='old';
  if(change==='history-false')offer.snapshot.historyAtLatest=false;if(change==='history-missing')delete offer.snapshot.historyAtLatest;
  if(['other-url','query','fragment'].includes(change)){const url={ 'other-url':'https://other.example/','query':'https://chatgpt.com/?new=1',fragment:'https://chatgpt.com/#new'}[change];offer.snapshot.url=url;f.context.pool.pages.get('original').view.webContents.getURL=()=>url;}
  if(change==='composer-text')offer.composer.text='unsubmitted';if(change==='composer-ime')offer.composer.composing=true;
  if(change==='composer-editor')offer.composer.editorCount=2;if(change==='composer-unknown')delete offer.composer.generating;
  if(change==='scope')offer.originalView.write_paths=['different'];if(change==='model-unknown')delete offer.record.model;
  await assert.rejects(f.run({maintenance:true}),/binding_unavailable|原网页仍在工作/);assert.equal(f.context.quitCount,0);
 });

for(const change of ['claim','ack','state','lifecycle','phase','lease'])test('queued HOME requires exact not-sent lifecycle and no '+change,async t=>{
 const f=fixture(t),offer=homePausedOffer(f,{queued:true});
 if(change==='claim')offer.originalView.request.claim_id='active';if(change==='ack')offer.originalView.attempt.acknowledged=12;
 if(change==='state')offer.originalView.attempt.state='unknown';if(change==='lifecycle')offer.originalView.renderer_lifecycle.required=true;
 if(change==='phase')offer.originalView.request.phase='processing';if(change==='lease')offer.originalView.renderer_lifecycle.reason='execution_lease';
 await assert.rejects(f.run({maintenance:true}),/binding_unavailable/);assert.equal(f.context.quitCount,0);
});

for(const stage of ['composer','view','verify','final'])for(const field of ['model','account','scope','navigation','generation'])
 test('late '+field+' during '+stage+' cannot close a restored HOME',async t=>{
  const f=fixture(t),offer=homePausedOffer(f),page=f.context.pool.pages.get('original');
  const mutate=()=>{if(field==='model')offer.record.model='different';if(field==='account')offer.record.account='B';
   if(field==='scope')offer.record.write_paths.push('new');if(field==='navigation')page.view.webContents.getURL=()=> 'https://chatgpt.com/c/changed';
   if(field==='generation')page.documentGeneration=(page.documentGeneration||0)+1;};
  if(stage==='composer'){const dom=f.context.runDom;f.context.runDom=async(...args)=>{const result=await dom(...args);if(args[1]==='connector-state')mutate();return result;};}
  if(stage==='view'){const call=f.context.runtime.call;f.context.runtime.call=async(op,p)=>{const result=await call(op,p);if(op==='view')mutate();return result;};}
  if(stage==='verify')f.context.nativeBridge.verifyMaintenance=async p=>{mutate();return p;};
  if(stage==='final')f.context.nativeBridge.finalVerifyMaintenance=p=>{mutate();return p;};
  await assert.rejects(f.run({maintenance:true}),/binding_unavailable|execution_unresolved|page_changed/);assert.equal(f.context.quitCount,0);
 });

test('two restored HOME pages serialize original Host reads and reject a late first-page return',async t=>{
 for(const late of [false,true]){
  const f=fixture(t),offer=homePausedOffer(f),wc=Object.assign(new EventEmitter(),{id:2,getURL:()=> 'https://chatgpt.com/'}),page={id:'second',kind:'task',view:{webContents:wc}};
  const secondRecord={...offer.record,thread_id:'second-thread',latest_request:{...offer.record.latest_request,id:'second-request',attempt_id:'second-offer'}};
  const secondView={...offer.originalView,page_id:'second',thread_id:'second-thread',request:{id:'second-request',phase:'suspended'},
   latest_request:{...secondRecord.latest_request},attempt:{id:'second-offer',state:'offered',dispatched:null,acknowledged:null},
   renderer_lifecycle:{...offer.originalView.renderer_lifecycle,page_id:'second',thread_id:'second-thread',request_id:'second-request',attempt_id:'second-offer'}};
  f.context.pool.pages.set('second',page);f.context.workspace.tasks.set('second',{kind:'task',account:'B'});f.context.driver.records.set('second',secondRecord);
  let reads=0,active=0,maximum=0;const call=f.context.runtime.call;
  f.context.runtime.call=async(op,p)=>{if(op!=='view')return call(op,p);const key=Symbol('owned read');f.context.runtime.pending.set(key,{op});maximum=Math.max(maximum,++active);reads++;
   try{await Promise.resolve();if(late&&p.page_id==='second')offer.record.latest_request.attempt_id='late-first-attempt';return p.page_id==='second'?secondView:offer.originalView;}
   finally{active--;f.context.runtime.pending.delete(key);}};
  if(late){await assert.rejects(f.run({maintenance:true}),/execution_unresolved/);assert.equal(f.context.quitCount,0);}
  else{await f.run({maintenance:true});assert.equal(f.context.quitCount,1);assert.equal(reads,4);}
  assert.equal(maximum,1);assert.equal(f.context.runtime.pending.size,0);
 }
});

test('ordinary quit closes a blank paused original carrier whose latest offer was never dispatched',async t=>{
 const f=fixture(t),offer=blankPausedOffer(f),before=JSON.stringify(offer.record);
 f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 const result=await f.run({});assert.equal(result.exiting,true);assert.equal(f.context.quitCount,1);
 assert.equal(offer.reads(),0);assert.equal(JSON.stringify(offer.record),before);
 assert.equal(offer.originalView.attempt.state,'offered');assert.equal(offer.originalView.request.phase,'suspended');
});

test('a retained earlier acknowledged claim does not turn a later unsent offer into current execution',async t=>{
 const f=fixture(t),offer=blankPausedOffer(f);
 offer.originalView.request.claim_id='retained-original-browser-claim';
 offer.originalView.send_stats={attempted:42,confirmed:42,unconfirmed:0};
 offer.originalView.events=[{kind:'control_browser_acknowledged',data:{attempt_id:'earlier-sent-attempt'}},
  {kind:'control_browser_result',data:{attempt_id:'earlier-sent-attempt',phase:'yielded'}}];
 const before=JSON.stringify(offer.originalView);await f.run({maintenance:true});
 assert.equal(f.context.quitCount,1);assert.equal(JSON.stringify(offer.originalView),before);
});

for(const change of ['page','thread','request','request-phase','latest-request','latest-phase','latest-attempt',
 'sent-user','attempt','dispatching','sent','unknown','acknowledged','dispatched','ack','missing-dispatch','missing-ack',
 'pause','lifecycle-page','lifecycle-thread','lifecycle-request','lifecycle-attempt','lifecycle-phase',
 'lease','original-operation','earlier-result','thread-execution','missing-lifecycle'])
 test('blank carrier cannot hide an original '+change+' identity or execution change',async t=>{
  const f=fixture(t),offer=blankPausedOffer(f),s=offer.originalView;
  if(change==='page')s.page_id='different';if(change==='thread')s.thread_id='different';
  if(change==='request')s.request.id='different';if(change==='request-phase')s.request.phase='processing';
  if(change==='latest-request')s.latest_request.id='different';if(change==='latest-phase')s.latest_request.phase='unknown';
  if(change==='latest-attempt')s.latest_request.attempt_id='different';if(change==='sent-user')s.latest_request.sent_user_hash='accepted-user';
  if(change==='attempt')s.attempt.id='different';if(['dispatching','sent','unknown','acknowledged'].includes(change))s.attempt.state=change;
  if(change==='dispatched')s.attempt.dispatched=123;if(change==='ack')s.attempt.acknowledged=124;
  if(change==='missing-dispatch')delete s.attempt.dispatched;if(change==='missing-ack')delete s.attempt.acknowledged;
  if(change==='pause')s.pause_origin=null;
  if(change.startsWith('lifecycle-'))s.renderer_lifecycle[{'lifecycle-page':'page_id','lifecycle-thread':'thread_id',
   'lifecycle-request':'request_id','lifecycle-attempt':'attempt_id','lifecycle-phase':'request_phase'}[change]]='different';
  if(['lease','original-operation','earlier-result','thread-execution'].includes(change))s.renderer_lifecycle.reason={
   lease:'execution_lease','original-operation':'original_operation_pending','earlier-result':'original_result_pending',
   'thread-execution':'current_thread_execution'}[change];
  if(change==='missing-lifecycle')s.renderer_lifecycle=null;
  await assert.rejects(f.run({maintenance:true}),/原网页仍在工作/);assert.equal(f.context.quitCount,0);
  assert.equal(offer.reads(),1);assert.equal(offer.record.latest_request.phase,'suspended');
 });

for(const change of ['generating','draft','composing','approvalRequired','blocked','loginRequired','accessLimited','editor',
 'controlKnown','complete','userId','assistantId','userText','publicText','html','failure','unknown'])
 test('blank unsent carrier exemption never hides public '+change,async t=>{
  const f=fixture(t),offer=blankPausedOffer(f);
  offer.snapshot[change]=['userId','assistantId','userText','publicText','html','failure'].includes(change)?'retained public content':true;
  await assert.rejects(f.run({maintenance:true}),/原网页仍在工作|execution_unresolved/);assert.equal(f.context.quitCount,0);assert.equal(offer.reads(),0);
 });

for(const change of ['unpaused','unbound','unmanaged','prepared','result','approval'])
 test('unavailable carrier requires its original pause and no local '+change,async t=>{
  const f=fixture(t),offer=blankPausedOffer(f);
  if(change==='unpaused')offer.record.paused=false;if(change==='unbound')offer.record.phase='reserved';
  if(change==='unmanaged')f.context.pool.pages.get('original').kind='account';
  if(change==='prepared')f.context.driver.bootstrapPrepared=new Map([['original',{unsent:true}]]);
  if(change==='result')f.context.driver.resultCandidates=new Map([['original-offer',{body:'not saved'}]]);
  if(change==='approval')f.context.driver.approvals={busy:new Set(['original'])};
  await assert.rejects(f.run({maintenance:true}),/原网页仍在工作|execution_unresolved/);assert.equal(f.context.quitCount,0);assert.equal(offer.reads(),0);
 });

for(const stage of ['view','verify','final'])for(const change of ['prepared','result','approval'])
 test('late '+change+' during '+stage+' cannot close a blank original carrier',async t=>{
  const f=fixture(t);blankPausedOffer(f);
  const mutate=()=>{if(change==='prepared')f.context.driver.bootstrapPrepared=new Map([['original',{}]]);
   if(change==='result')f.context.driver.resultCandidates=new Map([['original-offer',{}]]);
   if(change==='approval')f.context.driver.approvals={busy:new Set(['original'])};};
  if(stage==='view'){const call=f.context.runtime.call;f.context.runtime.call=async(op,p)=>{const value=await call(op,p);if(op==='view')mutate();return value;};}
  if(stage==='verify')f.context.nativeBridge.verifyMaintenance=async p=>{mutate();return p;};
  if(stage==='final')f.context.nativeBridge.finalVerifyMaintenance=p=>{mutate();return p;};
  await assert.rejects(f.run({maintenance:true}),/execution_unresolved|原网页仍在工作/);assert.equal(f.context.quitCount,0);
 });

test('blank original carrier still needs fresh Host Jobs and preserves an unknown view read',async t=>{
 for(const change of ['jobs','view-error','view-null','ledger','navigation']){
  const f=fixture(t),offer=blankPausedOffer(f),call=f.context.runtime.call;
  f.context.runtime.call=async(op,p)=>{
   if(change==='jobs'&&op==='maintenance-readiness')return {...f.proof(),jobs:{clientId:'fixture',ownedActiveJobs:1,inventoryComplete:true}};
   if(op==='view'){
    if(change==='view-error')throw Error('original_view_response_unknown');if(change==='view-null')return null;
    if(change==='ledger'){const dir=path.join(f.ROOT,'.local/harness');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'harness.sqlite3-wal'),'new original write');}
    if(change==='navigation')f.context.pool.pages.get('original').view.webContents.getURL=()=> 'https://chatgpt.com/c/another';
   }
   return call(op,p);
  };
  await assert.rejects(f.run({maintenance:true}),/original_receipt|response_unknown|原网页仍在工作|store_changed|page_changed|execution_unresolved/);
  assert.equal(f.context.quitCount,0);assert.equal(offer.record.latest_request.phase,'suspended');
  if(change==='jobs')assert.equal(offer.reads(),0);
 }
});

for(const secondBlank of [true,false])test('quit serializes its own Host observations with '+(secondBlank?'two blank carriers':'a blank and known idle carrier'),async t=>{
 const f=fixture(t),offer=blankPausedOffer(f),secondUrl='https://chatgpt.com/c/second-original';
 const wc=Object.assign(new EventEmitter(),{id:2,getURL:()=>secondUrl}),page={id:'second',kind:'task',view:{webContents:wc}};
 const secondRecord={...offer.record,thread_id:'second-thread',url:secondUrl,
  latest_request:{...offer.record.latest_request,id:'second-request',attempt_id:'second-offer'}};
 f.context.pool.pages.set('second',page);f.context.workspace.tasks.set('second',{kind:'task',account:'B'});
 f.context.driver.records.set('second',secondRecord);
 const secondView={...offer.originalView,page_id:'second',thread_id:'second-thread',
  request:{id:'second-request',phase:'suspended'},latest_request:{...secondRecord.latest_request},
  attempt:{id:'second-offer',state:'offered',dispatched:null,acknowledged:null},pause_origin:{page_id:'second'},
  renderer_lifecycle:{...offer.originalView.renderer_lifecycle,page_id:'second',thread_id:'second-thread',
   request_id:'second-request',attempt_id:'second-offer'}};
 f.context.runDom=async contents=>contents===wc?{...offer.snapshot,url:secondUrl,...(secondBlank?{}:{editor:true,controlKnown:true})}:offer.snapshot;
 const originalCall=f.context.runtime.call;let active=0,maximum=0,reads=0;
 f.context.runtime.call=async(op,p)=>{
  if(op!=='view')return originalCall(op,p);const key=Symbol('this original read');f.context.runtime.pending.set(key,{op});
  maximum=Math.max(maximum,++active);reads++;
  try{await new Promise(resolve=>setTimeout(resolve,5));return p.page_id==='second'?secondView:offer.originalView;}
  finally{active--;f.context.runtime.pending.delete(key);}
 };
 const before=JSON.stringify([...f.context.driver.records]);await f.run({maintenance:true});
 assert.equal(f.context.quitCount,1);assert.equal(maximum,1);assert.equal(reads,secondBlank?4:2);
 assert.equal(f.context.runtime.pending.size,0);assert.equal(JSON.stringify([...f.context.driver.records]),before);
});

test('a closed unloaded historical homepage uses the same residency projection for exit',async t=>{
 const f=fixture(t),page=f.context.pool.pages.get('original'),record=f.context.driver.records.get('original');
 page.view=null;page.rendererState='unloaded';page.hidden=true;
 Object.assign(record,{page_id:'original',url:'https://chatgpt.com/',phase:'receiver_enrolled',bootstrap_state:'unknown'});
 record.renderer_lifecycle={version:1,page_id:'original',thread_id:record.thread_id,request_id:record.latest_request.id,
   request_phase:record.latest_request.phase,attempt_id:null,required:true,reason:'bootstrap_original_page_only'};
 f.context.requiresRenderer=require('../page-residency.cjs').requiresRenderer;
 await f.run({maintenance:true});assert.equal(f.context.quitCount,1);
 assert.equal(record.bootstrap_state,'unknown');assert.equal(record.latest_request.phase,'suspended');
});

test('an unloaded historical task with its original conversation still requires observation',async t=>{
 const f=fixture(t),page=f.context.pool.pages.get('original'),record=f.context.driver.records.get('original');
 page.view=null;page.rendererState='unloaded';page.hidden=true;
 Object.assign(record,{page_id:'original',phase:'bound',bootstrap_state:'unknown'});
 record.renderer_lifecycle={version:1,page_id:'original',thread_id:record.thread_id,request_id:record.latest_request.id,
   request_phase:record.latest_request.phase,attempt_id:null,required:true,reason:'bootstrap_original_page_only'};
 f.context.requiresRenderer=require('../page-residency.cjs').requiresRenderer;
 await assert.rejects(f.run({maintenance:true}),/maintenance_original_page_unavailable/);assert.equal(f.context.quitCount,0);
});
test('guarded maintenance quit accepts current owner despite historical attention and retains paused intent',async t=>{const f=fixture(t),before=JSON.stringify([...f.context.driver.records]);const r=await f.run({maintenance:true});assert.equal(r.maintenance,true);assert.equal(f.context.quitCount,1);assert.equal(before,JSON.stringify([...f.context.driver.records]));assert.equal(f.context.maintenanceChecking,false);assert.deepEqual(f.calls,['prepare','verify','final']);});
test('original observer reads drain before the exit proof instead of being mistaken for execution',async t=>{
 const f=fixture(t),order=[];f.context.driver.busy.add('original');
 f.context.driver.quiesceObservation=async options=>{assert.equal(options.timeoutMs,10000);order.push('drain');f.context.driver.busy.clear();};
 f.context.driver.resumeObservation=()=>order.push('resume');
 f.context.driver.pauseAll=async()=>order.push('pause-future');f.context.driver.reconcileAll=async()=>order.push('ledger-only');
 await f.run({});assert.deepEqual(order,['drain','pause-future','ledger-only']);assert.equal(f.context.quitCount,1);
});
test('refused or timed-out observation preparation restores the original observer without cancelling work',async t=>{
 for(const timeout of [false,true]){const f=fixture(t),order=[];
  f.context.driver.quiesceObservation=async()=>{order.push('drain');if(timeout)throw Error('web_observer_drain_timeout');};
  f.context.driver.resumeObservation=()=>order.push('resume');
  f.context.runtime.call=async()=>{throw Error('maintenance_jobs_active');};
  await assert.rejects(f.run({maintenance:true}),timeout?/web_observer_drain_timeout/:/maintenance_jobs_active/);
  assert.deepEqual(order,['drain','resume']);assert.equal(f.context.quitCount,0);assert.equal(f.context.driver.stopped,false);
  assert.equal(f.context.driver.maintenanceObservationIntent,undefined);
 }
});
test('ordinary explicit quit pauses future admission then uses the same original owner proof',async t=>{const f=fixture(t);f.context.driver.pauseAll=async()=>f.calls.push('pause-future');f.context.driver.reconcileAll=async()=>{};const r=await f.run({});assert.equal(r.maintenance,false);assert.equal(f.context.quitCount,1);assert.deepEqual(f.calls,['pause-future','prepare','verify','final']);assert.equal(f.context.maintenanceClosingContext.ordinaryExit,true);});
test('ordinary exit preserves an ACK waiting for results and proves the exact quiet current carrier',async t=>{
 const f=fixture(t),record=f.context.driver.records.get('original'),attempt='control_'+'a'.repeat(32),user='original-user';
 const hash=require('node:crypto').createHash('sha256').update(user).digest('hex');
 Object.assign(record,{phase:'bound',latest_request:{id:'original-request',phase:'processing',attempt_id:attempt,sent_user_hash:hash},attempt:{id:attempt,state:'acknowledged',dispatched:1,acknowledged:2}});
 f.context.driver.pending.set('original',{attempt,assistantBefore:'retained'});f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 const snapshot={url:record.url,editor:true,controlKnown:true,generating:false,rawStopPresent:false,draft:false,composing:false,approvalRequired:false,complete:false,historyAtLatest:true,attemptMarker:'[CLW:'+attempt+']',attemptMarkerCount:1,userId:user};
 f.context.runDom=async()=>snapshot;let proofRead=0;
 f.context.runtime.call=async(op,payload)=>{assert.equal(op,'maintenance-readiness');assert.equal(payload.exit_mode,'ordinary');assert.equal(payload.paused_carriers.length,1);const row=payload.paused_carriers[0];assert.equal(row.request_id,'original-request');assert.equal(row.expected_user_hash,hash);assert.equal(row.observed_user_hash,hash);assert.equal(row.marker,snapshot.attemptMarker);assert.equal(row.generating,false);proofRead++;return {...f.proof(),exitMode:'ordinary'};};
 const result=await f.run({}, {operation_id:'api-exit-original'});assert.equal(result.exiting,true);assert.equal(result.exit.operation_id,'api-exit-original');assert.equal(proofRead,1);assert.equal(record.latest_request.phase,'processing');assert.equal(f.context.driver.pending.get('original').attempt,attempt);
});
for(const state of ['unknown','dispatching','sent'])test('ordinary exit retains '+state+' original send and prepared input while closing a quiet carrier',async t=>{
 const f=fixture(t),record=f.context.driver.records.get('original'),attempt='control_'+'a'.repeat(32);
 record.latest_request={id:'original-request',phase:'queued',attempt_id:attempt,sent_user_hash:null};
 f.context.driver.pending.set('original',{attempt,state});
 f.context.workspace.pendingStarts.original={operation_id:'retained-original-send',attempt_id:attempt,state:'unknown'};
 f.context.driver.bootstrapPrepared=new Map([['original',{text:'retained original input'}]]);
 f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 const retained=JSON.stringify([record,[...f.context.driver.pending],f.context.workspace.pendingStarts,[...f.context.driver.bootstrapPrepared]]);
 let reads=0;f.context.runtime.call=async(op,payload)=>{
  assert.equal(op,'maintenance-readiness');assert.equal(payload.exit_mode,'ordinary');reads++;
  const carrier=payload.paused_carriers[0];assert.equal(carrier.attempt_id,attempt);
  assert.equal(carrier.marker,null);assert.equal(carrier.expected_user_hash,null);assert.equal(carrier.observed_user_hash,null);
  return {...f.proof(),exitMode:'ordinary'};
 };
 const result=await f.run({});assert.equal(result.exiting,true);assert.equal(f.context.quitCount,1);assert.equal(reads,1);
 assert.equal(JSON.stringify([record,[...f.context.driver.pending],f.context.workspace.pendingStarts,[...f.context.driver.bootstrapPrepared]]),retained);
});

function restoredDirectQuitFixture(t){
 const f=fixture(t),id='web-11111111-2222-4333-8444-555555555555',home='https://chatgpt.com/',url='https://chatgpt.com/c/accepted-original',attempt='control_'+'a'.repeat(32);
 const record=f.context.driver.records.get('original'),page=f.context.pool.pages.get('original');
 Object.assign(record,{page_id:id,account:'A',phase:'bound',conversation_mode:'direct',url:home,
  latest_request:{id:'original-request',phase:'queued',attempt_id:attempt,sent_user_hash:null},
  attempt:{id:attempt,state:'unknown',dispatched:123,acknowledged:null}});
 page.id=id;page.account='A';page.documentGeneration=1;
 f.context.pool.pages=new Map([[id,page]]);f.context.driver.records=new Map([[id,record]]);
 f.context.driver.pending=new Map([[id,{attempt,state:'unknown'}]]);f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 const folder=path.join(f.ROOT,'workspace'),allowed=u=>u.startsWith('https://chatgpt.com/'),workspace=new WorkspaceState(folder,allowed);
 workspace.update(id,{account:'A',kind:'task',url:home,goal:{objective:'Original complete goal',state:'active'}});
 workspace.pendingStarts[id]={operation_id:'original-send-key',state:'unknown'};
 workspace.capture({selected:id,inspect:()=>[{id,account:'A',url}]},f.context.driver.records);
 workspace.capture({selected:id,inspect:()=>[{id,account:'A',url:home}]},f.context.driver.records);workspace.save();
 const restored=new WorkspaceState(folder,allowed);f.context.workspace=restored;
 page.url=restoreConversationUrl(record,restored.tasks.get(id));page.view.webContents.getURL=()=>page.url;
 f.context.runDom=async()=>({url:page.url,editor:true,controlKnown:true,generating:false,rawStopPresent:false,draft:false,composing:false,approvalRequired:false});
 const retained=()=>JSON.stringify([record,[...f.context.driver.pending],restored.pendingStarts,[...restored.tasks]]);
 let reads=0;f.context.runtime.call=async(op,payload)=>{
  assert.equal(op,'maintenance-readiness');assert.equal(payload.exit_mode,'ordinary');reads++;
  const binding=payload.page_bindings[0],carrier=payload.paused_carriers[0];
  assert.equal(binding.url,home);assert.equal(binding.page_id,id);assert.equal(binding.request_id,'original-request');assert.equal(binding.attempt_id,attempt);
  assert.equal(carrier.page_id,id);assert.equal(carrier.attempt_id,attempt);assert.equal(carrier.marker,null);
  return {...f.proof(),exitMode:'ordinary'};
 };
 return {...f,id,home,url,attempt,record,page,restored,retained,reads:()=>reads};
}

test('ordinary exit accepts actual capture HOME restore of the same direct reading while canonical send remains unknown',async t=>{
 const f=restoredDirectQuitFixture(t),before=f.retained();
 assert.equal(f.page.url,f.url);assert.equal(f.restored.tasks.get(f.id).readingRequestId,'original-request');assert.equal(f.restored.tasks.get(f.id).readingAttemptId,f.attempt);
 const result=await f.run({});assert.equal(result.exiting,true);assert.equal(f.context.quitCount,1);assert.equal(f.reads(),1);assert.equal(f.retained(),before);
 assert.equal(f.record.url,f.home);assert.equal(f.record.attempt.state,'unknown');assert.equal(f.record.attempt.acknowledged,null);
});

for(const changed of ['foreign-view-account','canonical-page'])
 test('ordinary restored direct exit refuses changed live owner '+changed+' without settling the original send',async t=>{
  const f=restoredDirectQuitFixture(t),saved=f.restored.tasks.get(f.id);
  if(changed==='foreign-view-account')f.page.account='B';
  if(changed==='canonical-page')f.record.page_id='web-foreign';
  const before=f.retained();await assert.rejects(f.run({}),error=>['original_browser_binding_changed','exit_local_operation_pending','maintenance_original_execution_unresolved'].includes(error.code||error.message));
  assert.equal(f.context.quitCount,0);assert.equal(f.reads(),0);assert.equal(f.retained(),before);
 });

for(const changed of ['homepage','another-chat','foreign-saved-account','foreign-page','reading-request','reading-attempt'])
 test('ordinary quiet exit retains historical reading mismatch '+changed+' without claiming delivery',async t=>{
  const f=restoredDirectQuitFixture(t),saved=f.restored.tasks.get(f.id);
  if(changed==='homepage')f.page.url=f.home;
  if(changed==='another-chat')f.page.url='https://chatgpt.com/c/another-open-chat';
  if(changed==='foreign-saved-account')saved.account='B';
  if(changed==='foreign-page')saved.id='web-foreign';
  if(changed==='reading-request')saved.readingRequestId='foreign-request';
  if(changed==='reading-attempt')saved.readingAttemptId='control_'+'b'.repeat(32);
  const before=f.retained(),result=await f.run({});
  assert.equal(result.exiting,true);assert.equal(f.context.quitCount,1);assert.equal(f.reads(),1);
  assert.equal(f.retained(),before);assert.equal(f.record.url,f.home);
  assert.equal(f.record.attempt.state,'unknown');assert.equal(f.record.attempt.acknowledged,null);
 });

test('ordinary changed reading URL cannot supply an ACK witness from cached message markup',async t=>{
 const f=restoredDirectQuitFixture(t),userId='cached-original-user';
 f.record.attempt.state='acknowledged';f.record.attempt.acknowledged=456;
 f.record.latest_request.phase='processing';
 f.record.latest_request.sent_user_hash=require('node:crypto').createHash('sha256').update(userId).digest('hex');
 f.context.runDom=async()=>({url:f.page.url,editor:true,controlKnown:true,generating:false,rawStopPresent:false,draft:false,composing:false,approvalRequired:false,
   attemptMarker:'[CLW:'+f.attempt+']',attemptMarkerCount:1,historyAtLatest:true,userId});
 const before=f.retained(),result=await f.run({});
 assert.equal(result.exiting,true);assert.equal(f.reads(),1);assert.equal(f.retained(),before);
 assert.equal(f.record.attempt.acknowledged,456);
});

test('ordinary unchanged URL still rejects a different live account',async t=>{
 const f=restoredDirectQuitFixture(t);f.page.url=f.record.url;f.page.account='B';
 const before=f.retained();await assert.rejects(f.run({}),error=>error.code==='original_browser_binding_changed');
 assert.equal(f.context.quitCount,0);assert.equal(f.reads(),0);assert.equal(f.retained(),before);
});

test('maintenance does not accept an ordinary direct reading address as an upgraded ledger binding',async t=>{
 const f=restoredDirectQuitFixture(t);f.context.driver.pending.clear();f.context.workspace.pendingStarts={};
 f.context.runtime.call=async op=>{assert.equal(op,'maintenance-readiness');return f.proof();};
 await assert.rejects(f.run({maintenance:true}),/binding_unavailable/);assert.equal(f.context.quitCount,0);
 assert.equal(f.record.attempt.state,'unknown');assert.equal(f.record.url,f.home);
});

for(const busy of ['driver','submission','approval'])test('ordinary exit still waits for an actual '+busy+' call despite quiet unknown send history',async t=>{
 const f=fixture(t),record=f.context.driver.records.get('original'),attempt='control_'+'a'.repeat(32);
 record.latest_request.attempt_id=attempt;f.context.driver.pending.set('original',{attempt,state:'unknown'});
 f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 if(busy==='driver')f.context.driver.busy.add('original');
 if(busy==='submission')f.context.submissions.busy.add('original');
 if(busy==='approval')f.context.driver.approvals={busy:new Set(['original'])};
 await assert.rejects(f.run({}),error=>error.code==='exit_local_operation_pending');assert.equal(f.context.quitCount,0);
 assert.equal(f.context.driver.pending.get('original').state,'unknown');
});

for(const changed of ['request','attempt','pending-input','document'])test('ordinary unknown send quit rejects late '+changed+' identity drift without settling the original',async t=>{
 const f=fixture(t),record=f.context.driver.records.get('original'),attempt='control_'+'a'.repeat(32);
 record.latest_request.attempt_id=attempt;f.context.driver.pending.set('original',{attempt,state:'unknown'});
 f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 f.context.runtime.call=async()=>{
  if(changed==='request')record.latest_request.id='another-request';
  if(changed==='attempt')record.latest_request.attempt_id='another-attempt';
  if(changed==='pending-input')f.context.workspace.pendingStarts.original={operation_id:'new-unrelated-input'};
  if(changed==='document')f.context.pool.pages.get('original').documentGeneration=2;
  return {...f.proof(),exitMode:'ordinary'};
 };
 await assert.rejects(f.run({}),/execution_unresolved|page_changed|binding_unavailable/);assert.equal(f.context.quitCount,0);
 assert.equal(f.context.driver.pending.get('original').state,'unknown');
});
test('duplicate quits during the same proof check do not pause or prepare a second time',async t=>{
 const f=fixture(t);let release,pauses=0;f.context.driver.pauseAll=()=>{pauses++;return new Promise(resolve=>{release=resolve;});};f.context.driver.reconcileAll=async()=>{};
 const first=f.run({}),second=f.run({});await new Promise(resolve=>setImmediate(resolve));assert.equal(pauses,1);release();const [a,b]=await Promise.all([first,second]);assert.equal(a.exit.exit_id,b.exit.exit_id);assert.equal(f.calls.filter(c=>c==='prepare').length,1);assert.equal(f.context.quitCount,1);
});
test('ordinary exit observes physical renderer absence for a paused terminal bound page',async t=>{
 const f=fixture(t),record=f.context.driver.records.get('original'),page=f.context.pool.pages.get('original');Object.assign(record,{page_id:page.id,phase:'bound',latest_request:{id:'original-request',phase:'completed',attempt_id:null,sent_user_hash:null}});page.view=null;page.rendererState='unloaded';f.context.requiresRenderer=require('../page-residency.cjs').requiresRenderer;f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 const original=f.context.runtime.call;f.context.runtime.call=async(op,payload)=>{assert.equal(payload.paused_carriers.length,1);assert.equal(payload.paused_carriers[0].request_id,'original-request');assert.equal(payload.paused_carriers[0].marker,null);return original(op,payload);};
 const result=await f.run({});assert.equal(result.exiting,true);assert.equal(record.latest_request.phase,'completed');assert.equal(page.view,null);
});
test('physical renderer absence cannot stand in for the DOM of an active original request',async t=>{
 const f=fixture(t),record=f.context.driver.records.get('original'),page=f.context.pool.pages.get('original');record.page_id=page.id;record.phase='bound';record.latest_request.phase='processing';page.view=null;page.rendererState='unloaded';f.context.requiresRenderer=require('../page-residency.cjs').requiresRenderer;f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 await assert.rejects(f.run({}),/original_page_unavailable/);assert.equal(f.context.quitCount,0);
});
test('ordinary quit checks generating account pages outside managed records',async t=>{const f=fixture(t),url='https://chatgpt.com/c/manual',wc=Object.assign(new EventEmitter(),{id:2,getURL:()=>url});f.context.pool.pages.set('account',{id:'account',kind:'account',view:{webContents:wc}});f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};let scanned=false;const original=f.context.runDom;f.context.runDom=async contents=>contents===wc?(scanned=true,{url,editor:true,controlKnown:true,generating:true,draft:false,composing:false,approvalRequired:false}):original(contents);await assert.rejects(f.run({}),/原网页仍在工作/);assert.equal(scanned,true);assert.equal(f.context.quitCount,0);assert.equal(f.context.driver.stopped,false);});
test('owned Native history preview DOM becoming active during verify prevents closing the same owner',async t=>{const f=fixture(t),url='https://chatgpt.com/c/native-preview',wc=Object.assign(new EventEmitter(),{id:3,getURL:()=>url});f.context.nativePreviewPool={pages:new Map([['history',{id:'history',view:{webContents:wc}}]])};let active=false;f.context.nativeBridge.verifyMaintenance=async p=>{active=true;return p;};const original=f.context.runDom;f.context.runDom=async contents=>contents===wc?{url,editor:true,controlKnown:true,generating:active,draft:false,composing:false,approvalRequired:false}:original(contents);await assert.rejects(f.run({maintenance:true}),/原网页仍在工作/);assert.equal(f.context.quitCount,0);assert.deepEqual(f.calls,['prepare','release']);});
for(const field of ['nativeBridge','runtime','driver','pool','workspace'])test('original '+field+' replacement during proof read rejects exit',async t=>{const f=fixture(t);f.context.runtime.call=async()=>{const p=f.proof();f.context[field]={...f.context[field]};return p;};await assert.rejects(f.run({maintenance:true}),/execution_unresolved/);assert.equal(f.context.quitCount,0);assert.equal(f.context.maintenanceChecking,false);});
for(const mutation of ['generation','child','request','new-page','pending','busy','store','explicit-quit'])test('new '+mutation+' during async original proof read cannot be shut down',async t=>{const f=fixture(t);f.context.runtime.call=async()=>{const p=f.proof(),c=f.context;if(mutation==='generation')c.runtimeGeneration++;if(mutation==='child')c.runtime.child={pid:124};if(mutation==='request')c.driver.records.get('original').latest_request.id='new-request';if(mutation==='new-page')c.pool.pages.set('new',{kind:'task'});if(mutation==='pending')c.workspace.pendingStarts.new={operation_id:'original-key'};if(mutation==='busy')c.driver.busy.add('original');if(mutation==='store')c.runtime.store='different';if(mutation==='explicit-quit')c.maintenanceSerial++;return p;};await assert.rejects(f.run({maintenance:true}),/execution_unresolved/);assert.equal(f.context.quitCount,0);});
test('new Native Session activity after await verify is caught by the synchronous full Session read',async t=>{const f=fixture(t);f.context.nativeBridge.finalVerifyMaintenance=()=>{f.calls.push('final');throw Error('native_maintenance_session_changed');};await assert.rejects(f.run({maintenance:true}),/session_changed/);assert.deepEqual(f.calls,['prepare','verify','final','release']);assert.equal(f.context.quitCount,0);});
test('DB/WAL changed during final Native full Session scan rejects exit',async t=>{const f=fixture(t);f.context.nativeBridge.finalVerifyMaintenance=p=>{const dir=path.join(f.ROOT,'.local/harness');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'harness.sqlite3-wal'),'changed fixture');return p;};await assert.rejects(f.run({maintenance:true}),/store_changed/);assert.equal(f.context.quitCount,0);});
test('new public generation or draft and unresided active page prevent maintenance',async t=>{for(const state of ['generating','draft','unloaded']){const f=fixture(t);if(state==='unloaded')f.context.loaded=()=>false;else f.context.runDom=async()=>({url:f.context.driver.records.get('original').url,generating:state==='generating',draft:state==='draft',composing:false});await assert.rejects(f.run({maintenance:true}),/original_page_unavailable|原网页仍在工作/);assert.equal(f.context.quitCount,0);}});
test('wrong original Host PID, invalid time, incomplete inventory and ledger mismatch all reject',async t=>{for(const kind of ['pid','time','incomplete','ledger','instance','other-valid-instance']){const f=fixture(t);f.context.runtime.call=async()=>{const p=f.proof();if(kind==='pid')p.hostPid=124;if(kind==='time')p.observedAt=NaN;if(kind==='incomplete')p.jobs.inventoryComplete=false;if(kind==='ledger')p.ledgerFingerprint='bad';if(kind==='instance')p.instanceId='bad';if(kind==='other-valid-instance')p.instanceId='b'.repeat(32);return p;};await assert.rejects(f.run({maintenance:true}),/original_receipt|store_changed/);assert.equal(f.context.quitCount,0);}});
test('actual ordinary empty-owner quit binds a fresh original read despite a different Host wall clock',async t=>{
 const f=fixture(t);f.context.pool.pages.clear();f.context.driver.records.clear();f.context.workspace.tasks.clear();
 f.context.nativeBridge=null;f.context.nativeInitialization={state:'disabled',ownerStarted:false};
 f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};
 let reads=0,returned;f.context.runtime.call=async op=>{assert.equal(op,'maintenance-readiness');reads++;returned={...f.proof(),exitMode:'ordinary'};returned.observedAt+=3600;return returned;};
 const result=await f.run({});assert.equal(result.exiting,true);assert.equal(f.context.quitCount,1);assert.equal(reads,1);
 assert.equal(f.context.maintenanceClosingContext.hostProof,returned);assert.equal(f.context.maintenanceClosingContext.freshRead.kind,'original_host_maintenance_fresh_read');
 assert.doesNotThrow(()=>maintenanceExit.assertProof(f.ROOT,returned,f.context.maintenanceClosingContext));
});
test('both exact paused-carrier reads preserve the same fresh Host proof binding',async t=>{
 const f=fixture(t);blankPausedOffer(f);const call=f.context.runtime.call;let returned,views=0;
 f.context.runtime.call=async(op,payload)=>{if(op==='view'){views++;return call(op,payload);}returned=await call(op,payload);returned.observedAt+=3600;return returned;};
 const result=await f.run({maintenance:true});assert.equal(result.exiting,true);assert.equal(views,2);assert.equal(f.context.maintenanceClosingContext.hostProof,returned);
 assert.doesNotThrow(()=>maintenanceExit.assertProof(f.ROOT,returned,f.context.maintenanceClosingContext));assert.equal(f.context.driver.records.get('original').latest_request.phase,'suspended');
});
test('pipe rejection preserves original instance and never invokes quit',async t=>{const f=fixture(t);f.context.runtime.call=async()=>{throw Error('maintenance_jobs_active');};await assert.rejects(f.run({maintenance:true}),/jobs_active/);assert.equal(f.context.quitCount,0);assert.equal(f.context.maintenanceChecking,false);});
test('missing bridge after configured, pending or failed startup cannot imply absence of its owner',async t=>{for(const state of ['pending','configured','starting','failed','ready']){const f=fixture(t);f.context.nativeBridge=null;f.context.nativeInitialization={state,ownerStarted:['starting','failed','ready'].includes(state)};await assert.rejects(f.run({maintenance:true}),/native_owner_unavailable/);assert.equal(f.context.quitCount,0);assert.deepEqual(f.calls,[]);}});
test('explicitly disabled Native in this process proves only owned native never started',async t=>{const f=fixture(t);f.context.nativeBridge=null;f.context.nativeInitialization={state:'disabled',ownerStarted:false};const r=await f.run({maintenance:true});assert.equal(r.nativeScope,'owned_native_not_started');assert.equal(f.context.quitCount,1);assert.deepEqual(f.calls,[]);});
test('actual pre-owner Native configuration failure leaves ordinary idle quit available',async t=>{
 const setupStart=main.indexOf('const bridgeSetup='),setupEnd=main.indexOf('function savePages()',setupStart);assert.ok(setupStart>0&&setupEnd>setupStart);
 let configureCalls=0;const setup={isolatedCheck:false,nativeBridgeModule:{configure:async()=>{configureCalls++;throw Error('fixture_configuration_rejected');}},app:{},ROOT:'fixture-root',nativeInitialization:{state:'pending',ownerStarted:false},notice:''};
 const configured=await vm.runInNewContext('(async()=>{'+main.slice(setupStart,setupEnd)+';return await bridgeSetup;})()',setup);
 assert.equal(configureCalls,1);assert.equal(configured,null);assert.equal(setup.nativeInitialization.ownerStarted,false);assert.match(setup.notice,/fixture_configuration_rejected/);
 const f=fixture(t);f.context.nativeBridge=null;f.context.nativeInitialization=setup.nativeInitialization;f.context.driver.pauseAll=async()=>f.calls.push('pause-future');f.context.driver.reconcileAll=async()=>{};
 const result=await f.run({});assert.equal(result.maintenance,false);assert.equal(result.nativeScope,'owned_native_not_started');assert.equal(f.context.quitCount,1);assert.deepEqual(f.calls,['pause-future']);
});
test('later Native startup or unknown cleanup cannot use the pre-owner configuration absence fact',async t=>{
 for(const state of ['starting','failed','cleanup_unknown']){const f=fixture(t);f.context.nativeBridge=null;f.context.nativeInitialization={state,ownerStarted:true};
  f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{};await assert.rejects(f.run({}),error=>error.message==='maintenance_original_native_owner_unavailable');assert.equal(f.context.quitCount,0);}
});
test('old loaded bridge without current-owner fencing refuses before any Host observation',async t=>{const f=fixture(t);f.context.nativeBridge={turns:()=>[]};f.context.runtime.call=()=>{throw Error('Host must not be read');};await assert.rejects(f.run({maintenance:true}),/original_receipt/);assert.equal(f.context.quitCount,0);});
test('ambiguous prepare releases only the same retained controller intent and never retries acquire',async t=>{const f=fixture(t);f.context.nativeBridge.prepareMaintenance=async()=>{f.calls.push('prepare');throw Error('native_maintenance_original_fence_unresolved');};await assert.rejects(f.run({maintenance:true}),/fence_unresolved/);assert.deepEqual(f.calls,['prepare','release']);assert.equal(f.context.quitCount,0);assert.equal(f.context.driver.stopped,false);});
test('unknown release retains the original Host refusal and restores the original precheck gate',async t=>{const f=fixture(t);f.context.runtime.call=async()=>{throw Error('maintenance_jobs_unverified');};f.context.nativeBridge.resumeMaintenance=async()=>{f.calls.push('release');throw Error('native_maintenance_release_unknown');};await assert.rejects(f.run({maintenance:true}),error=>error.message.includes('maintenance_jobs_unverified')&&error.message.includes('native_maintenance_release_unknown')&&error.cause.message==='maintenance_jobs_unverified'&&error.releaseError.message==='native_maintenance_release_unknown');assert.equal(f.context.quitCount,0);assert.equal(f.context.driver.stopped,false);assert.equal(f.context.maintenanceChecking,false);assert.deepEqual(f.calls,['prepare','release']);});
test('new pending task or navigation during DOM or Native verify await rejects without quit',async t=>{for(const stage of ['dom','verify'])for(const change of ['pending','url']){const f=fixture(t),mutate=()=>{if(change==='pending')f.context.workspace.pendingStarts.new={operation_id:'same-original-key'};else f.context.pool.pages.get('original').view.webContents.getURL=()=> 'https://chatgpt.com/c/another';};if(stage==='dom')f.context.runDom=async()=>{mutate();return {url:f.context.driver.records.get('original').url,generating:false,draft:false,composing:false};};else f.context.nativeBridge.verifyMaintenance=async p=>{mutate();return p;};await assert.rejects(f.run({maintenance:true}),/execution_unresolved|binding_unavailable/);assert.equal(f.context.quitCount,0);assert.equal(f.context.driver.stopped,false);}});
test('the native receipt must prove all physical and broker work settled, not only health zeros',async t=>{for(const key of ['activeHttp','activeBrowser','brokerPending','externalOwners','physicalCleanup','pendingCompactions','acceptingTurns']){const f=fixture(t);f.context.nativeBridge.prepareMaintenance=async()=>({...f.nativeProof(),[key]:key==='acceptingTurns'?true:1});await assert.rejects(f.run({maintenance:true}),/original_receipt/);assert.equal(f.context.quitCount,0);}});
test('fresh Native proof cannot replace the prepare-time owner, admission or Session baseline',async t=>{for(const field of ['runtimePid','ownerEpoch','fenceId','admissionSha256'])for(const stage of ['verify','final']){const f=fixture(t),mutate=p=>({...p,[field]:field==='runtimePid'?457:field==='admissionSha256'?'b'.repeat(64):'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'});if(stage==='verify')f.context.nativeBridge.verifyMaintenance=async p=>mutate(p);else f.context.nativeBridge.finalVerifyMaintenance=p=>mutate(p);await assert.rejects(f.run({maintenance:true}),/native_session_changed/);assert.equal(f.context.quitCount,0);}});
test('Native initialization changing during Host or DOM await invalidates the original intent',async t=>{const f=fixture(t);f.context.runtime.call=async()=>{f.context.nativeInitialization={state:'starting',ownerStarted:true};return f.proof();};await assert.rejects(f.run({maintenance:true}),/execution_unresolved/);assert.equal(f.context.quitCount,0);});
test('old READY without an original instance id refuses before acquiring any Native fence',async t=>{for(const instance of [undefined,'','bad']){const f=fixture(t);f.context.runtime.info.instance_id=instance;await assert.rejects(f.run({maintenance:true}),/host_instance_unavailable/);assert.equal(f.context.quitCount,0);assert.deepEqual(f.calls,[]);}});

test('ordinary quit drains original selected view and activity reads before requiring an empty private pipe',async t=>{
 const f=fixture(t),{SelectedViewPoller}=require('../state-pipeline.cjs');let finishView,finishActivity;
 const read=(key,assign)=>async()=>{f.context.runtime.pending.set(key,{});try{return await new Promise(resolve=>assign(resolve));}finally{f.context.runtime.pending.delete(key);}};
 const poller=new SelectedViewPoller({identity:()=>({pageId:'original',threadId:'original-thread'}),
  read:read('view',resolve=>{finishView=resolve;}),readActivity:read('activity',resolve=>{finishActivity=resolve;}),onView(){}});
 f.context.selectedViewPoller=poller;void poller.refresh({force:true});await new Promise(resolve=>setImmediate(resolve));
 f.context.driver.pauseAll=async()=>{};f.context.driver.reconcileAll=async()=>{await poller.refresh({force:true});};
 const quitting=f.run({});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.context.quitCount,0);assert.equal(f.context.runtime.pending.size,2);assert.deepEqual(f.calls,[]);
 finishView({page_id:'original',thread_id:'original-thread'});finishActivity({});
 assert.equal((await quitting).exiting,true);assert.equal(f.context.quitCount,1);assert.equal(f.context.runtime.pending.size,0);
});

test('a selected observation drain timeout preserves the original read and restores observation without claiming exit',async t=>{
 const f=fixture(t);let resumes=0;f.context.selectedViewPoller={quiesce:async()=>({drained:false,pending:1}),resume:()=>resumes++};
 await assert.rejects(f.run({}),/exit_observation_pending/);assert.equal(f.context.quitCount,0);assert.deepEqual(f.calls,[]);assert.equal(resumes,1);
});
test('a later terminal Session hash cannot silently become the prepare-time Native baseline',async t=>{const f=fixture(t),threadId='11111111-2222-7333-8444-555555555555',turnId='66666666-7777-7888-9999-aaaaaaaaaaaa';const row={traceId:'deadbeef0001',threadId,turnId,state:'completed',endedAt:new Date().toISOString(),threadActive:false,activeTurnId:null,taskAcceptance:'unverified',claimReleaseAuthorized:false,workflowJobAbsenceProven:false,nativeProof:{version:1,kind:'canonical_native_maintenance_session',threadId,turnId,terminal:'task_complete',sessionSha256:'a'.repeat(64),eventSha256:'b'.repeat(64)}};f.context.nativeBridge.prepareMaintenance=async()=>({...f.nativeProof(),nativeTurns:[row]});f.context.nativeBridge.verifyMaintenance=async p=>({...p,nativeTurns:[{...row,nativeProof:{...row.nativeProof,sessionSha256:'c'.repeat(64)}}]});await assert.rejects(f.run({maintenance:true}),/native_session_changed/);assert.equal(f.context.quitCount,0);});
