'use strict';
const focusStartup=require('./focus-startup.cjs');
if(focusStartup.isFocusOnly(process.argv)){
  const path=require('node:path'),{app}=require('electron');
  focusStartup.runFocusOnly({app,argv:process.argv,profile:path.resolve(__dirname,'../../.local/web-host')});
}else{
const {app,BrowserWindow,WebContentsView,ipcMain,Tray,Menu,nativeImage,powerSaveBlocker,powerMonitor,shell,session,dialog,clipboard}=require('electron');
const path=require('node:path'),fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const focusInstanceId=randomUUID().replace(/-/g,'');
const {pathToFileURL}=require('node:url');
const {BrowserPool}=require('./browser-pool.cjs');
const {WorkspaceState,restoreConversationUrl,boundConversationUrl}=require('./workspace-state.cjs');
const {StatusFileWriter}=require('./status-files.cjs');
const {StatePublisher,SelectedViewPoller,projectObservation,projectTaskRelations}=require('./state-pipeline.cjs');
const {captureTaskIdentity,activeRequestId}=require('./task-action-identity.cjs');
const contextPicker=require('./context-picker.cjs');
const appControlIdentity=require('./app-control-identity.cjs');
const {ShellControl}=require('./shell-control.cjs');
const {writePrivateFileAtomic}=require('../codex-web-bridge/upstream/launcher/electron/atomic-file.cjs');
const {taskLocation,removeClosedTask}=require('./task-lifecycle.cjs');
const {TaskSubmission,startExistingTask}=require('./task-submission.cjs');
const {NetworkGuard,configureNetworkFlags}=require('./network-guard.cjs');
const previewConfig=require('./preview-config.cjs');
const pageDOM=require('./page-dom.cjs'),{runDom}=pageDOM;
const {ApprovalManager}=require('./approval-manager.cjs');
const {requiresRenderer,loaded}=require('./page-residency.cjs');
const {knownIdleSnapshot}=require('./web-driver.cjs');
const shutdownPolicy=require('./shutdown-policy.cjs');
const {nativeMaintenanceTurns,verifyNativeMaintenanceReceipt}=require('./native-turn-reads.cjs');
const maintenanceExit=require('./maintenance-exit.cjs');
const {createExitLifecycle,reason:exitFailureReasons}=require('./exit-lifecycle.cjs');
const {createOrdinaryExit}=require('./ordinary-exit.cjs');
const recordCommands=require('./record-commands.cjs');
const ROOT=path.resolve(__dirname,'../..'),profile=path.join(ROOT,'.local','web-host');
const previewMode=fs.existsSync(path.join(ROOT,'.local','preview-installation.json'));
const defaultWebAccount=previewConfig.defaultAccount(ROOT),partition='persist:clw-account-'+defaultWebAccount.toLowerCase();
const isolatedCheck=require('./isolated-app-check.cjs').prepareIsolatedCheck(ROOT,process.argv);
const {AccountAccess}=require('./account-access.cjs');
const {AccountQuota}=require('./account-quota.cjs');
const quotas=new Map(['A','B'].map(account=>[account,new AccountQuota(ROOT,account)]));
// Saved account statistics only. Online history/verification stays disabled
// until a separate user decision; it must not affect manual Web/MCP work.
const quotaSnapshots=()=>[...quotas.values()].map(q=>({...q.snapshot(),historyPolicy:'cache_only',historyProgress:null}));
const accountAccess=new Map(['A','B'].map(account=>[account,new AccountAccess(ROOT,account)]));
const accountAccessFor=account=>accountAccess.get(account);
const localCodex=require('./local-codex.cjs').createLocalCodex(ROOT,previewMode?{getEnvironment:()=>previewConfig.childEnvironment(ROOT,process.env,guard.options)}:{});
const partitionForAccount=account=>{if(!['A','B'].includes(account))throw Error('账号选择无效。');return 'persist:clw-account-'+account.toLowerCase();};
const fileApprovalAuthorized=(kind='returned_file')=>{const p=require('../codex-web-bridge/bridge-config.cjs').readUserAuthorization(ROOT);return p?.enabled===true&&(kind==='tool'?p.auto_approve_tools===true:p.auto_approve_returned_files===true);};
const allowedUrl=raw=>{try{const u=new URL(raw);return u.protocol==='https:'&&['chatgpt.com','auth.openai.com','auth0.openai.com','accounts.google.com','login.microsoftonline.com','login.live.com','appleid.apple.com'].includes(u.hostname);}catch{return false;}};
// Electron includes this identifier in HTTP User-Agent. Keep the product token
// ASCII; the visible window/tray titles remain localized.
app.setPath('userData',profile);app.setName('CLWWebWorkspace');configureNetworkFlags(app,previewConfig.networkOptions(ROOT));
let guard=new NetworkGuard(previewConfig.networkOptions(ROOT));
let win,pool,tray,workspace,submissions,quitting=false,finalQuit=false,notice='',runtime=null,driver=null,view=null;
let nativeBridge=null,nativeConversations=null,nativePreviewPool=null,workspaceRestored=false;
let nativeInitialization={state:'pending',ownerStarted:false};
let maintenanceQuit=false,maintenanceChecking=false,maintenanceSerial=0,maintenanceClosingContext=null,coldQuitContext=null,runtimeEverReady=false;
let snapshotFailures=[],runtimeGeneration=0,selectedReadGeneration=0,lastSelectedPage=null,stateTimer=null;
let selectedRecordsRead=null;
let appControl=null,shellExitOperation=null,shellControl=null,shellRevision=0,shellSources=null,shellReloading=false;
let pageAdapterReloading=false;
const previewSetup=require('./preview-setup.cjs').createPreviewSetup(ROOT,{onChange:()=>publish()});
const exitLifecycle=createExitLifecycle({onChange:()=>publish({force:true})});
const ordinaryExit=createOrdinaryExit({pauseFuture:pauseOrdinaryQuitFuture,readActivity:readOrdinaryQuitActivity,close:()=>prepareQuit({future_paused:true}),onChange:state=>{
  if(state?.state==='cancelled')driver?.resumeObservation?.();
  if(!state||state.state==='closing')return;
  exitLifecycle.update(state.state,{...state});publish({force:true});
}});
const loadedMainSha=require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const eventLoopHistogram=require('node:perf_hooks').monitorEventLoopDelay({resolution:20});eventLoopHistogram.enable();
const statusWriter=new StatusFileWriter(profile,{onFailures:failures=>{snapshotFailures=failures;publish();}});
const statePublisher=new StatePublisher({collect:collectState,onProjection:persistProjection,
  send:state=>{if(win&&!win.isDestroyed())win.webContents.send('clw-state',state);},
  onError:error=>{console.error('CLW state projection unavailable:',error.code||error.message||'state_projection_failed');}});
const selectedViewPoller=new SelectedViewPoller({identity:()=>{
  const r=driver?.records.get(pool?.selected);
  return !quitting&&!maintenanceChecking&&runtime?.ready&&driver?.recordsLoaded&&r?{
    pageId:pool.selected,threadId:r.thread_id,requestId:r.latest_request?.id||null,
    runtimeGeneration,selectedReadGeneration}:null;
},read:identity=>runtime.call('view',{page_id:identity.pageId,record_summaries:true}),
readActivity:identity=>runtime.call('session-activity',{page_id:identity.pageId}),
onView:value=>{
  const page_id=pool?.selected,record=driver?.records.get(page_id);
  const sameReadFailure=value&&selectedRecordsRead?.page_id===page_id&&selectedRecordsRead.generation===selectedReadGeneration&&
    selectedRecordsRead.runtimeGeneration===runtimeGeneration&&selectedRecordsRead.state==='unavailable'&&selectedRecordsRead.acceptedRead===selectedViewPoller.latestAccepted;
  view=sameReadFailure?{...value,state_read:{unavailable:true,code:selectedRecordsRead.code}}:value;
  if(!sameReadFailure){
    const state=value?.page_id===page_id?'ready':record?(runtime?.ready&&driver?.recordsLoaded&&!quitting&&!maintenanceChecking?'loading':'unavailable'):'idle';
    selectedRecordsRead={page_id,generation:selectedReadGeneration,runtimeGeneration,state,code:state==='unavailable'?'runtime_selected_records_unavailable':null,acceptedRead:selectedViewPoller.latestAccepted};
  }
  publish();
},onError:error=>{
  // An unavailable read is not an execution failure. Preserve the original
  // ledger and mark its displayed view as stale until this identity is reread.
  if(view?.page_id===pool?.selected)view={...view,state_read:{unavailable:true,code:error.message}};
  selectedRecordsRead={page_id:pool?.selected,generation:selectedReadGeneration,runtimeGeneration,state:'unavailable',code:'runtime_selected_records_unavailable',acceptedRead:selectedViewPoller.latestAccepted};
  publish();
}});
const nativeBridgeModule=require('../codex-web-bridge/electron-host.cjs');
const connectionSettings=require('../codex-web-bridge/connection-settings.cjs');
const connectionExecution=require('../codex-web-bridge/connection-execution.cjs');
const runtimeAvailability=require('./runtime-availability.js');
let taskStateRead={state:'pending',code:null};
// Optional per-process route. Absent settings leave the existing carrier alone.
const bridgeSetup=(isolatedCheck?Promise.resolve(null):nativeBridgeModule.configure(app,ROOT)).then(configured=>{
  nativeInitialization={state:configured?'configured':'disabled',ownerStarted:false};return configured;
}).catch(e=>{nativeInitialization={state:'not_started',ownerStarted:false,reason:'configuration_failed_before_owner_start'};notice='Codex Web 接入待处理：'+e.message;return null;});
function savePages(){if(workspace&&pool){workspace.capture(pool,driver?.records);workspace.save();}}
function firstTurnOptions(payload={}){
  return {effort:payload.effort||'极高',access:payload.access||'write',write_paths:payload.write_paths||['.'],
    conversation_mode:payload.conversation_mode||'direct',collaboration_enabled:payload.collaboration_enabled===true,
    collaboration_protocol:payload.collaboration_protocol||'tool_v1',duration_seconds:payload.duration_seconds??null,max_dispatches:payload.max_dispatches??null};
}
function publish({force=false}={}){
  if(!win||win.isDestroyed()||quitting)return;
  statePublisher.request({force});
}
function collectState(){
  const selectedView=view?.page_id===pool?.selected?view:null;
  const currentRead=selectedRecordsRead?.page_id===pool?.selected&&selectedRecordsRead.generation===selectedReadGeneration&&selectedRecordsRead.runtimeGeneration===runtimeGeneration?selectedRecordsRead:null;
  const selectedRecord=driver?.records.get(pool?.selected);
  const readState=currentRead?.state||(selectedRecord?(runtime?.ready&&driver?.recordsLoaded&&!quitting&&!maintenanceChecking?'loading':'unavailable'):'idle');
  const selectedRecords={page_id:pool?.selected||null,state:readState,code:currentRead?.code||(readState==='unavailable'?'runtime_selected_records_unavailable':null)};
  // One observation per account makes a publication coherent and avoids the
  // same synchronous account file read for every member of a large team.
  const accessSnapshots=new Map([...accountAccess].map(([account,access])=>[account,access.snapshot()]));
  const relations=projectTaskRelations(driver?.records.values()||[]);
  const pages=(pool?.inspect()||[]).filter(p=>!p.closed).map(p=>{
    const r=driver?.records.get(p.id);
    const saved=workspace?.tasks.get(p.id);
    p.loading=p.resident&&!!(pool.pages.get(p.id)?.view?.webContents.isLoading?.()??p.status==='loading');
    return {...p,...relations.get(p.id),conversationUrl:boundConversationUrl(r),conversation_mode:r?.conversation_mode||saved?.conversation_mode||'managed',collaboration_enabled:r?.collaboration_enabled??saved?.collaboration_enabled??false,automaticWorkspace:!!saved?.automaticWorkspace,firstTurnDraft:saved?.firstTurnDraft||'',accountAccess:accessSnapshots.get(p.account||'B'),root:r?.root||p.root||'',model:r?.model,effort:r?.effort,collaboration_protocol:r?.collaboration_protocol||'tool_v1',bootstrap_model_selection:r?.bootstrap_model_selection,work_model_pending:!!r?.work_model_pending,bound:r?.phase==='bound',enrolling:!!r&&r.phase!=='bound',bootstrap_state:r?.bootstrap_state,paused:!!r?.paused,attention:r?.attention,issue_kind:r?.issue_kind,successor:r?.successor,successor_state:r?.successor_state,access:r?.access,write_paths:r?.write_paths,duration_seconds:r?.duration_seconds,max_dispatches:r?.max_dispatches,observation:pool.pages.get(p.id)?.observation||null};
  });
  for(const page of pages){const r=driver?.records.get(page.id);page.intake=r?.intake;page.bootstrap_wait=r?.bootstrap_wait;page.enrollment_phase=r?.phase;page.first_turn_instructions=r?.first_turn_instructions;page.first_turn_mode=r?.first_turn_mode;page.preparation_result=r?.preparation_result;page.latest_request=r?.latest_request;page.ended_recovery=r?.ended_recovery;page.maintenance=r?.maintenance;page.pause_origin=r?.pause_origin;page.budget_status=r?.budget_status;page.firstTurnOptions=workspace.tasks.get(page.id)?.firstTurnOptions;}
  for(const page of pages)page.goal=driver?.records.get(page.id)?.goal;
  const displayedNotice=[runtimeAvailability.currentNotice(notice,{networkReady:guard.ready}),snapshotFailures.length?'本机状态快照保存失败（'+snapshotFailures.map(f=>f.file+'：'+f.code).join('、')+'），旧快照可能过时；任务账本保留。':''].filter(Boolean).join('\n');
  return {root:ROOT,preview:previewMode?previewSetup.snapshot():null,defaultAccount:defaultWebAccount,exit:exitLifecycle.snapshot(),quotas:quotaSnapshots(),connected:!!runtime?.ready,runtime:runtime?.snapshot()||{state:'starting',code:null},taskStateRead:workspaceRestored&&runtime?.ready&&driver?.recordsLoaded?{state:'ready',code:null}:taskStateRead,connectionGeneration:runtimeGeneration,taskStateReady:workspaceRestored&&!!runtime?.ready&&!!driver?.recordsLoaded,pages,selected:pool?.selected,selectedRecords,closed:workspace?.closed()||[],theme:workspace?.theme||'dark',accent:workspace?.accent||'purple',pendingObjective:workspace?.pendingStarts[pool?.selected]?.objective||'',notice:displayedNotice,network:guard.state,view:selectedView,localCodex:localCodex.snapshot(),codexWeb:nativeBridge?.snapshot()||{state:workspaceRestored?'unconfigured':'starting'},codexConversation:nativeConversations?.snapshot()||null,recordHistory:{web:!!runtime?.ready,codex:typeof nativeBridge?.history==='function'}};
}
function persistProjection(state){
  const at=new Date().toISOString(),pages=state.pages,selectedView=state.view;
  statusWriter.request({
    // Sanitized enrollment reports are separate from metadata-only support.
    'intake-status.json':{at,pages:pages.filter(p=>p.enrolling).map(p=>({id:p.id,title:p.title,paused:p.paused,bootstrap_state:p.bootstrap_state,intake:p.intake}))},
    'health.json':{pid:process.pid,connected:state.connected,network:state.network,networkReady:guard.ready,pages:pages.length,
      residentPages:pages.filter(p=>p.resident).length,windowVisible:win.isVisible(),windowMinimized:win.isMinimized(),
      focusExistingProtocol:1,focusInstanceId,appControlProtocol:1,appControlAvailable:!!appControl,at},
    // Observation bodies are deliberately excluded even if a safety sample
    // retained the raw DOM locally. This support file never contains prompts.
    'task-status.json':{at,selected:state.selected,connected:state.connected,
      pages:pages.map(p=>({id:p.id,title:p.title,root:p.root,status:p.status,bound:p.bound,paused:p.paused,
        model:p.model,effort:p.effort,bootstrap_model_selection:p.bootstrap_model_selection,
        work_model_pending:p.work_model_pending,observation:projectObservation(p.observation)})),
      current:selectedView?{page_id:selectedView.page_id,request:selectedView.request,attempt:selectedView.attempt,
        send_stats:selectedView.send_stats,pending_notes:selectedView.pending_notes,state_read:selectedView.state_read}:null}
  });
  void selectedViewPoller.refresh();
}
function ownShell(event){if(event.sender!==win.webContents||event.senderFrame.url!==pathToFileURL(path.join(__dirname,'index.html')).href)throw Error('shell_only');}
function finishQuit(){
  driver?.dispose?.();
  eventLoopHistogram.disable();
  shellControl?.invalidate();
  Promise.allSettled([statusWriter.close(),appControl?.close()]).finally(()=>{finalQuit=true;app.quit();});
}
function currentShellSources(){
  return Object.fromEntries(['index.html','shell.css','shell.js','preload.cjs','rich-text.js','rich-text.css'].map(name=>
    [name,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')]));
}
function controlSnapshot(){
  const generation=runtimeGeneration;
  return {app_instance_id:focusInstanceId,pid:process.pid,root:ROOT,profile,runtime_generation:generation,
    selected:pool?.selected||null,observed_at:new Date().toISOString(),
    quotas:quotaSnapshots(),
    shell:{revision:shellRevision,sources:shellSources,loaded_main_sha256:loadedMainSha,reloading:shellReloading},
    page_adapter:{...pageDOM.adapterSnapshot(),reloading:pageAdapterReloading},
    connected:!!runtime?.ready,task_state_ready:workspaceRestored&&!!driver?.recordsLoaded,
    runtime:{...runtime?.snapshot(),pid:runtime?.child?.pid||null,store_id:runtime?.store||null,instance_id:runtime?.info?.instance_id||null},
    window:{visible:!!win?.isVisible(),minimized:!!win?.isMinimized(),theme:workspace?.theme||'dark',accent:workspace?.accent||'purple'},
    maintenance_checking:maintenanceChecking,quitting,exit:exitLifecycle.snapshot(),
    diagnostics:{uptime_seconds:Math.round(process.uptime()),memory:process.memoryUsage(),
      event_loop:{p95_ms:eventLoopHistogram.percentile(95)/1e6,max_ms:eventLoopHistogram.max/1e6},
      resident_pages:[...(pool?.pages.values()||[])].filter(page=>loaded(page)).length,
      resident_hidden_pages:[...(pool?.pages.values()||[])].filter(page=>loaded(page)&&(page.closed||page.hidden)).length,
      resident_native_previews:[...(nativePreviewPool?.pages.values()||[])].filter(page=>loaded(page)).length,
      native_turn_tabs:nativeBridge?.host?.turnTabs.size||0},
    pending:{submissions:submissions?.busy.size||0,web_operations:driver?.busy.size||0,
      original_submissions:Object.keys(workspace?.pendingStarts||{}).length},
    tasks:[...(pool?.pages.values()||[])].filter(page=>!page.closed&&!page.hidden).map(page=>{
      const row=driver?.records.get(page.id);
      return {id:page.id,title:page.title,identity:appControlIdentity.taskIdentity(page,row,generation),
        origin_operation:page.app_control_operation_id?{operation_id:page.app_control_operation_id,execution_reference:page.app_control_execution_reference}:null,
        phase:row?.phase||null,paused:!!row?.paused,request_phase:row?.latest_request?.phase||null,
        renderer_id:page.view?.webContents?.id||null,
        goal:row?.goal?{configured:!!row.goal.configured,state:row.goal.state,revision:row.goal.revision,mode:row.goal.mode}:null};
    }),
    native_tasks:(nativeBridge?.snapshot()?.recent||[]).map(row=>({trace_id:row.traceId,
      task_key:row.source?.threadId||'unmapped:'+row.traceId,thread_id:row.source?.threadId||null,
      turn_id:row.source?.turnId||null,account:row.account||row.source?.account||null,status:row.status,body_revision:row.bodyRevision||null}))};
}
async function reloadPageAdapter(payload,assertOwner=()=>{}){
  const reject=code=>{throw appControlIdentity.rejected(code);};
  const original={driver,runtime,child:runtime?.child,pool,workspace,submissions,win,
    contents:win?.webContents,nativeBridge,nativeHost:nativeBridge?.host,nativeConversations,nativePreviewPool,runtimeGeneration};
  const ready=()=>{
    if(quitting||maintenanceChecking||shellReloading||!driver||driver.stopped||driver.disposed||
      typeof driver.quiesceObservation!=='function'||typeof driver.resumeObservation!=='function')reject('app_page_adapter_busy');
    if(driver.busy.size||driver.bootstrapPrepared.size||driver.approvals?.busy?.size||
      submissions?.busy.size||Object.keys(workspace?.pendingStarts||{}).length)reject('app_page_adapter_preparation_pending');
    for(const [id,pending]of driver.pending){
      const request=driver.records.get(id)?.latest_request;
      // Updating the observer must not require the ACK that this observer may
      // need to recover. Keep every original unknown value and pending key;
      // active preparation is gated above and binding CAS checks them below.
      if(!request?.id||!request.attempt_id||pending?.attempt!==request.attempt_id)
        reject('app_page_adapter_original_send_unresolved');
    }
  };
  if(pageAdapterReloading||driver?.pageAdapterReloading||driver?.observationQuiesced)reject('app_page_adapter_busy');
  assertOwner();ready();
  const expectedAdapter=pageDOM.adapterSnapshot();
  const owners=[pool,nativePreviewPool,nativeBridge?.host].filter(Boolean).map(owner=>({owner,
    pages:owner.pages||owner.turnTabs,entries:[...(owner.pages||owner.turnTabs||[])].map(([id,page])=>({id,page,
      view:page.view,contents:page.view?.webContents}))}));
  const binding=()=>JSON.stringify({selection:pool?.selected,nativeSelection:nativePreviewPool?.selected,
    runtimeReady:runtime?.ready,runtimeStore:runtime?.store,runtimeInfoStore:runtime?.info?.store_id,
    runtimeInstance:runtime?.info?.instance_id,runtimePID:runtime?.child?.pid,
    driverGeneration:driver.connectionGeneration,recordsLoaded:driver.recordsLoaded,
    records:[...driver.records].map(([id,row])=>[id,row.page_id,row.thread_id,row.account,row.root,row.url,row.phase,
      row.paused,row.pause_origin,row.model,row.effort,row.access,row.write_paths,row.collaboration_protocol,
      row.goal?.revision,row.goal?.state,row.latest_request?.id,row.latest_request?.attempt_id,row.latest_request?.phase,
      row.latest_request?.sent_user_hash,row.latest_request?.cancel_requested,
      row.attempt?.id,row.attempt?.state,row.attempt?.dispatched,row.attempt?.acknowledged,row.carrier_recovery,
      ['paused','pause_origin'].map(key=>Object.hasOwn(row,key)),
      ['id','attempt_id','phase','sent_user_hash','cancel_requested'].map(key=>Object.hasOwn(row.latest_request||{},key)),
      ['id','state','dispatched','acknowledged'].map(key=>Object.hasOwn(row.attempt||{},key))]),
    pending:[...driver.pending].map(([id,pending])=>[id,pending.attempt,pending.state,pending.assistantBefore,
      ['attempt','state','assistantBefore'].map(key=>Object.hasOwn(pending,key))]),
    pages:owners.map(({entries})=>entries.map(({id,page,contents})=>[id,page.id,page.account,page.root,page.url,
      page.closed,page.hidden,page.documentGeneration,!!page.hydration,!!page.hydratingView,contents?.getURL?.()]))});
  const baseline=binding();
  const assertOriginal=()=>{
    assertOwner();
    if(driver!==original.driver||runtime!==original.runtime||runtime?.child!==original.child||
      pool!==original.pool||workspace!==original.workspace||submissions!==original.submissions||win!==original.win||
      win?.webContents!==original.contents||nativeBridge!==original.nativeBridge||nativeBridge?.host!==original.nativeHost||nativeConversations!==original.nativeConversations||
      nativePreviewPool!==original.nativePreviewPool||runtimeGeneration!==original.runtimeGeneration||
      owners.some(({owner,pages,entries})=>(owner.pages||owner.turnTabs)!==pages||pages.size!==entries.length||
        entries.some(({id,page,view,contents})=>pages.get(id)!==page||page.view!==view||page.view?.webContents!==contents||contents?.isDestroyed?.()))||
      binding()!==baseline)reject('app_page_adapter_original_owner_changed');
    ready();
  };
  let committed=false;
  pageAdapterReloading=true;original.driver.pageAdapterReloading=true;
  try{
    await original.driver.quiesceObservation({timeoutMs:10000});
    assertOriginal();
    const result=pageDOM.reloadDOMImplementation({expectedSHA:payload.expected_page_dom_sha256,
      expectedAdapter,assertCurrent:assertOriginal});
    committed=true;
    return {page_adapter:result,web_owners_preserved:true,runtime_pid:original.child?.pid||null,
      model_sends:0,web_generation_paused:false};
  }catch(error){if(committed)error.accepted=true;throw error;}
  finally{
    pageAdapterReloading=false;delete original.driver.pageAdapterReloading;
    try{original.driver.resumeObservation();}catch(error){if(committed)error.accepted=true;throw error;}
  }
}
async function reloadShell(assertOwner=()=>{}){
  if(shellReloading||quitting||maintenanceChecking)throw appControlIdentity.rejected('app_shell_busy');
  shellReloading=true;
  const contents=win.webContents,blockInput=event=>event.preventDefault();
  contents.on('before-input-event',blockInput);contents.on('before-mouse-event',blockInput);
  try{
    const ready=await shellControl.request('prepare-reload');
    assertOwner();
    if(ready?.safe!==true)throw appControlIdentity.rejected('app_shell_draft_not_saved');
    const owners=ownedQuitPages().map(({page,contents})=>({page,contents})),original={runtime,child:runtime?.child,driver,nativeBridge};
    const sources=currentShellSources();
    shellControl.invalidate();await win.loadFile(path.join(__dirname,'index.html'));
    assertOwner(true);
    shellRevision++;shellSources=sources;publish({force:true});
    const inspected=await shellControl.request('inspect');
    assertOwner(true);
    const preserved=owners.every(({page,contents})=>!contents||page.view?.webContents===contents&&!contents.isDestroyed());
    if(JSON.stringify(currentShellSources())!==JSON.stringify(sources))throw Error('app_shell_sources_changed_during_load');
    if(runtime!==original.runtime||runtime?.child!==original.child||driver!==original.driver||nativeBridge!==original.nativeBridge||!preserved)
      throw Error('app_shell_original_owner_changed');
    return {reloaded:true,shell_revision:shellRevision,web_owners_preserved:preserved,
      runtime_pid:runtime?.child?.pid||null,model_sends:0,inspection:inspected};
  }finally{contents.removeListener('before-input-event',blockInput);contents.removeListener('before-mouse-event',blockInput);shellReloading=false;}
}
function pageById(id=pool.selected){const p=pool.pages.get(id);if(!p||p.closed||p.hidden)throw Error('请先选择一个任务。');return p;}
function chooseNext(){
  const next=[...pool.pages.values()].filter(p=>!p.closed&&!p.hidden).at(-1);
  if(next)pool.select(next.id);else{pool.selected=null;pool.native=false;pool.layout();}
  view=null;
}
function coldExitIdle(){
  const nativeAbsent=!nativeBridge&&nativeInitialization.ownerStarted===false&&['disabled','not_started','cleaned'].includes(nativeInitialization.state);
  return workspaceRestored&&nativeAbsent&&!runtimeEverReady&&!runtime?.info&&!runtime?.store&&!runtime?.child&&!runtime?.starting&&!runtime?.pending?.size&&
    !creating&&!driver?.records.size&&!driver?.busy.size&&!driver?.pending.size&&!submissions?.busy.size&&
    workspace&&![...workspace.tasks.values()].some(p=>p.kind!=='account')&&!Object.keys(workspace.pendingStarts||{}).length&&
    !fs.existsSync(path.join(ROOT,'.local/harness/harness.sqlite3'));
}
function ownedQuitPages(){
  const result=[],seen=new Set();
  const add=(page,owner)=>{const contents=page.view?.webContents;if(contents&&seen.has(contents))return;if(contents)seen.add(contents);result.push({page,owner,view:page.view,contents,url:contents?.getURL?.(),documentGeneration:page.documentGeneration});};
  for(const owner of [pool,nativePreviewPool])for(const page of owner?.pages?.values()||[])add(page,owner);
  for(const page of nativeBridge?.host?.turnTabs?.values()||[])add(page,nativeBridge.host);
  return result;
}
function hostQuitPageRevision(){return JSON.stringify(ownedQuitPages().filter(row=>row.owner===pool).map(({page,contents,url,documentGeneration})=>[page.id,contents?.id,url,documentGeneration,page.hydration?true:false,page.hydratingView?true:false]));}
function coldPageRevision(){return JSON.stringify(ownedQuitPages().map(({page,contents,url,documentGeneration})=>[page.id,contents?.id,url,documentGeneration,page.hydration?true:false,page.hydratingView?true:false]));}
function lockQuitPageInput(pages){
  const held=[],stop=event=>event.preventDefault();
  try{for(const {contents} of pages){if(!contents)continue;
    if(typeof contents.on!=='function'||typeof contents.removeListener!=='function')throw Error('maintenance_original_input_gate_unavailable');
    contents.on('before-input-event',stop);contents.on('before-mouse-event',stop);held.push(contents);
  }}catch(error){for(const contents of held){contents.removeListener('before-input-event',stop);contents.removeListener('before-mouse-event',stop);}throw error;}
  let released=false;return ()=>{if(released)return;released=true;for(const contents of held){contents.removeListener('before-input-event',stop);contents.removeListener('before-mouse-event',stop);}};
}
function pausedUnsentQuitWorkPending(id){
  const request=driver?.records.get(id)?.latest_request;
  return driver?.pending.has(id)||driver?.busy.has(id)||driver?.bootstrapPrepared?.has(id)||
    driver?.resultCandidates?.has(request?.attempt_id)||driver?.approvals?.busy?.has(id);
}
async function pausedUnsentQuitPage(original,snapshot,binding,assertCurrent,hostContext){
  // A retained paused offer is not a running browser turn. If its original
  // conversation failed to load at all, use the same Host's current execution
  // proof and exact unsent offer; do not turn the business history into success.
  const {page,owner,view,contents,url,documentGeneration}=original,request=binding?.latest_request;
  const homepage=(url==='https://chatgpt.com/'||url==='https://chatgpt.com')&&snapshot.url===url;
  const blankHome=homepage&&
    Object.hasOwn(snapshot,'historyAtLatest')&&(snapshot.historyAtLatest===null||snapshot.historyAtLatest===true)&&
    snapshot.attemptMarker===null&&snapshot.attemptMarkerCount===0&&
    snapshot.bootstrapMarker===null&&snapshot.bootstrapMarkerCount===0;
  const emptyHome=blankHome&&snapshot.editor===true&&snapshot.controlKnown===true;
  const unavailableHome=blankHome&&snapshot.editor===false&&snapshot.controlKnown===false;
  const unavailable=snapshot.editor===false&&snapshot.controlKnown===false&&(binding?.url===url||unavailableHome);
  if(!hostContext||owner!==pool||page.kind!=='task'||binding?.phase!=='bound'||binding.paused!==true||
     !binding.thread_id||!['suspended',...(emptyHome?['queued']:[])].includes(request?.phase)||!request.id||!request.attempt_id||
     pausedUnsentQuitWorkPending(page.id)||
     (!unavailable&&!emptyHome)||snapshot.complete!==false||
     !['generating','draft','composing','approvalRequired','blocked','loginRequired','accessLimited'].every(key=>snapshot[key]===false)||
     !['userId','assistantId','userText','publicText','html','failure'].every(key=>snapshot[key]==='')||
     snapshot.error||snapshot.unknown||snapshot.known===false)return false;
  const bindingRevision=()=>JSON.stringify([binding.thread_id,binding.url,binding.paused,binding.phase,
    binding.account,binding.model,binding.effort,binding.root,binding.access,binding.write_paths,binding.latest_request]);
  const revision=bindingRevision();
  const sameBinding=()=>owner.pages.get(page.id)===page&&page.view===view&&
    !contents.isDestroyed?.()&&page.documentGeneration===documentGeneration&&contents.getURL()===url&&
    driver.records.get(page.id)===binding&&bindingRevision()===revision;
  const current=()=>{assertCurrent();if(!sameBinding())throw Error('maintenance_original_binding_unavailable');};
  current();
  if(emptyHome||unavailableHome){
    if(!['A','B'].includes(binding.account)||!['model','effort','root','access'].every(key=>typeof binding[key]==='string'&&binding[key])||
       !Array.isArray(binding.write_paths))return false;
    const composer=await runDom(contents,'connector-state');current();
    if(composer?.editorCount!==(emptyHome?1:0)||composer.text!==''||
       !['generating','composing','approvalRequired','blocked','accessLimited'].every(key=>composer[key]===false))return false;
  }
  if(hostContext.proof)maintenanceExit.assertProof(ROOT,hostContext.proof,hostContext.original);assertCurrent();
  const state=await hostContext.original.runtime.call('view',{page_id:page.id,record_summaries:true});
  current();if(hostContext.proof)maintenanceExit.assertProof(ROOT,hostContext.proof,hostContext.original);
  const latest=state?.latest_request,attempt=state?.attempt,lifecycle=state?.renderer_lifecycle;
  const sameScope=!(emptyHome||unavailableHome)||state?.access===binding.access&&JSON.stringify(state.write_paths)===JSON.stringify(binding.write_paths);
  const sameOriginal=state?.page_id===page.id&&state.thread_id===binding.thread_id&&sameScope&&
    state.request?.id===request.id&&state.request.phase===request.phase&&
    latest?.id===request.id&&latest.phase===request.phase&&latest.attempt_id===request.attempt_id&&latest.sent_user_hash===null&&
    attempt?.id===request.attempt_id&&attempt.acknowledged===null&&
    typeof state.pause_origin?.page_id==='string'&&!!state.pause_origin.page_id&&
    lifecycle?.version===1&&lifecycle.page_id===page.id&&lifecycle.thread_id===binding.thread_id&&
    lifecycle.request_id===request.id&&lifecycle.request_phase===request.phase&&lifecycle.attempt_id===request.attempt_id&&
    !pausedUnsentQuitWorkPending(page.id);
  const unsent=sameOriginal&&(request.phase==='suspended'&&attempt.state==='offered'&&attempt.dispatched===null&&
    lifecycle.required===true&&lifecycle.reason==='original_attempt_unsettled'||
    // The view omits claim_id. This canonical lifecycle reason positively
    // proves a null original claim and all earlier attempts explicitly not sent.
    emptyHome&&request.phase==='queued'&&(!Object.hasOwn(state.request,'claim_id')||state.request.claim_id===null)&&attempt.state==='not_sent'&&
    lifecycle.required===false&&lifecycle.reason==='original_attempt_not_sent');
  if(unsent){hostContext.original.canonicalCarrierRecords??=new Map();hostContext.original.canonicalCarrierRecords.set(page.id,{...binding,latest_request:latest,attempt});hostContext.original.unavailableCarriers??=new Set();hostContext.original.unavailableCarriers.add(page.id);
    hostContext.original.unavailableCarrierBindings??=new Map();hostContext.original.unavailableCarrierBindings.set(page.id,sameBinding);}
  return unsent;
}
async function quitPageObservations(pages,assertCurrent,hostContext=null){
  // These reads use the original Host's pending-call registry. Finish each
  // observation before the next page's current-owner check, so our own read
  // cannot look like another outstanding business operation.
  const observations=[];
  for(const original of pages){
    const {page,owner,view,contents,url,documentGeneration}=original;
    if(!contents){
      const binding=driver?.records.get(page.id),descriptor=workspace?.tasks?.get(page.id);
      if(page.hydration||page.hydratingView||page.rendererState!=='unloaded'||requiresRenderer(binding,{
        closed:!!(page.closed||page.hidden||workspace?.isClosed?.(page.id)),
        restoreUrl:restoreConversationUrl(binding,page,descriptor)
      }))throw Error('maintenance_original_page_unavailable');
      // The original unloaded descriptor has no WebContents and cannot be
      // generating. Active or unresolved turns required a renderer above.
      if(hostContext?.original.ordinaryExit&&owner===pool&&binding?.thread_id)hostContext.carriers.push(maintenanceExit.ordinaryCarrier(page,binding,{generating:false,rawStopPresent:false,draft:false,composing:false,approvalRequired:false}));
      continue;
    }
    if(!loaded(page))throw Error('maintenance_original_page_unavailable');
    const snapshot=await runDom(contents,'snapshot');assertCurrent();
    const currentOwner=owner.pages||owner.turnTabs;
    if(currentOwner.get(page.id)!==page||page.view!==view||contents.isDestroyed?.()||page.documentGeneration!==documentGeneration||contents.getURL()!==url||snapshot.url!==url)throw Error('maintenance_original_binding_unavailable');
    const binding=owner===pool?driver?.records.get(page.id):null;
    // Ordinary exit closes the current owned view; it grants no delivery or
    // execution authority. A historical chat address must not hold that view
    // open. The exact live owner, document and URL were checked above; Host
    // verifies the original task/request keys without settling them below.
    const ordinaryOwnedBinding=hostContext?.original.ordinaryExit&&
      (!binding||(!binding.page_id||binding.page_id===page.id)&&
        (page.account||'B')===(binding.account||'B'));
    const addressMatches=hostContext?.original.ordinaryExit?ordinaryOwnedBinding:!binding||binding.url===url;
    if(hostContext?.original.ordinaryExit&&binding?.thread_id){
      if(!ordinaryOwnedBinding)throw maintenanceExit.pageBlocked(page,snapshot,'original_browser_binding_changed');
      const carrier=maintenanceExit.ordinaryCarrier(page,binding,snapshot,{allowDeliveryWitness:binding.url===url});
      hostContext.carriers.push(carrier);
    }else if((!addressMatches||!(hostContext?.original.ordinaryExit?
      snapshot.generating===false&&snapshot.rawStopPresent===false&&snapshot.composing===false&&snapshot.approvalRequired===false&&!snapshot.error&&!snapshot.unknown&&snapshot.known!==false:
      knownIdleSnapshot(snapshot)))&&!await pausedUnsentQuitPage(original,snapshot,binding,assertCurrent,hostContext)){
      if(!addressMatches)throw Error('maintenance_original_binding_unavailable');
      throw maintenanceExit.pageBlocked(page,snapshot);
    }
    observations.push({page_id:page.id,title:page.title||page.id,observation:{...snapshot,at:Date.now()}});
  }
  assertCurrent();return observations;
}
async function pauseOrdinaryQuitFuture(){
  const original=driver;
  if(!original||!runtime?.ready)return;
  try{
    // Stop observation admission before reading the original ledger. A quit
    // must not make an unknown send appear acknowledged by scheduling a tick.
    await original.quiesceObservation({timeoutMs:10000});
    await original.pauseAll();await original.readRecords();
    if(driver!==original)throw Error('managed_task_response_stale');
  }catch(error){original.resumeObservation();throw error;}
}
async function readOrdinaryQuitActivity(){
  const active=[],blocked=[];
  // This is the same owned renderer observation used for sending. Historical
  // business Goals and independent Runner Jobs are deliberately absent.
  for(const original of ownedQuitPages()){
    if(!original.contents)continue;
    const {page,owner,contents,view,documentGeneration}=original;
    let snapshot;try{snapshot=await runDom(contents,'snapshot');}
    catch(error){blocked.push({code:'exit_browser_observation_unavailable',page_id:page.id,title:page.title||page.id});continue;}
    if((owner.pages||owner.turnTabs).get(page.id)!==page||page.view!==view||contents.isDestroyed?.()||page.documentGeneration!==documentGeneration){
      active.push({page_id:page.id,title:page.title||page.id,reason:'browser_navigation'});continue;
    }
    const reason=snapshot.generating||snapshot.rawStopPresent?'browser_generating':snapshot.composing?'browser_composing':snapshot.approvalRequired?'browser_confirmation':null;
    if(reason)active.push({page_id:page.id,title:page.title||page.id,reason});
    if(snapshot.draft&&owner===pool){
      // A native-page draft is data to preserve, not an active model turn.
      const composer=await runDom(contents,'connector-state');
      if(typeof composer?.text==='string'&&composer.text){workspace.update(page.id,{webDraft:{text:composer.text,url:snapshot.url,at:new Date().toISOString()}});workspace.save();}
    }
  }
  const operations=[...(submissions?.busy||[]),...(driver?.busy||[]),...(driver?.approvals?.busy||[])];
  for(const page_id of new Set(operations))if(!active.some(row=>row.page_id===page_id))active.push({page_id,title:pool.pages.get(page_id)?.title||page_id,reason:'exit_local_operation_pending'});
  // pendingStarts and prepared inputs are durable retained data. A quiet quit
  // saves them unchanged; only actual busy operations or a live page turn wait.
  return {active,blocked};
}
async function cancelExit(payload={}){
  if(payload.exit_id)exitLifecycle.assert(payload.exit_id);
  const result=ordinaryExit.cancel();notice='已取消退出等待；后续自动发送保持暂停。';publish({force:true});return {...result,exit:exitLifecycle.snapshot()};
}
async function requestQuit(payload={},controlContext=null){
  if(!controlContext&&appControl&&!maintenanceClosingContext){
    if(shellExitOperation){
      await shellExitOperation.pending.catch(()=>{});
      const receipt=await appControl.operation(shellExitOperation.envelope.operation_id);
      if(!receipt||['accepted','running','unknown'].includes(receipt.state))return {exiting:false,retained:true,operation:receipt||{operation_id:shellExitOperation.envelope.operation_id,state:'unknown'},exit:exitLifecycle.snapshot()};
      if(!['blocked','idle','cancelled'].includes(exitLifecycle.snapshot().state))return {exiting:false,retained:true,operation:receipt,exit:exitLifecycle.snapshot()};
    }
    const envelope={operation_id:'ui-quit-'+randomUUID(),action:'quit',payload:{maintenance:payload.maintenance===true},expected_identity:{app_instance_id:focusInstanceId,root:ROOT,runtime_generation:runtimeGeneration}};
    exitLifecycle.begin({maintenance:payload.maintenance===true,operation_id:envelope.operation_id});
    const pending=appControl.submit(envelope);shellExitOperation={envelope,pending};
    try{return {exiting:false,operation:await pending,exit:exitLifecycle.snapshot()};}
    catch(error){exitLifecycle.block(error);throw error;}
  }
  if(payload.exit_id)exitLifecycle.assert(payload.exit_id);
  if(maintenanceClosingContext){
    await maintenanceClosingContext.reconcile?.();return {exiting:exitLifecycle.snapshot().state==='completed',retained:true,exit:exitLifecycle.snapshot()};
  }
  if(exitLifecycle.pending)return exitLifecycle.pending;
  if(coldQuitContext)return {exiting:true,retained:true,exit:exitLifecycle.snapshot()};
  exitLifecycle.begin({maintenance:payload.maintenance===true,operation_id:controlContext?.operation_id||null});
  if(payload.maintenance!==true){const result=await ordinaryExit.begin();return {...result,exiting:result?.state==='closing',maintenance:false,waiting:result?.state==='waiting-current-turn',retained:true,exit:exitLifecycle.snapshot()};}
  return exitLifecycle.run(async()=>{try{const result=await prepareQuit(payload);return {...result,exit:exitLifecycle.snapshot()};}
    catch(error){if(!maintenanceClosingContext)exitLifecycle.block(error);throw Object.assign(error,{code:error.code||exitLifecycle.snapshot().blocked_reasons[0]?.code||'exit_check_failed',accepted:false});}});
}
async function reconcileExit(payload={},controlContext=null){
  exitLifecycle.assert(payload.exit_id);
  if(exitLifecycle.pending)await exitLifecycle.pending.catch(()=>{});
  if(maintenanceClosingContext){await maintenanceClosingContext.reconcile?.();return {exiting:exitLifecycle.snapshot().state==='completed',exit:exitLifecycle.snapshot()};}
  if(exitLifecycle.snapshot().mode==='ordinary'&&ordinaryExit.snapshot()){await ordinaryExit.reconcile();return {exiting:exitLifecycle.snapshot().state==='completed',exit:exitLifecycle.snapshot()};}
  if(exitLifecycle.snapshot().state==='blocked'){
    const maintenance=exitLifecycle.snapshot().mode==='maintenance';exitLifecycle.update('checking',{blocked_reasons:[]});
    return exitLifecycle.run(async()=>{try{const result=await prepareQuit({maintenance});return {...result,exit:exitLifecycle.snapshot()};}
      catch(error){if(!maintenanceClosingContext)exitLifecycle.block(error);throw Object.assign(error,{code:error.code||exitLifecycle.snapshot().blocked_reasons[0]?.code||'exit_check_failed',accepted:false});}});
  }
  return {exiting:false,exit:exitLifecycle.snapshot()};
}
async function prepareQuit(payload={}){
  const ordinary=payload.maintenance!==true;
  if(quitting||maintenanceChecking)throw Error('工作区正在核对原退出回执，请保留当前应用。');
  if(ordinary&&coldExitIdle()){
    const original={runtime,runtimeGeneration,nativeInitialization,workspace,pool,serial:++maintenanceSerial,pageRevision:coldPageRevision(),pages:ownedQuitPages()};
    original.assertCurrent=()=>{if(!coldExitIdle()||original.runtime!==runtime||original.runtimeGeneration!==runtimeGeneration||original.nativeInitialization!==nativeInitialization||original.workspace!==workspace||original.pool!==pool||original.serial!==maintenanceSerial||original.pageRevision!==coldPageRevision())throw Error('原启动或网页状态已变化，应用已保留。');};
    maintenanceChecking=true;
    try{original.releaseInputs=lockQuitPageInput(original.pages);await quitPageObservations(original.pages,original.assertCurrent);await quitPageObservations(original.pages,original.assertCurrent);
      coldQuitContext=original;app.quit();return {exiting:true,maintenance:false,stage:'owned_runtime_never_accepted',localTerminalStopped:false};
    }finally{if(!coldQuitContext){original.releaseInputs?.();maintenanceChecking=false;}}
  }
  const observationDriver=driver,observationIntent=Symbol('original-exit-observation');
  if(observationDriver?.maintenanceObservationIntent)throw Error('maintenance_observation_pending');
  if(observationDriver)observationDriver.maintenanceObservationIntent=observationIntent;
  let observationQuiesced=false,selectedObservationQuiesced=false;
  try{
  if(typeof selectedViewPoller!=='undefined'&&typeof selectedViewPoller.quiesce==='function'){
    selectedObservationQuiesced=true;const drained=await selectedViewPoller.quiesce({timeoutMs:10000});
    if(drained?.drained!==true)throw Object.assign(Error('exit_observation_pending'),{code:'exit_observation_pending'});
  }
  if(typeof observationDriver?.quiesceObservation==='function'){
    observationQuiesced=true;await observationDriver.quiesceObservation({timeoutMs:10000});
    if(driver!==observationDriver)throw Error('maintenance_original_execution_unresolved');
  }
  if(ordinary){
    if(!workspaceRestored||!runtime?.ready||!driver?.recordsLoaded)throw Error('当前连接或原任务仍待核对，工作区已保留。关闭窗口可转入后台；没有停止网页或本地终端。');
    const originalRuntime=runtime,generation=runtimeGeneration,store=runtime.store||runtime.info?.store_id;
    // Freeze future admission before taking a NEW ledger proof. Accepted turns,
    // collection and local terminal processes remain with their original owner.
    try{if(payload.future_paused!==true)await driver.pauseAll();await driver.reconcileAll();
      if(runtime!==originalRuntime||runtimeGeneration!==generation||(runtime.store||runtime.info?.store_id)!==store)throw Error('managed_task_response_stale');
    }catch(error){notice='后续暂停或原连接的回执仍待核对，工作区已保留。当前网页和独立本地终端继续保持原状态；没有关闭执行代理。';publish();throw Object.assign(Error(notice),{cause:error,code:error.code||error.message});}
  }
  try{
      {
        if(!workspaceRestored||!runtime?.ready||!driver?.recordsLoaded)throw Error('maintenance_exit_requires_original_receipt');
        const original={runtime,driver,pool,workspace,nativeBridge,nativeInitialization,child:runtime.child,generation:runtimeGeneration,serial:++maintenanceSerial,ordinaryExit:ordinary,exitId:exitLifecycle.snapshot().exit_id,
          store:runtime.store||runtime.info?.store_id,instance:runtime.info?.instance_id,
          revision:maintenanceExit.workspaceRevision(driver,pool,workspace),ledgerFingerprint:maintenanceExit.ledgerFingerprint(ROOT),
          pageBindings:maintenanceExit.pageBindings(driver,pool),driverStopped:driver.stopped};
        if(!(/^[a-f0-9]{32}$/).test(original.instance||''))throw Error('maintenance_original_host_instance_unavailable');
        const current=()=>{
          const pending=maintenanceExit.pendingQuitIds(driver,ordinary);
          const active=[...(driver?.busy||[]),...pending,...(ordinary?[]:driver?.bootstrapPrepared?.keys?.()||[]),...(driver?.approvals?.busy||[]),...(submissions?.busy||[]),...(ordinary?[]:Object.keys(workspace.pendingStarts||{}))];
          if(active.length)throw Object.assign(Error('maintenance_original_execution_unresolved'),{code:'exit_local_operation_pending',blockedReasons:[...new Set(active)].slice(0,32).map(page_id=>({code:'exit_local_operation_pending',page_id,title:pool.pages.get(page_id)?.title||page_id,thread_id:driver.records.get(page_id)?.thread_id||'',request_id:driver.records.get(page_id)?.latest_request?.id||'',attempt_id:driver.records.get(page_id)?.latest_request?.attempt_id||''}))});
          if(quitting||creating||original.serial!==maintenanceSerial||!workspaceRestored||runtime!==original.runtime||driver!==original.driver||pool!==original.pool||workspace!==original.workspace||nativeBridge!==original.nativeBridge||nativeInitialization!==original.nativeInitialization||runtime.child!==original.child||runtimeGeneration!==original.generation||!runtime.ready||!driver.recordsLoaded||
             (runtime.store||runtime.info?.store_id)!==original.store||runtime.info?.instance_id!==original.instance||maintenanceChecking&&driver.stopped!==true||driver.busy.size||maintenanceExit.pendingQuitIds(driver,ordinary).length||submissions?.busy.size||runtime.pending?.size||!ordinary&&Object.keys(workspace.pendingStarts||{}).length||[...(original.unavailableCarriers||[])].some(id=>pausedUnsentQuitWorkPending(id))||[...(original.unavailableCarrierBindings?.values()||[])].some(check=>!check())||maintenanceExit.workspaceRevision(driver,pool,workspace)!==original.revision)throw Error('maintenance_original_execution_unresolved');
        };
        const nativeDisabled=['disabled','not_started','cleaned'].includes(original.nativeInitialization.state)&&original.nativeInitialization.ownerStarted===false&&original.nativeBridge===null;
        if(!nativeDisabled&&(original.nativeInitialization.state!=='ready'||!original.nativeBridge))throw Error('maintenance_original_native_owner_unavailable');
        if(original.nativeBridge&&['prepareMaintenance','verifyMaintenance','finalVerifyMaintenance','resumeMaintenance','onMaintenanceExit'].some(name=>typeof original.nativeBridge[name]!=='function'))throw Error('maintenance_exit_requires_original_receipt');
        const nativeRevision=proof=>JSON.stringify({runtimePid:proof.runtimePid,ownerEpoch:proof.ownerEpoch,fenceId:proof.fenceId,admissionSha256:proof.admissionSha256,nativeTurns:proof.nativeTurns});
        let nativeProof,nativeBaseline,prepareAttempted=false,maintenanceFailure;
        current();maintenanceChecking=true;driver.stopped=true;
        try{
          if(original.nativeBridge){prepareAttempted=true;nativeProof=verifyNativeMaintenanceReceipt(await original.nativeBridge.prepareMaintenance());nativeBaseline=nativeRevision(nativeProof);current();}
          // The original private pipe reads its own loaded transport. A new
          // observer configured from today's disk is not the old Host identity.
          const pages=ownedQuitPages(),pageRevision=coldPageRevision();original.releaseInputs=lockQuitPageInput(pages);
          const pagesCurrent=()=>{current();if(coldPageRevision()!==pageRevision)throw Error('maintenance_original_page_changed');};
          let carriers=[];if(ordinary)await quitPageObservations(pages,pagesCurrent,{original,carriers});
          const hostPayload={store_id:original.store,ledger_fingerprint:original.ledgerFingerprint,page_bindings:original.pageBindings,...(ordinary?{exit_mode:'ordinary',paused_carriers:carriers}:{})};
          const freshProof=await maintenanceExit.readProof(ROOT,original,hostPayload);
          const proof=freshProof.proof;original.freshRead=freshProof.freshRead;
          current();
          await quitPageObservations(pages,pagesCurrent,{original,proof,carriers:[]});
          current();
          if(original.nativeBridge){nativeProof=verifyNativeMaintenanceReceipt(await original.nativeBridge.verifyMaintenance(nativeProof));
            if(nativeRevision(nativeProof)!==nativeBaseline)throw Error('maintenance_original_native_session_changed');current();}
          const observations=await quitPageObservations(pages,pagesCurrent,{original,proof,carriers:[]});
          // No async gap follows the final original Session and ledger reads.
          let turns=[];
          if(original.nativeBridge){const final=verifyNativeMaintenanceReceipt(original.nativeBridge.finalVerifyMaintenance(nativeProof));
            if(nativeRevision(final)!==nativeBaseline)throw Error('maintenance_original_native_session_changed');turns=final.nativeTurns;}
          maintenanceExit.assertProof(ROOT,proof,original);current();
          if(!shutdownPolicy.maintenanceIdle({pages:observations,nativeTurns:turns,ordinary}))throw Error('maintenance_exit_requires_idle');
          Object.assign(original,{hostProof:proof,nativeProof,nativeDisabled,ordinaryExit:ordinary,hostPayload,pages,pageRevision,hostPages:pages.filter(row=>row.owner===pool),hostPageRevision:hostQuitPageRevision()});maintenanceClosingContext=original;
          exitLifecycle.update('closing-native',{blocked_reasons:[]});
          maintenanceQuit=true;app.quit();return {exiting:true,maintenance:!ordinary,stage:'owner_shutdown_pending',nativeScope:nativeDisabled?'owned_native_not_started':'original_current_owner'};
        }catch(error){maintenanceFailure=error;throw error;}finally{
          // Release only this controller's retained original key. Unknown
          // release keeps its intent; a retry never adopts another fence.
          try{if(!maintenanceQuit&&!quitting&&prepareAttempted&&nativeBridge===original.nativeBridge&&runtimeGeneration===original.generation){
            try{await original.nativeBridge.resumeMaintenance();}catch(error){if(maintenanceFailure){const code=value=>/^(?:maintenance_|native_maintenance_)[a-z_]+$/.test(value||'')?value:'maintenance_check_failed';throw Object.assign(Error(code(maintenanceFailure.message)+'; '+code(error.message),{cause:maintenanceFailure}),{releaseError:error});}throw error;}
          }}finally{if(!maintenanceQuit&&!quitting)original.releaseInputs?.();if(!quitting&&driver===original.driver&&driver.stopped===true)driver.stopped=original.driverStopped;if(!quitting)maintenanceChecking=false;}
        }
      }

  }catch(error){
    if(ordinary){notice='退出暂未完成：'+(error.code||error.message)+'。后续自动推进已暂停，原任务已保留。';publish();throw error;}
    throw error;
  }
  }finally{
    if(observationDriver?.maintenanceObservationIntent===observationIntent)delete observationDriver.maintenanceObservationIntent;
    if(observationQuiesced&&driver===observationDriver&&!quitting&&!maintenanceClosingContext)observationDriver.resumeObservation();
    if(selectedObservationQuiesced&&!quitting&&!maintenanceClosingContext)selectedViewPoller.resume();
  }
}
async function closeTask(id,confirmed=false){
  const p=pageById(id),record=driver?.records.get(id),originalRuntime=runtime,generation=runtimeGeneration;let snapshot;
  try{if(loaded(p))snapshot=await runDom(p.view.webContents,'snapshot');}catch{}
  const active=snapshot?.generating||(record&&!record.paused);
  if(!confirmed&&(active||snapshot?.draft))return {confirmation:true,title:p.title,reason:active?'关闭会暂停后续派发。已开始的执行会保留，重新打开任务后可恢复。':'此页有未发送内容。页面会暂存在后台，可从「已关闭」重新打开；退出应用前请处理草稿。'};
  if(record){if(!runtime?.ready)throw Error('本机连接恢复后才能暂停并关闭此任务。');await runtime.call('pause',{page_id:id,paused:true,expected_request_id:activeRequestId(record)});}
  if(pool.pages.get(id)!==p||runtime!==originalRuntime||runtimeGeneration!==generation||record&&driver.records.get(id)?.thread_id!==record.thread_id)throw Error('原任务身份已变化，侧栏尚未移除；原执行保留。');
  p.hidden=true;
  workspace.update(id,{...pool.inspect().find(x=>x.id===id),closed:true,closedAt:Date.now()});
  if(pool.selected===id)chooseNext();
  // List removal is not a renderer stop. The observer releases only a verified
  // idle page after its original receipts and file confirmations have settled.
  if(!record&&knownIdleSnapshot(snapshot)&&!workspace.pendingStarts[id])pool.close(id);
  savePages();publish();return {closed:true,title:p.title};
}
async function reopen(id){
  const saved=workspace.tasks.get(id);if(!saved||!saved.closed)throw Error('此任务已打开或不存在。');
  if(!guard.ready)await guard.verify(session.fromPartition(partition));
  workspace.update(id,{closed:false});
  let p=pool.pages.get(id);
  if(p){p.closed=false;p.hidden=false;await pool.ensure(id);}else{
    try{p=await pool.create(id,saved.url,{...saved,closed:false});}
    catch(error){const failed=pool.pages.get(id);if(failed)failed.closed=true;workspace.update(id,{closed:true});workspace.save();throw error;}
  }
  pool.select(id);view=null;savePages();publish();return {id};
}
let creating=false;
async function newPage(payload,account=false,controlContext=null){
  if(creating)throw Error('正在打开网页，请稍候。');
  const accountId=payload.account||defaultWebAccount;partitionForAccount(accountId);
  if(account){
    const existing=[...workspace.tasks.values()].find(p=>(p.kind==='account'||/^账号 [AB]$/.test(p.title))&&(p.account||'B')===accountId);
    if(existing){if(existing.closed)return reopen(existing.id);if(pool.pages.has(existing.id)){await pool.ensure(existing.id);pool.select(existing.id);savePages();publish();return {id:existing.id};}}
  }
  creating=true;
  try{
    if(!guard.ready)await guard.verify(session.fromPartition(partition));
    const id='web-'+(controlContext?.execution_reference||randomUUID()),firstTurn=String(payload.first_turn_instructions||'').trim();
    if([...firstTurn].length>24000)throw Error('首次任务要求请控制在 24000 字符以内。');
    const title=account?'账号 '+accountId:String(payload.title||firstTurn.split(/\r?\n/)[0]||'新任务').trim().slice(0,120)||'新任务';
    const options=firstTurnOptions(payload.first_turn_options);
    const location=account||!String(payload.root||'').trim()&&!options.collaboration_enabled?{root:'',automaticWorkspace:false}:taskLocation({root:payload.root,id,home:app.getPath('documents')});
    const metadata={title,...location,account:accountId,kind:account?'account':'task',
      ...(!account?{conversation_mode:options.conversation_mode,collaboration_enabled:options.collaboration_enabled}:{}),
      ...(controlContext?{app_control_operation_id:controlContext.operation_id,app_control_execution_reference:controlContext.execution_reference}:{})};
    workspace.update(id,{...metadata,firstTurnDraft:firstTurn,...(!account?{firstTurnOptions:options}:{}),url:'https://chatgpt.com/',closed:false});workspace.save();
    try{await pool.create(id,'https://chatgpt.com/',metadata);}
    finally{if(pool.pages.has(id)){pool.select(id);savePages();publish();}}
    return {id,...(controlContext?{execution_reference:controlContext.execution_reference,model_sends:0}:{})};
  }finally{creating=false;}
}
function sendIntent(action,id){win.webContents.send('clw-intent',{action,id});}
async function refreshPage(id){
  if(driver?.pageAdapterReloading)throw appControlIdentity.rejected('app_page_adapter_busy');
  const p=pageById(id);
  await pool.ensure(p.id);
  if(!guard.ready)await guard.verify(p.view.webContents.session);
  if(!driver)throw Error('本机服务正在连接，请稍后刷新。');
  const result=await driver.refresh(p);notice=result.message;publish();return result;
}
app.on('web-contents-created',(_event,wc)=>guard.protectContents(wc));
const primary=app.requestSingleInstanceLock();
if(!primary)app.quit();
else bridgeSetup.then(async configuredBridge=>{await app.whenReady();
  workspace=new WorkspaceState(profile,allowedUrl);
  await guard.protect(session.defaultSession);await guard.protect(session.fromPartition(partition));
  const restoreMode=isolatedCheck?'background':process.argv.includes('--clw-recovered')?workspace.windowMode:'visible';
  const icon=nativeImage.createFromPath(path.join(__dirname,'assets/clw.png'));
  win=new BrowserWindow({show:false,width:1440,height:960,minWidth:360,minHeight:480,title:'CLW · Web 工作区',icon,backgroundColor:'#191919',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.setMenu(null);
  pool=new BrowserPool({window:win,WebContentsView,partition,partitionForAccount,powerSaveBlocker,allowedUrl,networkGuard:guard,accountAccessFor,openExternal:url=>shell.openExternal(url)});
  pool.on('manual-interaction',({id})=>{
    // The first takeover is durable; keystrokes only update the in-memory
    // sequence. Flushing every key would block typing on large workspaces.
    if(workspace.tasks.get(id)?.manualControl!==true)try{savePages();}
    catch{notice='手动操作已优先，浏览位置尚未保存。';}
    publish();
  });
  pool.on('manual-control-changed',()=>{try{savePages();}catch{notice='操作状态尚未保存，请稍后重试。';}publish();});
  pool.on('external-open-failed',()=>{notice='链接未能打开，请复制链接后在浏览器打开。';publish();});
  for(const saved of workspace.tasks.values())if(!saved.closed)pool.register(saved.id,saved.url,saved);
  if(workspace.selected&&pool.pages.has(workspace.selected))pool.select(workspace.selected);
  nativePreviewPool=new BrowserPool({window:win,WebContentsView,partition,partitionForAccount,powerSaveBlocker,allowedUrl,networkGuard:guard,accountAccessFor,openExternal:url=>shell.openExternal(url)});
  nativeConversations=require('./native-conversations.cjs').createNativeConversations({getBridge:()=>nativeBridge,pool:nativePreviewPool});
  nativePreviewPool.on('changed',publish);
  nativePreviewPool.on('load-failed',()=>{notice='原对话暂未加载完成，请检查 VPN 后刷新；没有重发任务。';publish();});
  nativePreviewPool.on('refresh-requested',()=>{void nativeConversations.refresh().then(publish).catch(e=>{notice=e.message;publish();});});
  win.on('resize',()=>{pool.layout();nativeConversations.layout();});win.on('close',event=>{if(!quitting){event.preventDefault();savePages();win.hide();}});
  const rememberMode=mode=>{if(!quitting){workspace.windowMode=mode;workspace.save();}};
  win.on('hide',()=>rememberMode('background'));win.on('minimize',()=>rememberMode('minimized'));
  win.on('restore',()=>rememberMode('visible'));win.on('show',()=>rememberMode(win.isMinimized()?'minimized':'visible'));
  app.on('second-instance',(_event,argv,_cwd,data)=>{if(focusStartup.shouldFocusExisting(argv,data,focusInstanceId)){win.show();win.focus();}});
  tray=new Tray(icon.resize({width:20,height:20}));tray.setToolTip('CLW Web 工作区');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'打开工作区',click:()=>win.show()},{label:'暂停后续自动推进',click:()=>{void driver?.pauseAll().catch(error=>{notice=error.message;publish();});}},{type:'separator'},{label:'退出并保留现场',click:()=>{void requestQuit().catch(error=>{notice=error.message;publish();win.show();});}}]));
  tray.on('double-click',()=>win.show());
  pool.on('refresh-requested',({id})=>{void refreshPage(id).catch(e=>{notice=e.message;publish();});});
  win.webContents.on('before-input-event',(event,input)=>{
    if(input.type==='keyDown'&&(input.key==='F5'||((input.control||input.meta)&&input.key.toLowerCase()==='r'))){event.preventDefault();if(nativeConversations.snapshot()?.visible)void nativeConversations.refresh().catch(e=>{notice=e.message;publish();});else if(pool.selected)void refreshPage(pool.selected).catch(e=>{notice=e.message;publish();});}
  });
  pool.on('changed',()=>{
    if(lastSelectedPage!==pool.selected){lastSelectedPage=pool.selected;selectedReadGeneration++;selectedViewPoller.invalidate();view=null;}
    publish();
  });pool.on('navigation',()=>{try{savePages();}catch{}publish();});pool.on('crashed',x=>{if(driver)void driver.reconcile(x.id).catch(e=>{notice=e.message;publish();});});
  pool.on('load-failed',()=>{notice='网页加载失败，原任务已保留。请检查 VPN 后重试该网页。';publish();});
  powerMonitor.on('suspend',()=>{driver?.stop();savePages();});
  powerMonitor.on('resume',()=>{if(driver){driver.stopped=false;driver.restore().catch(e=>{notice=e.message;publish();});}});
  const checkActions=['show','background','theme','status','inspect-ui','capture-shell','reload-shell','reload-page-adapter','ui-view','quit','exit-status','reconcile-exit','cancel-exit','window-size','mcp-call-details'];
  const dispatchCommand=async(action,payload={},controlContext=null)=>{
    if(isolatedCheck&&!checkActions.includes(action)&&action!=='layout')throw appControlIdentity.rejected('isolated_app_check_business_action_forbidden');
    if(maintenanceChecking&&!['quit','exit-status','reconcile-exit','cancel-exit','status'].includes(action))throw Error('正在核对原执行，请待本次维护检查结束。');
    if(typeof ordinaryExit!=='undefined'&&ordinaryExit.snapshot()&&['new','start','start-first-turn','resume','goal-next','goal-continue','budget-continue','enroll','codex-start','codex-resume-turn'].includes(action))throw appControlIdentity.rejected('exit_future_sends_paused');
    if(driver?.pageAdapterReloading&&['new','login','select','refresh','close','reopen','delete-task','layout',
      'start','reconcile-submission','resume','start-first-turn','inspect','adopt-model','set-model','retire-partial','enroll',
      'configure-intake','task-observation','reconcile-send-preparation','reset-bootstrap-query','codex-refresh-web','codex-view-turn'].includes(action))
      throw appControlIdentity.rejected('app_page_adapter_busy');
    if(recordCommands.actions.has(action)){
      const read=request=>recordCommands.readRecords(action,request,{runtime,nativeBridge,resolvePage:id=>({...pageById(id),kind:workspace.tasks.get(id)?.kind})});
      return action==='record-body'&&controlContext?require('./control-record-body.cjs').readControlBody(payload,read):read(payload);
    }
    if(action==='task-status'){
      const page=pageById(payload.id);
      if(!runtime?.ready)throw appControlIdentity.rejected('runtime_not_connected');
      const state=await runtime.call('view',{page_id:page.id,record_summaries:true});
      return Object.fromEntries(['page_id','thread_id','request','latest_request','attempt','send_stats','pending_notes','next_round','budget_status','run','goal','maintenance','access','write_paths','duration_seconds','max_dispatches']
        .filter(key=>Object.hasOwn(state,key)).map(key=>[key,state[key]]));
    }
    if(action==='mcp-call-details'){
      if(!['task','connection'].includes(payload.scope)||Object.keys(payload).some(key=>!['id','scope','callId','part','offset','max_bytes','format'].includes(key))||
        payload.max_bytes!=null&&(!Number.isInteger(payload.max_bytes)||payload.max_bytes<1||payload.max_bytes>65536))throw Error('mcp_call_details_query_invalid');
      const bridgeHome=path.join(ROOT,'.local','codex-web-bridge'),generation=runtimeGeneration;
      const source=JSON.parse(await fs.promises.readFile(path.join(bridgeHome,'union-config.json'),'utf8'));
      const identity=payload.scope==='task'?captureTaskIdentity({payload,resolvePage:pageById,recordFor:id=>driver?.records.get(id),connectionGeneration:()=>runtimeGeneration}):null;
      const readActivity=identity?()=>identity.run(()=>runtime.call('session-activity',{page_id:payload.id})):
        require('../codex-web-bridge/mcp-activity.cjs').createActivityProjection(bridgeHome);
      const read=require('../codex-web-bridge/mcp-activity-details.cjs').createCallDetailsReader({resultHome:path.join(bridgeHome,'result-cache'),authorizationFile:source.authorizationFile,readActivity});
      const result=await read(Object.fromEntries(['callId','part','offset','max_bytes','format'].filter(key=>Object.hasOwn(payload,key)).map(key=>[key,payload[key]])));
      if(identity)identity.assertCurrent({response:true});else if(runtimeGeneration!==generation)throw Error('mcp_call_details_response_stale');
      return result;
    }
    if(action==='copy-record-text'){
      if(typeof payload.text!=='string'||payload.text.length>8*1024*1024)throw Error('record_copy_text_invalid');
      clipboard.writeText(payload.text);return {copied:true};
    }
    if(action==='status'){publish({force:true});return {};}
    if(action==='dismiss-notice'){notice='';publish();return {};}
    if(action.startsWith('preview-')){
      if(!previewMode)throw Error('preview_installation_unavailable');
      if(action==='preview-pick-root'){
        const picked=await dialog.showOpenDialog(win,{title:'选择允许本地工具使用的工作目录',properties:['openDirectory']});
        return {path:picked.canceled?null:picked.filePaths[0]};
      }
      if(action==='preview-open-platform'){await shell.openExternal('https://platform.openai.com/settings/organization/tunnels');return {opened:true};}
      if(action==='preview-document'){
        const files={terms:'FREE_PREVIEW_TERMS.md',privacy:'PRIVACY.md',start:'README.md'};
        if(!Object.hasOwn(files,payload.kind))throw Error('preview_document_invalid');
        const name=payload.kind==='start'?files.start:path.join('docs',files[payload.kind]);
        const result=await shell.openPath(path.join(ROOT,name));if(result)throw Error('preview_document_unavailable');return {opened:true};
      }
      const operation=action.slice(8);
      if(operation==='save'){
        if(controlContext)throw Error('preview_credentials_use_local_settings');
        const previous=guard.options,next=payload.manifest?.network;
        const networkChanged=next&&JSON.stringify({mode:previous.mode,proxy_url:previous.proxyUrl||''})!==JSON.stringify({mode:next.mode,proxy_url:next.proxy_url||''});
        const result=await previewSetup.call('save',payload);
        // One running application keeps one network snapshot. Changing saved
        // settings never partially reconfigures existing pages or tool owners.
        let currentStatus=result.status;if(networkChanged){try{currentStatus=await previewSetup.call('check');}catch{}}
        return {...result,status:currentStatus,restart_required:!!networkChanged,
          backend_settings_pending:networkChanged&&currentStatus?.pendingChanges?.includes('network_applies_after_owned_process_restart')};
      }
      let result=await previewSetup.call(operation,payload);
      if(operation==='read')result={...result,application_version:app.getVersion()};
      if(operation==='export'){
        let build=null;try{const frozen=JSON.parse(fs.readFileSync(path.join(ROOT,'_clw_web_release.json'),'utf8'));build={build_id:frozen.build_id,source_commit:frozen.source_commit,payload_sha256:frozen.payload_sha256};}catch{}
        result={...result,application:{version:app.getVersion(),electron:process.versions.electron,platform:process.platform,arch:process.arch,build}};
      }
      if(operation==='export'&&!controlContext){
        const selected=await dialog.showSaveDialog(win,{title:'导出诊断',defaultPath:'CLW-diagnostics.json',filters:[{name:'诊断记录',extensions:['json']}]});
        if(selected.canceled)return {cancelled:true};
        fs.writeFileSync(selected.filePath,JSON.stringify(result,null,2)+'\n',{encoding:'utf8',mode:0o600});return {saved:true,path:selected.filePath};
      }
      return result;
    }
    if(action==='connection-read')return connectionSettings.readConnection(ROOT);
    if(action==='connection-pick-file'){
      if(!['key','binary'].includes(payload.kind))throw Error('connection_request_invalid');
      const result=await dialog.showOpenDialog(win,{title:payload.kind==='key'?'选择已有运行密钥文件':'选择已有隧道客户端',properties:['openFile']});
      return {path:result.canceled?null:result.filePaths[0]};
    }
    if(action==='connection-save'){
      try{
      // No service restart follows this write. Original task receipts remain
      // authoritative, and the new selection applies on a normal future open.
      const generation=runtimeGeneration,originalBridge=nativeBridge,currentConnection=connectionSettings.readConnection(ROOT);
      const nextAccountOnly=currentConnection.sharedExisting&&payload.transport==='shared-mcp'&&payload.enabled===currentConnection.enabled&&
        ['A','B'].includes(payload.webAccount)&&payload.webAccount!==currentConnection.webAccount&&
        (payload.appName===undefined||payload.appName===currentConnection.appName)&&
        ['tunnelId','runtimeKeyFile','binaryPath'].every(key=>payload.tunnel?.[key]===currentConnection.tunnel[key]);
      if(nextAccountOnly){
        // This only stores the browser account for the next normal open. The
        // current bridge and its admission/Jobs remain with their exact owner;
        // ordinary exit independently verifies live work before a reopen.
        const assertCurrent=()=>{if(!workspaceRestored||generation!==runtimeGeneration||nativeBridge!==originalBridge||creating||quitting)throw Error('connection_original_execution_unresolved');};
        const result=connectionSettings.saveConnection(ROOT,payload,{assertIdle:assertCurrent});
        const activeAccount=originalBridge?.snapshot?.().account||null;
        notice='下次启动账号已保存为 '+payload.webAccount+'；当前连接与任务继续使用原账号。正常退出并重开后生效，没有启动服务或发送模型消息。';publish();
        return {...result,selectionApplies:'next_startup',nextStartupAccount:payload.webAccount,activeAccount};
      }
      let records=[];
      if(driver?.records.size){
        if(!runtime?.ready||!driver.recordsLoaded)throw Error('connection_original_execution_unresolved');
        const fresh=await runtime.call('list');if(!Array.isArray(fresh.pages))throw Error('connection_original_execution_unresolved');records=fresh.pages;
      }
      if(nativeBridge)nativeMaintenanceTurns(nativeBridge);else connectionSettings.readSettledTurns(ROOT);
      const originalStore=runtime?.store||runtime?.info?.store_id;
      const ledger=await connectionExecution.readExecution(ROOT,{expectedStore:originalStore,python:runtime?.python});
      const savedTasks=[...workspace.tasks.values()].some(task=>task.kind!=='account');
      const assertIdle=()=>{
        if(nativeBridge!==originalBridge)throw Error('connection_original_execution_unresolved');
        const turns=nativeBridge?nativeMaintenanceTurns(nativeBridge):connectionSettings.readSettledTurns(ROOT);
        connectionExecution.assertCurrent(ROOT,ledger);
        if((runtime?.store||runtime?.info?.store_id)!==originalStore)throw Error('connection_execution_store_changed');
        connectionSettings.assertConnectionIdle({restored:workspaceRestored&&generation===runtimeGeneration&&(!savedTasks||!!runtime?.ready&&!!driver?.recordsLoaded),
        records:[...records,...(driver?.records.values()||[])],busy:creating||quitting||!!driver?.busy.size||!!driver?.pending.size||!!submissions?.busy.size,
        pendingStarts:Object.keys(workspace?.pendingStarts||{}),nativeTurns:turns,nativeVerified:true});};
      const result=connectionSettings.saveConnection(ROOT,payload,{assertIdle});
      notice='连接设置已保存；在正常退出并重新打开工作区后初始化。此次没有启动服务或发送模型消息。';publish();return result;
      }catch(error){
        // These guards run before the settings write. Preserve their exact
        // reason as a rejected save instead of an unknown delivered operation.
        if(/^(maintenance_exit_requires_original_receipt|connection_original_execution_unresolved|connection_execution_[a-z_]+|connection_settings_changed|connection_settings_busy)$/.test(error?.message||''))
          throw Object.assign(error,{code:error.message,accepted:false});
        throw error;
      }
    }
    if(action==='background'){savePages();win.hide();publish();return {background:true};}
    if(action==='window-size'){
      if(Object.keys(payload).some(key=>!['width','height'].includes(key))||
        !Number.isSafeInteger(payload.width)||payload.width<360||payload.width>3840||
        !Number.isSafeInteger(payload.height)||payload.height<480||payload.height>2160)
        throw appControlIdentity.rejected('app_window_size_invalid');
      win.setContentSize(payload.width,payload.height);publish();return {content_size:win.getContentSize(),model_sends:0};
    }
    if(action==='quit')return requestQuit(payload,controlContext);
    if(action==='exit-status')return exitLifecycle.snapshot();
    if(action==='reconcile-exit')return reconcileExit(payload,controlContext);
    if(action==='cancel-exit')return cancelExit(payload);
    if(action==='codex-verify'){
      if(!nativeBridge)throw Error('Codex Web 接入尚未启动。');
      return nativeBridge.verify();
    }
    if(action==='quota-report'){
      const q=quotas.get(payload.account);if(!q)throw Error('quota_account_invalid');
      const result=q.report(payload.model,{exhausted:payload.exhausted,resetText:payload.resetText||''});publish();return result;
    }
    if(action==='quota-history'||action==='quota-verify'){
      if(!quotas.has(payload.account))throw Error('quota_account_invalid');
      const fields=action==='quota-history'?['account','since']:['account'];
      if(Object.keys(payload).some(k=>!fields.includes(k)))throw Error('quota_history_payload_invalid');
      if(payload.since!==undefined&&(!Number.isFinite(payload.since)||payload.since>Date.now()||payload.since<Date.now()-90*86400000))throw Error('quota_history_payload_invalid');
      return {account:payload.account,state:'history_read_disabled',policy:'cache_only',model_sends:0,remote_requests:0};
    }
    if(action==='quota-check'){
      if(!quotas.has(payload.account))throw Error('quota_account_invalid');
      return {account:payload.account,state:'model_status_read_disabled',policy:'cache_only',model_sends:0,remote_requests:0};
    }
    if(action==='codex-start')return require('../codex-web-bridge/launch-codex.cjs').launchCodex(ROOT,payload,nativeBridge);
    if(action==='native-codex-start'){const result=await localCodex.launch(payload);publish();return result;}
    if(action==='codex-view-turn'){const result=await nativeConversations.open(payload.traceId);publish();return result;}
    if(action==='codex-refresh-web'){const result=await nativeConversations.refresh();publish();return result;}
    if(action==='codex-resume-turn'){
      const launcher=require('../codex-web-bridge/launch-codex.cjs');
      return launcher.launchCodex(ROOT,launcher.resumeTurnPayload(nativeBridge,payload.traceId),nativeBridge);
    }
    if(action==='layout'){
      pool.native=payload.native===true&&payload.codexNative!==true;pool.details=payload.details===true;
      if(pool.native&&pool.selected)await pool.ensure(pool.selected);
      const b=payload.bounds;
      if(b&&['x','y','width','height'].every(k=>Number.isFinite(b[k]))&&b.width>0&&b.height>0){
        const [w,h]=win.getContentSize(),x=Math.max(0,Math.min(w-1,Math.round(b.x))),y=Math.max(0,Math.min(h-1,Math.round(b.y)));
        if(w>0&&h>0)pool.viewport={x,y,width:Math.min(w-x,Math.round(b.width)),height:Math.min(h-y,Math.round(b.height))};
      }
      pool.layout();nativeConversations.layout({visible:payload.codexNative===true,bounds:pool.viewport});return {};
    }
    if(action==='theme'){
      if(Object.hasOwn(payload,'theme'))workspace.theme=payload.theme==='light'?'light':'dark';
      if(Object.hasOwn(payload,'accent')){if(!['purple','blue','amber','rose','green'].includes(payload.accent))throw appControlIdentity.rejected('app_accent_invalid');workspace.accent=payload.accent;}
      workspace.save();publish();return {theme:workspace.theme,accent:workspace.accent};
    }
    if(action==='pick-root'){const r=await dialog.showOpenDialog(win,{title:'选择项目目录',defaultPath:payload.root||ROOT,properties:['openDirectory']});return {root:r.canceled?null:r.filePaths[0]};}
    if(action==='new'||action==='login')return newPage(payload,action==='login',controlContext);
    if(action==='accounts'){Menu.buildFromTemplate(['B','A'].map(account=>({label:'账号 '+account+' · 登录与连接',click:()=>sendIntent('login',account)}))).popup({window:win});return {};}
    if(action==='select'){
      const page=pageById(payload.id),originalPool=pool;
      pool.select(page.id);view=null;savePages();publish();
      const generation=selectedReadGeneration,current=()=>!quitting&&pool===originalPool&&pool.pages.get(page.id)===page&&pool.selected===page.id&&selectedReadGeneration===generation;
      const hydration=pool.ensure(page.id);
      if(pool.native||page.kind==='account'){
        await hydration;if(current())publish();return {selected:page.id,rendererPending:false};
      }
      void hydration.then(()=>{if(current())publish();}).catch(error=>{if(current()){notice=error.message;publish();}});
      return {selected:page.id,rendererPending:!loaded(page)};
    }
    if(action==='refresh')return refreshPage(payload.id);
    if(action==='close')return closeTask(payload.id,payload.confirmed===true);
    if(action==='reopen')return reopen(payload.id);
    if(action==='delete-task'){
      const result=await removeClosedTask({id:payload.id,workspace,pool,driver,runtime,snapshot:async contents=>{const state=await runDom(contents,'snapshot');if(!knownIdleSnapshot(state))throw Error('原网页状态仍待核对，未删除本机记录。');return state;}});
      publish();return result;
    }
    if(action==='rename'){
      const p=pageById(payload.id),title=String(payload.title||'').trim();
      if(!title||title.length>120)throw Error('任务名称需为 1–120 个字符。');
      p.title=title;workspace.update(p.id,{title});savePages();publish();return {};
    }
    if(action==='task-menu'){
      const p=pageById(payload.id);
      Menu.buildFromTemplate([{label:'重命名',click:()=>sendIntent('rename',p.id)},{label:'任务设置',click:()=>sendIntent('settings',p.id)},{type:'separator'},{label:'移出列表并保留现场',click:()=>sendIntent('close',p.id)}]).popup({window:win});return {};
    }
    if(action==='project-menu'){
      Menu.buildFromTemplate([{label:'新建任务',click:()=>sendIntent('new-in-project',payload.root)},{type:'separator'},{label:'从侧栏移除此项目',click:()=>sendIntent('close-project',payload.root)}]).popup({window:win});return {};
    }
    if(action==='panel'){const origin=runtime?.info?.origin;if(previewMode&&!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin||''))throw Error('runtime_listener_unavailable');await shell.openExternal((previewMode?origin:'http://127.0.0.1:18944')+'/harness.html');return {};}
    if(!driver)throw Error('本机运行时尚未连接。');
    const identityActions=['start-first-turn','inspect','adopt-model','set-model','retire-partial','enroll','configure-intake','pause','resume','stop-generation','goal-read','goal-save','goal-review','goal-discard','goal-stop','goal-continue','refill-budget','budget-continue','pick-context','reconcile-submission','task-observation','reconcile-send-preparation','reset-bootstrap-query'];
    const documentActions=['start-first-turn','inspect','adopt-model','set-model','retire-partial','enroll','configure-intake','stop-generation','task-observation','reconcile-send-preparation','reset-bootstrap-query'];
    const taskIdentity=identityActions.includes(action)?captureTaskIdentity({payload,resolvePage:pageById,
      recordFor:id=>driver.records.get(id),connectionGeneration:()=>runtimeGeneration,documentAware:documentActions.includes(action)}):null;
    if(documentActions.includes(action)){
      if(['task-observation','reconcile-send-preparation','reset-bootstrap-query'].includes(action)){
        if(!loaded(taskIdentity.page))throw Error('task_observation_original_page_unavailable');
      }else await pool.ensure(taskIdentity.page.id);
      taskIdentity.pinDocument();
    }
    if(action==='task-observation')return taskIdentity.run((page,assertCurrent)=>driver.observeTask(page,assertCurrent));
    if(action==='reset-bootstrap-query'){
      if(!controlContext?.execution_reference)throw Error('bootstrap_query_control_operation_required');
      const result=await taskIdentity.run((page,assertCurrent)=>require('./bootstrap-query-reset.cjs').resetBootstrapQuery({
        driver,page,payload,operationId:controlContext.execution_reference,assertCurrent,
        resetStore:{get:()=>workspace.tasks.get(page.id)?.bootstrapQueryReset,
          persist:value=>{assertCurrent();workspace.update(page.id,{bootstrapQueryReset:value});workspace.save();}}}));
      publish();return result;
    }
    if(action==='reconcile-send-preparation'){
      if(!controlContext?.execution_reference)throw Error('send_preparation_control_operation_required');
      const result=await taskIdentity.run((page,assertCurrent)=>require('./send-preparation-recovery.cjs').reconcileSendPreparation({
        driver,page,payload,operationId:controlContext.execution_reference,assertCurrent}));
      publish();return result;
    }
    if(action==='pick-context'){
      const originalDriver=driver,originalRuntime=runtime;
      return contextPicker.pickContext({payload,identity:taskIdentity,recordFor:id=>driver?.records.get(id),
        assertAvailable:()=>{
          if(quitting||maintenanceChecking||!workspaceRestored||runtime!==originalRuntime||driver!==originalDriver||
            !runtime?.ready||!driver?.recordsLoaded||pool.selected!==taskIdentity.page.id)
            throw Error('managed_context_task_unavailable');
        },showOpenDialog:options=>dialog.showOpenDialog(win,options)});
    }
    if(action==='reconcile-submission'){
      if(Object.keys(payload).some(key=>!['id','objective','expected_connection_generation','expected_request_id'].includes(key))||
        typeof payload.objective!=='string'||!Object.hasOwn(payload,'expected_connection_generation')||
        !Number.isSafeInteger(payload.expected_connection_generation)||payload.expected_connection_generation<0||
        !Object.hasOwn(payload,'expected_request_id')||!(payload.expected_request_id===null||
          typeof payload.expected_request_id==='string'&&payload.expected_request_id.length>0))
        throw Error('managed_submission_reconcile_invalid');
      const originalDriver=driver,originalRuntime=runtime,originalSubmissions=submissions;
      const assertCurrent=options=>{
        if(quitting||maintenanceChecking||!workspaceRestored||runtime!==originalRuntime||driver!==originalDriver||submissions!==originalSubmissions||
          !runtime?.ready||!driver?.recordsLoaded)throw Error('managed_submission_task_unavailable');
        taskIdentity.assertCurrent(options);
        const row=driver.records.get(taskIdentity.page.id);
        if(taskIdentity.page.kind!=='task'||taskIdentity.page.hidden||row?.page_id!==taskIdentity.page.id||row.phase!=='bound'||!row.thread_id)
          throw Error('managed_submission_task_unavailable');
      };
      const result=await submissions.reconcile(taskIdentity.page.id,payload.objective,assertCurrent);
      assertCurrent({response:true,acceptedRequestId:['queued_for_web_host','note_saved_not_native_interrupt'].includes(result?.state)?result.request_id:null});
      publish();return result;
    }
    if(action==='prompt-preview'){
      if(payload.draft===true){
        partitionForAccount(payload.account);
        return runtime.call('prompt-preview',{page_id:'new-task-preview',root:payload.root?path.resolve(String(payload.root)):'',account:payload.account,instructions:String(payload.instructions||''),conversation_mode:payload.collaboration_enabled===true?'managed':'direct'});
      }
      const page=pageById(payload.id),saved=workspace.tasks.get(page.id);
      const instructions=payload.stored===true?String(driver.records.get(page.id)?.first_turn_instructions||saved.firstTurnDraft||''):
        String(payload.instructions||'');
      const registered=driver.records.get(page.id);
      return runtime.call('prompt-preview',{page_id:page.id,root:saved.root,account:page.account||'B',instructions,
        conversation_mode:registered?.conversation_mode||saved.conversation_mode||(registered?'managed':payload.collaboration_enabled===true?'managed':'direct')});
    }
    if(action==='start-first-turn'){
      const page=taskIdentity.page,saved=workspace.tasks.get(page.id);
      const instructions=String(payload.instructions||'').trim();
      if([...instructions].length>24000)throw Error('首次任务要求最多 24000 字符。');
      const options=firstTurnOptions({...payload,conversation_mode:payload.direct===true||!payload.collaboration_enabled?'direct':'managed'});
      const location=options.collaboration_enabled&&!saved.root?taskLocation({root:'',id:page.id,home:app.getPath('documents')}):{root:saved.root};
      workspace.update(page.id,{...location,firstTurnDraft:instructions,firstTurnOptions:options});workspace.save();
      let result=await taskIdentity.run((_page,assertCurrent)=>driver.startFirstTurn(page,{root:location.root,title:saved.title,instructions,...options,waitForReady:payload.wait_for_ready===true,assertCurrent}),{allowRecordAdvance:true});
      if(result?.state==='direct_ready'&&instructions){
        result=await submissions.start(page.id,instructions,null,controlContext?{operation_id:controlContext.execution_reference}:undefined);
        await driver.reconcileAll({background:true});
        workspace.update(page.id,{firstTurnDraft:'',conversation_mode:'direct'});workspace.save();
      }
      publish();return result;
    }
    if(action==='inspect')return taskIdentity.run((page,assertCurrent)=>driver.inspect(page,assertCurrent));
    if(action==='adopt-model'){const result=await taskIdentity.run((page,assertCurrent)=>driver.adoptModel(page,payload,assertCurrent));publish();return result;}
    if(action==='set-model'){const result=await taskIdentity.run((page,assertCurrent)=>driver.setWorkModel(page,payload,assertCurrent));publish();return result;}
    if(action==='withdraw'){const {id,...request}=payload;const result=await driver.withdraw(pageById(id),request);publish();return result;}
    if(action==='retire-partial'){const {id,...request}=payload;const result=await taskIdentity.run(page=>driver.retirePartial(page,request));publish();return result;}
    if(action==='enroll')return taskIdentity.run((page,assertCurrent)=>driver.enroll(page,payload,assertCurrent),{allowRecordAdvance:true});
    if(action==='configure-intake'){const {id,expected_connection_generation,...request}=payload;return taskIdentity.run((page,assertCurrent)=>driver.configureIntake(page,request,assertCurrent));}
    if(action==='configure-write-scope'){
      const {id,...request}=payload,page=pageById(id);
      const result=await runtime.call('configure-write-scope',{...request,page_id:page.id});
      page.root=result.root;workspace.update(page.id,{root:result.root});workspace.save();
      await driver.reconcileAll();publish();return result;
    }
    if(['goal-read','goal-save','goal-review','goal-discard','goal-stop'].includes(action)){
      const result=await taskIdentity.run((page,assertCurrent)=>driver.goalOperation(page,action,payload,assertCurrent));
      if(action==='goal-discard'){
        if(result.state!=='goal_next_discarded'||result.original_operation_id!==payload.expected_pending_id)
          throw Error('managed_goal_response_invalid');
        if(workspace.pendingStarts[taskIdentity.page.id]?.operation_id===result.original_operation_id)
          submissions.persistIntent(taskIdentity.page.id,null);
      }
      publish();return result;
    }
    if(action==='goal-continue'){
      try{
        const result=await driver.continueGoal(taskIdentity.page,payload,{workspace,submissions,assertCurrent:taskIdentity.assertCurrent});
        publish();return result;
      }catch(error){
        if(error.submissionReceipt?.state!=='rejected')throw error;
        taskIdentity.assertCurrent({response:true});publish();return error.submissionReceipt;
      }
    }
    if(action==='refill-budget'){
      const {id,expected_connection_generation,...request}=payload;
      try{const result=await taskIdentity.run(async(page,assertCurrent)=>{
        const result=await runtime.call('refill-budget',{...request,page_id:page.id});assertCurrent({response:true});
        await driver.reconcileAll();return result;
      });publish();return result;}
      catch(error){if(['runtime_receipt_unknown_reconcile_original','runtime_disconnected_reconcile_original','runtime_not_connected','managed_operation_unknown_reconcile','managed_task_response_stale'].includes(error.message))throw error;return {state:'rejected',code:error.message};}
    }
    if(action==='budget-continue'){
      const result=await driver.continueBudget(taskIdentity.page,payload,{workspace,submissions,assertCurrent:taskIdentity.assertCurrent,
        ...(controlContext?{executionReference:controlContext.execution_reference}:{})});
      publish();return result;
    }
    if(action==='start'){
      const result=await startExistingTask({pageById,driver,submissions},payload,
        controlContext?{operation_id:controlContext.execution_reference}:undefined);
      void driver.reconcileAll().catch(e=>{notice=e.message;publish();});return result;
    }
    if(action==='hold-history'){if(payload.confirm!==true)throw Error('必须明确确认历史任务冻结。');return runtime.call('hold-legacy',{targets:payload.targets});}
    if(action==='pause')return taskIdentity.run(page=>driver.pause(page,Object.hasOwn(payload,'expected_request_id')?payload.expected_request_id:activeRequestId(driver.records.get(page.id))));
    if(action==='team-maintenance'){
      const page=pageById(payload.id),maintenance=driver.records.get(page.id)?.maintenance;
      const request=['holding','settled'].includes(maintenance?.state)?{action:'resume-maintenance',
        expected_run_id:maintenance.run_id,expected_revision:maintenance.revision,
        ...(maintenance.state==='settled'?{checkpoint_hash:maintenance.checkpoint_hash}:{}),
        operation_id:'maintenance-resume-'+maintenance.run_id+'-'+maintenance.revision}:{action:'quiesce',operation_id:randomUUID()};
      const result=await runtime.call('maintenance',{page_id:page.id,...request});await driver.reconcileAll();return result;
    }
    if(action==='reconcile-attention'){
      const page=pageById(payload.id);
      const result=await runtime.call('reconcile-attention',{page_id:page.id,operation_id:payload.operation_id,payload:payload.data});
      await driver.reconcileAll();publish();return result;
    }
    if(action==='stop-generation'){
      return taskIdentity.run((page,check)=>driver.stopGeneration(page,check));
    }
    if(action==='resume')return taskIdentity.run(page=>driver.resume(page,Object.hasOwn(payload,'expected_request_id')?payload.expected_request_id:activeRequestId(driver.records.get(page.id))));
    throw Error('unsupported_action');
  };
  ipcMain.handle('clw-command',async(event,{action,payload={}})=>{ownShell(event);return dispatchCommand(action,payload);});
  shellControl=new ShellControl({contents:()=>win?.webContents,isCurrent:()=>!quitting&&!maintenanceChecking});
  ipcMain.on('clw-ui-control-response',(event,message)=>{try{ownShell(event);shellControl.respond(event,message);}catch{/* Ignore another renderer's reply. */}});
  shellSources=currentShellSources();await win.loadFile(path.join(__dirname,'index.html'));shellRevision++;
  try{
    const controlCaptures=require('./control-captures.cjs').createCaptureStore(path.join(profile,'control'));
    appControl=await require('./app-control.cjs').startAppControl({root:ROOT,profile,instanceId:focusInstanceId,
      capabilities:isolatedCheck?checkActions:appControlIdentity.capabilities,snapshot:controlSnapshot,
      dispatch:async(action,payload,expected,controlContext)=>{
        const assertOwner=(response=false)=>{try{appControlIdentity.assertControlIdentity(action,payload,expected,controlSnapshot());}
          catch(error){if(response)error.accepted=true;throw error;}};
        assertOwner();
        if((quitting||maintenanceChecking)&&!['quit','exit-status','reconcile-exit','cancel-exit'].includes(action))throw appControlIdentity.rejected('app_control_busy');
        if(action==='show'){win.show();if(win.isMinimized())win.restore();win.focus();return {shown:true,model_sends:0};}
        if(action==='reload-shell')return reloadShell(assertOwner);
        if(action==='reload-page-adapter')return reloadPageAdapter(payload,assertOwner);
        if(action==='inspect-ui'){const result=await shellControl.request('inspect');assertOwner();return result;}
        if(action==='ui-view'){const result=await shellControl.request('view',payload);assertOwner(true);return result;}
        if(action==='capture-shell'){
          const contents=win.webContents;
          const assertCaptureOwner=(response=false)=>{
            if(win?.webContents!==contents||contents.isDestroyed()){
              const error=appControlIdentity.rejected('app_control_owner_changed');if(response)error.accepted=true;throw error;
            }
            assertOwner(response);
          };
          return require('./control-shell-capture.cjs').captureShell({
            nativeOwner:contents,storageOwner:controlCaptures,inspect:()=>shellControl.request('inspect'),capture:()=>contents.capturePage(),
            save:bytes=>controlCaptures.capture(bytes),assertOwner:assertCaptureOwner});
        }
        return dispatchCommand(action,appControlIdentity.commandPayload(action,payload,expected),controlContext);
      }});
  }catch(error){notice='本地应用控制接口暂不可用：'+(error.code||error.message);publish();}
  if(restoreMode==='visible')win.show();else if(restoreMode==='minimized'){win.showInactive();win.minimize();}
  publish();
  if(previewMode&&!isolatedCheck)void previewSetup.call('read').catch(()=>publish());
  // Local service readiness is independent of slow web navigations.
  try{
    const {RuntimeBridge}=require('./runtime-bridge.cjs'),{WebDriver}=require('./web-driver.cjs');
    runtime=new RuntimeBridge(ROOT,{...(isolatedCheck||previewMode?{harnessPort:0}:{}),environment:previewConfig.childEnvironment(ROOT,process.env,guard.options)});runtime.on('notice',message=>{notice=runtimeAvailability.notice(message)||message;publish();});
    runtime.on('disconnected',()=>{if(!maintenanceExit.originalHostDisconnect(maintenanceClosingContext,runtime))runtimeGeneration++;selectedViewPoller.invalidate();view=null;publish();});
    submissions=new TaskSubmission(runtime,workspace);
    let initializing=null;
    const initialize=()=>{
      if(driver)return Promise.resolve();if(initializing)return initializing;
      taskStateRead={state:'loading',code:null};publish();
      initializing=(async()=>{
        const exitFile=path.join(profile,'user-exit.json');if(fs.existsSync(exitFile)){
          if(shutdownPolicy.pausesOnStartup(fs.readFileSync(exitFile,'utf8')))await runtime.call('pause-all');
          fs.unlinkSync(exitFile);
        }
        const onRecords=records=>{if(driver?.recordsLoaded){taskStateRead={state:'ready',code:null};workspaceRestored=true;}if(workspace.syncBindings(records))workspace.save();
          for(const record of records){const page=pool.pages.get(record.page_id),saved=workspace.tasks.get(record.page_id);
            if(page&&!loaded(page)&&saved?.boundUrl)page.url=saved.boundUrl;}publish();};
        const approvals=new ApprovalManager({journalFile:path.join(profile,'file-approvals.jsonl'),connectors:require('./connector-identity.cjs').connectorNames()});
        // Install the original observer before its first ledger read. A transient
        // list failure must recover while this same Host remains ready. onRecords
        // still restores bound URLs before the driver admits any renderer.
        driver=new WebDriver({runtime,pool,approvals,fileApprovalAuthorized,isClosed:id=>workspace.isClosed(id),metadata:id=>workspace.tasks.get(id)||{},onRecords,onNotice:message=>{if(runtime?.ready&&!driver?.recordsLoaded){taskStateRead={state:'unavailable',code:'runtime_task_state_unavailable'};notice=runtimeAvailability.notice(taskStateRead.code);}else notice=runtimeAvailability.notice(message)||message;publish();}});
        driver.onModelObserved=(account,model)=>{try{quotas.get(account)?.observe(model);}catch{/* Optional quota metadata cannot interrupt a task. */}};
        await driver.restore();
      })().catch(error=>{taskStateRead={state:'unavailable',code:'runtime_task_state_unavailable'};throw error;}).finally(()=>{initializing=null;});return initializing;
    };
    runtime.on('ready',()=>{runtimeEverReady=true;runtimeGeneration++;taskStateRead={state:'loading',code:null};selectedViewPoller.invalidate();view=null;publish();void initialize().catch(()=>{notice=runtimeAvailability.notice('runtime_task_state_unavailable');publish();});});
    await runtime.start();await initialize();
  }catch(e){notice=runtimeAvailability.notice(runtime?.snapshot().code||taskStateRead.code)||runtimeAvailability.notice('runtime_startup_failed');}publish();
  try{await guard.verify(session.fromPartition(partition));}catch(e){notice=e.message;guard.state=previewMode?'网络设置尚未就绪 · 请检查本机连接':'VPN 不可用 · 直连已禁用';publish();}
  if(!guard.ready&&!driver?.recordsLoaded)taskStateRead={state:'unavailable',code:'runtime_network_unavailable'};
  if(guard.ready){
    const saved=[...workspace.tasks.values()].filter(p=>!p.closed),selected=workspace.selected;
    for(const p of saved)pool.register(p.id,p.url,p);
    if(selected&&pool.pages.has(selected))pool.select(selected);else if(saved.length&&pool.pages.has(saved[0].id))pool.select(saved[0].id);
    if(driver){try{await driver.restore();}catch{taskStateRead={state:'unavailable',code:'runtime_task_state_unavailable'};notice=runtimeAvailability.notice(taskStateRead.code);}}savePages();
  }
  workspaceRestored=true;publish();
  if(configuredBridge&&guard.ready){
    nativeInitialization={state:'starting',ownerStarted:true};
    try{nativeBridge=await nativeBridgeModule.start({root:ROOT,window:win,guard,configured:configuredBridge,accountAccess:accountAccessFor(require('../codex-web-bridge/bridge-config.cjs').webAccount(configuredBridge.selected,ROOT))});
      nativeInitialization={state:nativeBridge?'ready':'failed',ownerStarted:true};}
    catch(e){
      const startup=e.nativeStartup,receipt=startup?.receipt;
      let absent=startup?.state==='not_started'&&startup.ownerStarted===false&&startup.reason==='execution_owner_never_started'&&!receipt&&!e.nativeOwner;
      if(startup?.state==='cleaned'&&startup.ownerStarted===false&&!e.nativeOwner){try{
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(receipt?.ownerEpoch||'')||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(receipt?.fenceId||''))throw Error('native_startup_exit_unverified');
        maintenanceExit.assertNativeExit(receipt,receipt);absent=true;
      }catch{/* Unverified cleanup retains its original owner. */}}
      nativeBridge=absent?null:e.nativeOwner||nativeBridge;
      nativeInitialization={state:absent?startup.state:'cleanup_unknown',ownerStarted:!absent,...(absent&&receipt?{receipt}:{})};
      notice='Codex Web 接入待处理：'+e.message;
    }
  }
  // Health persistence and UI publication have separate change detection. The
  // heartbeat stays fresh in background without writing or sending full state
  // for every browser observation. Reads are coalesced per original identity.
  stateTimer=setInterval(()=>publish(),2500);stateTimer.unref?.();publish({force:true});
}).catch(e=>{console.error('CLW startup failed:',e.message);app.quit();});
app.on('before-quit',event=>{
  if(finalQuit||!primary)return;event.preventDefault();if(quitting)return;quitting=true;
  if(maintenanceQuit){
    const original=maintenanceClosingContext;
    if(original?.reconcile){void original.reconcile();return;}
    const identity=()=>{
      if(!original||maintenanceClosingContext!==original||original.serial!==maintenanceSerial||runtime!==original.runtime||driver!==original.driver||pool!==original.pool||workspace!==original.workspace||nativeBridge!==original.nativeBridge||nativeInitialization!==original.nativeInitialization||
         (runtime.store||runtime.info?.store_id)!==original.store||runtime.info?.instance_id!==original.instance||driver.stopped!==true||driver.busy.size||maintenanceExit.pendingQuitIds(driver,original.ordinaryExit===true).length||submissions?.busy.size||!original.ordinaryExit&&Object.keys(workspace.pendingStarts||{}).length||[...(original.unavailableCarriers||[])].some(id=>pausedUnsentQuitWorkPending(id))||[...(original.unavailableCarrierBindings?.values()||[])].some(check=>!check())||maintenanceExit.workspaceRevision(driver,pool,workspace)!==original.revision)throw Error('maintenance_original_execution_unresolved');
    };
    const retain=error=>{quitting=false;maintenanceQuit=false;maintenanceChecking=true;
      const saving=!!original.hostExit&&(original.nativeDisabled||!!original.nativeExit);
      exitLifecycle.update(saving?'save-failed':'awaiting-original-exit',{blocked_reasons:exitFailureReasons(error||Error('exit_original_owner_pending'))});
      notice=(saving?'退出记录尚未保存，点击退出可接续保存：':'原退出尚未确认，点击退出可核对同一次关闭：')+(error?.code||error?.message||'exit_original_owner_pending');publish({force:true});};
    const complete=receipt=>{
      if(original.completed||maintenanceClosingContext!==original)return;
      identity();original.hostExit=maintenanceExit.assertHostExit(receipt,original);exitLifecycle.exited('host');
      if(!original.nativeDisabled&&!original.nativeExit)throw Error('maintenance_original_native_exit_unverified');
      exitLifecycle.update('saving',{blocked_reasons:[]});savePages();const record=JSON.stringify({...shutdownPolicy.exitRecord({maintenance:original.ordinaryExit!==true,pid:process.pid}),completion:{state:'original_owners_exited',exit_id:original.exitId,operation_id:exitLifecycle.snapshot().operation_id,host:receipt,native:original.nativeExit||{kind:'owned_native_not_started'}}});
      try{writePrivateFileAtomic(path.join(profile,'user-exit.json'),record,{flush:true});writePrivateFileAtomic(path.join(profile,'exit-record.json'),record,{flush:true});}
      catch(error){throw Object.assign(Error('exit_record_storage_failed',{cause:error}),{code:'exit_record_storage_failed',blockedReasons:[{code:'exit_record_storage_failed',reason:String(error.code||'write_failed')} ]});}
      original.completed=true;exitLifecycle.update('completed',{blocked_reasons:[]});quitting=true;maintenanceQuit=true;driver.stop();clearInterval(stateTimer);statePublisher.close();selectedViewPoller.invalidate();
      finishQuit();
    };
    const closeHost=()=>{
      if(original.hostClosePromise)return original.hostClosePromise;
      return original.hostClosePromise=(async()=>{
        // The original Host will freshly recheck Jobs on this retained permit;
        // elapsed time while the original Native exited does not issue a key.
        identity();
        if(original.ordinaryExit){
          const pagesCurrent=()=>{identity();if(hostQuitPageRevision()!==original.hostPageRevision)throw Error('maintenance_original_page_changed');};
          const carriers=[];await quitPageObservations(original.hostPages,pagesCurrent,{original,carriers});
          const payload={...original.hostPayload,permit_id:original.hostProof.permitId,paused_carriers:carriers};
          const fresh=await maintenanceExit.readProof(ROOT,original,payload);identity();
          if(fresh.proof.permitId!==original.hostProof.permitId)throw Error('exit_original_permit_changed');
          original.hostProof=fresh.proof;original.freshRead=fresh.freshRead;original.hostPayload=payload;
          await quitPageObservations(original.hostPages,pagesCurrent,{original,proof:original.hostProof,carriers:[]});
        }
        identity();maintenanceExit.assertProof(ROOT,original.hostProof,{...original,allowElapsed:true});
        original.runtime.on('maintenance-exit',receipt=>{if(original.waitingForHostExit&&!original.completed&&maintenanceClosingContext===original){try{complete(receipt);}catch(error){retain(error);}}});
        original.hostCloseDispatched=true;exitLifecycle.dispatched('host');
        complete(await original.runtime.closeMaintenance(original.hostProof));
      })();
    };
    const failed=async error=>{
        if(maintenanceExit.originalRefusal(error,original)&&nativeBridge===original.nativeBridge&&runtimeGeneration===original.generation){
          if(error.maintenanceClose.kind==='original_host_maintenance_exit'){
            // This exact pipe reply proves the owner shutdown was refused.
            // Keep any confirmed Native exit and refresh this Host permit on
            // explicit reconciliation; unknown replies never enter this path.
            original.hostCloseDispatched=false;original.hostClosePromise=null;
            const state=exitLifecycle.snapshot();exitLifecycle.update('awaiting-original-exit',{shutdown:{...state.shutdown,host:false},blocked_reasons:exitFailureReasons(error)});
            quitting=false;maintenanceQuit=false;maintenanceChecking=true;notice='原 Host 尚未关闭：'+(error.code||error.message)+'。可核对原退出后接续。';publish({force:true});return;
          }
          try{if(!original.nativeDisabled)await original.nativeBridge.resumeMaintenance();identity();original.releaseInputs?.();quitting=false;maintenanceQuit=false;maintenanceChecking=false;driver.stopped=original.driverStopped;maintenanceClosingContext=null;
            exitLifecycle.block(error);notice='退出未执行：'+(error.code||error.message)+'。原任务已保留。';publish({force:true});return;}catch{/* Keep the original unresolved fence and gate. */}
        }
        if(original?.observedNativeExit&&!original.nativeExit){original.nativeExit=original.observedNativeExit;exitLifecycle.exited('native');try{await closeHost();return;}catch(error){return failed(error);}}
        if(original&&!original.nativeDisabled&&!original.nativeExit)original.waitingForNativeExit=true;
        if(original)original.waitingForHostExit=!!original.nativeExit||original.nativeDisabled;
        retain(error);
        if(original?.waitingForHostExit&&original.runtime.maintenanceExitReceipt){try{complete(original.runtime.maintenanceExitReceipt);}catch{/* Keep the same incomplete exit record and owner receipts. */}}
    };
    original.reconcile=()=>{
      if(original.completed)return Promise.resolve(exitLifecycle.snapshot());
      if(original.closeWorkPromise)return original.closeWorkPromise;
      original.closeWorkPromise=(async()=>{try{
        identity();
        if(original.hostExit){complete(original.hostExit);return;}
        if(original.runtime.maintenanceExitReceipt){complete(original.runtime.maintenanceExitReceipt);return;}
        if(!original.nativeDisabled&&!original.nativeExit){
          if(original.observedNativeExit){original.nativeExit=original.observedNativeExit;exitLifecycle.exited('native');}
          else if(original.nativeCloseDispatched){retain(Error('exit_original_native_pending'));return;}
          else {
            original.unsubscribeNative=original.nativeBridge.onMaintenanceExit(receipt=>{
              if(maintenanceClosingContext!==original||original.completed)return;
              try{original.observedNativeExit=maintenanceExit.assertNativeExit(receipt,original.nativeProof);}catch{return;}
              if(original.waitingForNativeExit){original.waitingForNativeExit=false;original.nativeExit=original.observedNativeExit;exitLifecycle.exited('native');quitting=true;maintenanceQuit=true;void closeHost().catch(failed);}
            });
            original.nativeCloseDispatched=true;exitLifecycle.dispatched('native');
            original.nativeExit=maintenanceExit.assertNativeExit(await original.nativeBridge.close(),original.nativeProof);exitLifecycle.exited('native');
          }
        }
        if(original.nativeDisabled)exitLifecycle.exited('native');
        if(original.hostCloseDispatched){retain(Error('exit_original_host_pending'));return;}
        // A failed fresh check before Host dispatch may be repeated against the
        // same permit. A dispatched or unknown shutdown is never sent again.
        if(original.hostClosePromise&&!original.hostCloseDispatched)original.hostClosePromise=null;
        await closeHost();
      }catch(error){await failed(error);}finally{original.closeWorkPromise=null;}})();
      return original.closeWorkPromise;
    };
    void original.reconcile();return;
  }
  // No ordinary close may destroy an execution proxy behind an active page.
  // A raw app.quit (including OS/tray routes) must acquire the same proof.
  quitting=false;
  if(coldQuitContext){
    const original=coldQuitContext;
    void (async()=>{try{
      // The request snapshot is not a grant to close after another renderer's
      // asynchronous read. Recheck every owned page at the actual exit boundary.
      original.assertCurrent();await quitPageObservations(original.pages,original.assertCurrent);original.assertCurrent();
      savePages();const record=JSON.stringify(shutdownPolicy.exitRecord({pid:process.pid}));
      writePrivateFileAtomic(path.join(profile,'user-exit.json'),record,{flush:true});writePrivateFileAtomic(path.join(profile,'exit-record.json'),record,{flush:true});
      // Runtime never owned an accepted turn; invalidate only its future retry.
      if(runtime){runtime.closed=true;clearTimeout(runtime.restartTimer);clearTimeout(runtime.healthyTimer);}
      clearInterval(stateTimer);statePublisher.close();selectedViewPoller.invalidate();quitting=true;
      exitLifecycle.update('completed',{blocked_reasons:[]});finishQuit();
    }catch(error){original.releaseInputs?.();coldQuitContext=null;maintenanceChecking=false;exitLifecycle.block(error);notice='原网页或退出记录仍待核对，工作区保持打开；没有停止网页。';publish();}})();return;
  }
  void requestQuit().catch(error=>{notice=error.message;publish();win?.show();});
});
app.on('window-all-closed',()=>{if(quitting)app.quit();});
}
