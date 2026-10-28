'use strict';
const {createHash}=require('node:crypto');const {runDom}=require('./page-dom.cjs');const {markdown}=require('./markdown.cjs');
const pageInput=require('./page-input.cjs');
const {boundConversationUrl,restoreConversationUrl}=require('./workspace-state.cjs');
const {emptyCarrier,emptyEvidence,sameRecovery,bindingEvidence}=require('./carrier-recovery.cjs');
const {sameModel,sameEffort,availablePositions}=require('./model-settings.cjs');
const {requiresRenderer,originalTurnRequiresRenderer,loaded}=require('./page-residency.cjs');
const {selectStopScope,captureStopTarget}=require('./stop-scope.cjs');
const {connectorForAccount}=require('./connector-identity.cjs');
const {selectManagedConnector,assertSelection}=require('./managed-connector.cjs');
const preparedSendToken=Symbol('original-unsent-preparation');
const acceptedAttemptToken=Symbol('verified-original-dispatch');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const bootstrapScopeKey=r=>JSON.stringify(canonical([r.page_id,r.thread_id,r.account||'B',r.parent_target,r.root,r.url,
  r.access,r.write_paths,r.resources,r.bootstrap_text,r.first_turn_mode,r.first_turn_instructions,
  r.duration_seconds,r.max_dispatches,r.collaboration_protocol,r.latest_request?.id,r.latest_request?.attempt_id]));
const bootstrapDraftKey=r=>JSON.stringify(canonical([bootstrapScopeKey(r),r.model,r.effort,r.model_selection,
  r.bootstrap_model_selection,!!r.work_model_pending]));
const sendBindingKey=r=>r?JSON.stringify(canonical([r.page_id,r.thread_id,r.account||'B',r.url,r.phase,
  r.root,r.parent_target,r.model,r.effort,r.access,r.write_paths,r.resources,r.collaboration_protocol,
  r.latest_request?.id,r.latest_request?.phase])):null;
const sendHeld=r=>!r||r.paused||r.own_paused||r.attention||r.issue_kind||r.latest_request?.cancel_requested||
  r.observed_stop_user_hash&&r.resumed_stop_user_hash!==r.observed_stop_user_hash;
const samePreparedModel=(observed,original)=>sameModel(observed.model,original.model)&&sameEffort(observed.effort,original.effort)&&
  (observed.sliderCount===undefined||observed.sliderCount===1)&&(observed.sliderContainerCount===undefined||observed.sliderContainerCount===1)&&
  (!Array.isArray(original.selection)||!original.selection.length||(Array.isArray(observed.selection)&&observed.selection.length===original.selection.length&&
    original.selection.every((choice,i)=>sameModel(choice,observed.selection[i]))));
const hash=x=>createHash('sha256').update(x||'').digest('hex');const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const label=x=>String(x||'').trim().toLowerCase();
const editorEquivalent=(expected,observed)=>{
  // Contenteditable is LF-based. Windows CRLF must be normalized before
  // insertion, not accepted as the space Lexical sometimes creates from CR.
  expected=expected.replace(/\r\n/g,'\n');
  if(typeof observed!=='string'||expected.length!==observed.length)return false;
  for(let i=0;i<expected.length;i++){
    if(expected[i]===observed[i])continue;
    if(expected[i]!==' '||observed[i]!=='\u00a0'||(expected[i-1]!==' '&&expected[i+1]!==' '))return false;
  }
  return true;
};
const sendError=(code,message,snapshot)=>Object.assign(Error(message),{code,snapshot});
const latestGpt6Choice=selection=>!!selection&&/^gpt-6(?:\.\d+)*\s*·\s*(?:latest|最新)$/i.test(String(selection.model||'').trim())&&
  Array.isArray(selection.selection)&&selection.selection.length===1&&sameModel(selection.selection[0],'Latest');
const setupLatestBootstrap=(record,expected)=>!!record&&record.phase==='reserved'&&record.bootstrap_state==='pending'&&record.work_model_pending===true&&
  record.first_turn_mode!=='task_v1'&&!String(record.first_turn_instructions||'').trim()&&sameEffort(expected.effort,'极高')&&
  latestGpt6Choice({...expected.model_selection,model:expected.model});
const observedSetupLatest=(record,expected,observed)=>setupLatestBootstrap(record,expected)&&latestGpt6Choice(observed)&&sameEffort(observed.effort,expected.effort);
function protectedTurn(record,{pending=false,resultPending=false,approvalBusy=false,reading=false,...options}={}){
  if(pending||resultPending||approvalBusy||reading)return true;
  return originalTurnRequiresRenderer(record,options);
}
function knownIdleSnapshot(snapshot){
  return !!snapshot&&snapshot.editor===true&&snapshot.controlKnown===true&&snapshot.generating===false&&
    snapshot.draft===false&&snapshot.composing===false&&snapshot.approvalRequired===false&&
    !snapshot.error&&!snapshot.unknown&&snapshot.known!==false;
}
function originalFailedStream(record,snapshot){
  const request=record?.latest_request;
  return record?.phase==='bound'&&!!record.thread_id&&!!request?.id&&
    ['processing','suspended'].includes(request.phase)&&!request.cancel_requested&&
    /^control_[a-f0-9]{32}$/.test(request.attempt_id||'')&&
    snapshot?.rawStopPresent===true&&snapshot.url===boundConversationUrl(record)&&snapshot.historyAtLatest===true&&
    snapshot.attemptMarker===`[CLW:${request.attempt_id}]`&&snapshot.attemptMarkerCount===1&&
    !!snapshot.userId&&request.sent_user_hash===hash(snapshot.userId)&&
    /^(?:Something went wrong while generating the response\.?|生成回复时出错[。.]?|Thinking failed|思考失败|无法思考|Error in message stream[.]?|消息流中的错误[。.]?)$/i.test(snapshot.failure||'')&&
    knownIdleSnapshot(snapshot)&&['loginRequired','blocked','accessLimited'].every(k=>snapshot[k]===false);
}
function reloadableAccountFailure(snapshot){
  return !!snapshot&&snapshot.url==='https://chatgpt.com/'&&snapshot.pageLoadFailure==='account_load_failed'&&
    snapshot.editor===false&&snapshot.controlKnown===false&&
    snapshot.readiness?.knownEditors?.visibleCount===0&&snapshot.readiness?.editableAlternatives?.visibleCount===0&&
    ['generating','draft','composing','approvalRequired','loginRequired','blocked','accessLimited','complete'].every(k=>snapshot[k]===false)&&
    !snapshot.userId&&!snapshot.assistantId&&!snapshot.userText&&!snapshot.publicText&&!snapshot.html&&!snapshot.failure&&
    !snapshot.attemptMarker&&!snapshot.bootstrapMarker&&snapshot.attemptMarkerCount===0&&snapshot.bootstrapMarkerCount===0&&
    !snapshot.error&&!snapshot.unknown&&snapshot.known!==false;
}
function returnedFileApprovalTask(record,snapshot){
  // A future operator hold does not revoke this accepted turn's permission.
  if(!record||record.attention||record.issue_kind||record.receipt_collection_allowed===false||
    record.paused&&record.pause_origin?.source!=='operator'||record.latest_request?.cancel_requested||!snapshot?.userId||!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(snapshot.url||''))return null;
  const first=record.first_turn_mode==='task_v1'&&snapshot.bootstrapMarker==='[CLW-BOOTSTRAP:'+record.page_id+']'&&snapshot.bootstrapMarkerCount===1;
  const request=record.latest_request;
  if(request?.id&&['processing','suspended'].includes(request.phase)){
    if(first&&!request.attempt_id)return request.id;
    if(record.phase==='bound'&&snapshot.url===record.url&&request.attempt_id&&snapshot.attemptMarker==='[CLW:'+request.attempt_id+']'&&snapshot.attemptMarkerCount===1&&request.sent_user_hash===hash(snapshot.userId))return request.id;
  }
  if(first&&record.phase!=='bound'&&['sent','unknown'].includes(record.bootstrap_state)&&record.first_turn_instructions)return 'bootstrap:'+record.page_id;
  return null;
}
class WebDriver {
  constructor({runtime,pool,onNotice,dom=runDom,input=pageInput,isClosed=()=>false,metadata=()=>({}),onRecords=()=>{},sleep=delay,approvals=null,fileApprovalAuthorized=()=>false,observeIntervalMs=1500,hydrationCooldownMs=30000}){
    Object.assign(this,{runtime,pool,onNotice,dom,input,isClosed,metadata,onRecords,sleep,approvals,fileApprovalAuthorized,observeIntervalMs,hydrationCooldownMs});
    this.busy=new Set();this.pending=new Map();this.bootstrapPrepared=new Map();this.completed=new Set();this.resultCandidates=new Map();this.sendFailures=new Map();
    this.stopped=false;this.records=new Map();this.recordsLoaded=false;this.failures=new Map();this.connectionGeneration=0;
    this.pageReconciliations=new Map();this.monitorEnabled=false;this.monitorVersion=0;this.disposed=false;
    this.observationTasks=new Set();this.observationQuiesced=false;this.observationPause=null;
    this.manualPauses=new Map();
    this.onManualInteraction=({id})=>{const p=this.pool.pages.get(id);if(p)this.manualInteraction(p);};
    pool.on?.('manual-interaction',this.onManualInteraction);
    this.onRuntimeReady=()=>{this.connectionGeneration++;this.recordsLoaded=false;void this.reconcileAll({background:true}).catch(e=>this.onNotice(e.message));};
    this.onRuntimeDisconnected=()=>{this.connectionGeneration++;this.recordsLoaded=false;this.pool.emit?.('changed');};
    runtime.on('ready',this.onRuntimeReady);runtime.on('disconnected',this.onRuntimeDisconnected);
  }
  manualInteraction(p){
    p.manualControl=true;
    const r=this.records.get(p.id);
    if(r)this.records.set(p.id,{...r,paused:true,own_paused:true});
    p.status='你正在操作原网页 · 后续自动发送已暂停';
    this.pool.emit?.('changed');
    void this.persistManualPause(p).catch(()=>{
      p.status='手动操作优先 · 后续自动发送已暂停，等待保存状态';this.pool.emit?.('changed');
    });
  }
  persistManualPause(p){
    if(!p.manualControl||!this.records.has(p.id)||!this.runtime.ready||this.runtime.closed)return Promise.resolve();
    const prior=this.manualPauses.get(p.id);
    if(prior?.generation===this.connectionGeneration)return prior.promise;
    const pending=this.runtime.call('pause',{page_id:p.id,paused:true});
    this.manualPauses.set(p.id,{generation:this.connectionGeneration,promise:pending});
    return pending;
  }
  manualGuard(p,{allowManual=false}={}){
    const sequence=p.manualInteractionSequence||0;
    return ()=>{
      if(!allowManual&&p.manualControl||(p.manualInteractionSequence||0)!==sequence)
        throw sendError('manual_control','你正在操作原网页；后续自动发送已让位，原消息和执行保留。');
    };
  }
  async approveReturnedFile(p,r,s){
    const requestId=returnedFileApprovalTask(r,s);
    if(!requestId||!this.approvals||!(this.fileApprovalAuthorized('returned_file')||this.fileApprovalAuthorized('tool')))return null;
    const account=p.account||r.account||'B',view=p.view,wc=view?.webContents,generation=p.documentGeneration,connection=this.connectionGeneration;
    const authorized=(kind='returned_file')=>!this.stopped&&!this.runtime.closed&&this.fileApprovalAuthorized(kind)&&
      this.pool.pages?.get(p.id)===p&&!p.closed&&p.view===view&&view?.webContents===wc&&wc&&!wc.isDestroyed?.()&&
      p.documentGeneration===generation&&(p.account||'B')===account&&this.connectionGeneration===connection&&wc.getURL?.()===s.url&&
      returnedFileApprovalTask(this.records.get(p.id),s)===requestId;
    return this.approvals.inspect({id:p.id,requestId,url:s.url,userId:s.userId,connector:connectorForAccount(account),authorized,
      evaluate:source=>{if(!(authorized('returned_file')||authorized('tool')))throw Error('file_approval_identity_changed');return this.input.evaluate(wc,source);}});
  }
  async inspect(p,assertCurrent=()=>{},{keepMenuOpen=false,expectedBaseline}={}){
    const wc=p.view.webContents,sequence=p.manualInteractionSequence||0,originalAssert=assertCurrent;
    assertCurrent=()=>{originalAssert();if((p.manualInteractionSequence||0)!==sequence)throw sendError('manual_control','你正在操作原网页，模型核对已让位。');};
    try{assertCurrent();await this.dom(wc,'open-model',{expectedBaseline});assertCurrent();await delay(120);assertCurrent();const model=await this.dom(wc,'model',{expectedBaseline});assertCurrent();
      if(!model.model||!model.effort)throw Error('无法核对模型与思考档位，请在原始网页打开模型菜单。');
      p.modelSelection=model;p.observation={...p.observation,model,effortLabel:model.effort,modelCheckedAt:Date.now()};this.onModelObserved?.(p.account||'B',model);return model;
    }finally{if(!keepMenuOpen&&(p.manualInteractionSequence||0)===sequence)await this.input.key(wc,'Escape').catch(()=>{});}
  }
  async observeTask(p,assertCurrent=()=>{}){
    const view=p.view,wc=view?.webContents,generation=p.documentGeneration;
    const check=()=>{assertCurrent();if(!wc||p.view!==view||wc.isDestroyed?.()||p.documentGeneration!==generation)
      throw Error('task_observation_original_page_changed');};
    check();const snapshot=await this.dom(wc,'snapshot');check();
    const composer=await this.dom(wc,'connector-state',{expectedConnector:connectorForAccount(p.account||'B'),diagnostics:true});check();
    const {text,...summary}=composer;
    return {page_id:p.id,observed_at:Date.now(),url:snapshot.url,
      snapshot:Object.fromEntries(['editor','controlKnown','historyAtLatest','generating','draft','composing','approvalRequired',
        'accessLimited','blocked','loginRequired','stopped','complete','failure','rawStopPresent','streamInterrupted','processingNotice','bootstrapMarker','bootstrapMarkerCount','attemptMarker','attemptMarkerCount','readiness','pageLoadFailure']
        .filter(key=>Object.hasOwn(snapshot,key)).map(key=>[key,snapshot[key]])),
      user_turn_sha256:hash(snapshot.userId||''),assistant_turn_sha256:hash(snapshot.assistantId||''),
      composer:{...summary,text_utf8_bytes:Buffer.byteLength(text||'','utf8'),text_sha256:hash(text||'')}};
  }
  async recoverEmptyCarrier(p,r,s){
    if(r.phase!=='bound'||r.first_turn_mode!=='task_v1'||r.bootstrap_state!=='sent'||r.latest_request?.phase!=='queued'||
      r.paused||this.isClosed(p.id)||!emptyCarrier(s)||this.pending.has(p.id)||this.resultCandidates.size&&
      [...this.resultCandidates.keys()].some(id=>id===r.latest_request?.attempt_id)||this.approvals?.busy?.has?.(p.id))return null;
    const view=p.view,wc=view.webContents,generation=p.documentGeneration,connection=this.connectionGeneration;
    const identity=row=>JSON.stringify(canonical([bootstrapDraftKey(row),row.phase,row.paused,row.latest_request,row.renderer_lifecycle,
      row.own_paused,row.pause_origin,row.attention,row.issue_kind,row.work_model_pending]));
    const expected=identity(r);
    const current=()=>{
      const row=this.records.get(p.id);
      if(this.stopped||this.observationQuiesced||this.runtime.closed||this.isClosed(p.id)||this.pending.has(p.id)||
        this.approvals?.busy?.has?.(p.id)||this.resultCandidates.has(r.latest_request?.attempt_id)||
        this.pool.pages.get(p.id)!==p||p.view!==view||wc.isDestroyed?.()||wc.getURL?.()!==s.url||p.documentGeneration!==generation||
        this.connectionGeneration!==connection||(p.account||'B')!==(r.account||'B')||!row||
        identity(row)!==expected)
        throw Error('managed_empty_carrier_original_page_changed');
    };
    current();const scope=await this.runtime.call('carrier-recovery-check',{page_id:p.id});current();
    if(!scope.eligible)return sameRecovery(r)?r:null;
    if(sameRecovery(r)&&r.carrier_recovery.retry_epoch===scope.retry_epoch)return r;
    const fresh=await this.dom(wc,'snapshot');current();
    const composer=await this.dom(wc,'connector-state');current();
    // connector-state publishes exact body/IME/busy fields, not snapshot.draft.
    // Keep the independent snapshot's explicit draft=false and composer text
    // empty checks; demanding an absent field strands every real empty page.
    if(!emptyCarrier(fresh)||composer.editorCount!==1||composer.generating!==false||composer.composing!==false||
      composer.approvalRequired!==false||composer.accessLimited!==false||composer.blocked!==false||composer.text!=='')return null;
    const descriptor=await this.runtime.call('recover-empty-carrier',{page_id:p.id,expected:scope,browser:emptyEvidence(fresh,generation)});current();
    const next={...this.records.get(p.id),carrier_recovery:descriptor};this.records.set(p.id,next);p.status='原任务页面已恢复 · 等待首次业务发送';return next;
  }
  async bindRecoveredCarrier(p,r,s,attemptId=r.carrier_recovery?.attempt_id){
    if(!sameRecovery(r)||!attemptId)return null;
    const browser=bindingEvidence(s,attemptId);if(!browser)return null;
    const view=p.view,wc=view?.webContents,generation=p.documentGeneration,connection=this.connectionGeneration;
    const original=()=>{
      const row=this.records.get(p.id);
      return wc&&!wc.isDestroyed?.()&&this.pool.pages.get(p.id)===p&&p.view===view&&p.documentGeneration===generation&&
        this.connectionGeneration===connection&&(p.account||'B')===(r.account||'B')&&wc.getURL?.()===s.url&&
        row?.thread_id===r.thread_id&&row.url===r.url&&row.latest_request?.id===r.latest_request?.id;
    };
    if(!original())throw Error('managed_empty_carrier_original_page_changed');
    const descriptor=await this.runtime.call('bind-recovered-carrier',{page_id:p.id,recovery_id:r.carrier_recovery.id,
      request_id:r.carrier_recovery.request_id,attempt_id:attemptId,original_url:r.url,account:r.account||'B',url:s.url,browser});
    const next={...r,url:descriptor.url,carrier_recovery:descriptor};
    // The durable receipt owns the new address, even if observation was paused
    // while the bind reply returned. A later list reconciles changed UI state.
    const current=this.records.get(p.id);
    if(current?.thread_id===r.thread_id&&current.latest_request?.id===r.latest_request?.id&&current.url===r.url)
      this.records.set(p.id,{...current,url:descriptor.url,carrier_recovery:descriptor});
    if(p.view===view&&(p.account||'B')===(r.account||'B'))p.url=descriptor.url;
    // A committed bind is retained. A changed document waits for another
    // original observation before sending its public receipt to the Host.
    const latest=this.records.get(p.id);
    if(this.stopped||this.observationQuiesced||this.runtime.closed||this.connectionGeneration!==connection||
       this.pool.pages.get(p.id)!==p||(p.account||'B')!==(r.account||'B')||latest?.thread_id!==r.thread_id||
       latest?.latest_request?.id!==r.latest_request?.id||p.view!==view||p.documentGeneration!==generation||
       wc.isDestroyed?.()||wc.getURL?.()!==s.url)return null;
    return next;
  }
  async startFirstTurn(p,{root,title,instructions,effort='极高',access='write',write_paths=['.'],collaboration_protocol='tool_v1',collaboration_enabled=false,conversation_mode='managed',duration_seconds=null,max_dispatches=null,waitForReady=false,assertCurrent=()=>{}}){
    if(!['Pro','极高','高','中'].includes(effort))throw Error('请选择本轮要使用的思考档位。');
    if(effort==='Pro'&&!String(instructions||'').trim())throw Error('Pro 需要完整的首轮研究或方案要求；仅接入请选择极高。尚未发送。');
    if(this.busy.has(p.id))throw Error('正在核对这条任务，请稍后。');
    // This explicit first-send action may leave manual control. Subsequent
    // native input invalidates this one action across every awaited check.
    p.manualControl=false;const manualCurrent=this.manualGuard(p),originalAssert=assertCurrent;
    assertCurrent=()=>{originalAssert();manualCurrent();};
    this.pool.emit?.('manual-control-changed',{id:p.id});this.pool.emit?.('changed');this.busy.add(p.id);
    try{
      if(this.isClosed(p.id))throw Error('任务已关闭，请重新打开。');
      // Reconcile the durable reservation first; an uncertain earlier reply must
      // never produce a second enrollment on the same page.
      const state=await this.runtime.call('list');
      assertCurrent();
      const registered=state.pages.find(r=>r.page_id===p.id);
      if(registered){
        if(conversation_mode==='direct'&&registered.conversation_mode==='direct'&&!registered.latest_request){
          this.records.set(p.id,registered);return {state:'direct_ready',page_id:p.id};
        }
        throw Error('首次任务已提交，请查看原回执，不要重复发送。');
      }
      const snapshot=async()=>{
        try{return await this.dom(p.view.webContents,'snapshot');}
        catch(e){
          // BrowserPool exposes a page before its first navigation commits.
          // Only that known transient is eligible for the ordinary ready wait.
          if(waitForReady&&e.message==='chat_page_required'&&['','about:blank'].includes(p.view.webContents.getURL()))return {};
          throw e;
        }
      };
      let s=await snapshot();assertCurrent();
      for(let i=0;waitForReady&&i<30&&!s.loginRequired&&(!s.editor||!s.controlKnown);i++){
        if(this.stopped||this.isClosed(p.id))throw Error('任务已关闭或工作区正在退出，未发送。');
        await this.sleep(1000);s=await snapshot();assertCurrent();
      }
      if(this.stopped||this.isClosed(p.id))throw Error('任务已关闭或工作区正在退出，未发送。');
      if(s.loginRequired)throw Error('请先在对话网页登录当前账号，准备要求已保存。');
      if(!s.editor||!s.controlKnown)throw Error('网页还未准备好，要求已保存。加载完成后再点击发送。');
      if(s.generating||s.draft||s.composing||s.approvalRequired)throw Error('原网页正在工作或有草稿，请先在对话网页处理；本次没有发送。');
      const observed=await this.inspect(p,assertCurrent);assertCurrent();
      const selected=await this.selectModel(p,{...observed,effort,model_selection:{...observed,slider:null}},{followPageSelection:true});
      assertCurrent();
      if(this.stopped||this.isClosed(p.id))throw Error('任务已关闭或工作区正在退出，未发送。');
      if(conversation_mode==='direct'&&!collaboration_enabled){
        const result=await this.runtime.call('register-direct',{page_id:p.id,title,root:root||'',account:p.account||'B',
          model:selected.model,effort:selected.effort,url:s.url,model_selection:selected,collaboration_enabled:false,duration_seconds,max_dispatches});
        assertCurrent();await this.reconcileAll({background:true});return {...result,state:'direct_ready',page_id:p.id};
      }
      return await this.enroll(p,{root,title,model:selected.model,effort:selected.effort,access,write_paths,
        first_turn_instructions:instructions,collaboration_protocol,collaboration_enabled,duration_seconds,max_dispatches},assertCurrent);
    }finally{this.busy.delete(p.id);}
  }
  async bindDirectCarrier(p,r,s,attemptId=r.latest_request?.attempt_id){
    if(r.conversation_mode!=='direct'||r.url!=='https://chatgpt.com/'||!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(s.url||'')||
      !attemptId||s.attemptMarker!=='[CLW:'+attemptId+']'||s.attemptMarkerCount!==1||!s.userId)return null;
    const view=p.view,wc=view?.webContents,account=p.account||'B',thread=r.thread_id,request=r.latest_request?.id;
    const original=()=>this.pool.pages.get(p.id)===p&&p.view===view&&!wc?.isDestroyed?.()&&wc?.getURL?.()===s.url&&
      (p.account||'B')===account&&this.records.get(p.id)?.thread_id===thread&&this.records.get(p.id)?.latest_request?.id===request;
    if(!original())throw Error('managed_direct_original_page_changed');
    await this.runtime.call('bind-direct',{page_id:p.id,url:s.url});
    if(!original())throw Error('managed_direct_original_page_changed');
    const next={...this.records.get(p.id),url:s.url};this.records.set(p.id,next);p.url=s.url;return next;
  }
  async adoptModel(p,expected,assertCurrent=()=>{}){
    if(this.busy.has(p.id))throw Error('正在核对本轮状态，请稍后再采用设置。');
    this.busy.add(p.id);
    try{
      const r=this.records.get(p.id);if(!r)throw Error('managed_page_not_ready');
      const s=await this.dom(p.view.webContents,'snapshot');
      assertCurrent();
      if(s.generating)throw Error('managed_model_wait_for_turn_end');
      if(s.url!==r.url)throw Error('managed_page_identity_changed');
      const model=await this.inspect(p,assertCurrent);assertCurrent();
      if(label(model.model)!==label(expected.model)||label(model.effort)!==label(expected.effort))throw Error('网页设置又发生了变化，请重新核对后确认。');
      const result=await this.runtime.call('configure-model',{page_id:p.id,model:model.model,effort:model.effort,model_selection:model,expected_model:r.model,expected_effort:r.effort});
      assertCurrent();
      p.modelRestorePending=false;p.observation.error=null;await this.reconcileAll({background:true});return result;
    }finally{this.busy.delete(p.id);}
  }
  async selectModel(p,expected,{followPageSelection=false,bootstrapRecord=null,allowManual=false}={}){
    const wc=p.view.webContents,sequence=p.manualInteractionSequence||0,check=this.manualGuard(p,{allowManual});check();
    const dom=async(action,arg)=>{check();const result=await this.dom(wc,action,arg);check();return result;};
    let found=await this.inspect(p,check);check();
    const unavailable=message=>{const e=Error(message);e.code='worker_model_unavailable';return e;};
    // A setup-only Latest turn may expose GPT-6.1 at Extra High while the
    // saved formal Pro choice exposes GPT-6. Bootstrap can follow that public
    // choice only within the same major family, preserving its original menu.
    const followBootstrap=!!bootstrapRecord&&setupLatestBootstrap(bootstrapRecord,expected)&&latestGpt6Choice(found);
    if(bootstrapRecord)followPageSelection=followPageSelection&&followBootstrap;
    const uniqueBootstrapControls=model=>{
      if((model.sliderCount!==undefined&&model.sliderCount!==1)||(model.sliderContainerCount!==undefined&&model.sliderContainerCount!==1))
        throw unavailable('网页接入模型菜单的档位控件不唯一，worker 未发送。');
      availablePositions(model);
    };
    try{
      if(followBootstrap)uniqueBootstrapControls(found);
      if(!sameModel(found.model,expected.model)){
        // Only select names that the account's public menu actually exposes.
        for(const name of expected.model_selection?.selection||expected.model.split(' · ')){
          await dom('open-model');await this.sleep(100);const state=await dom('model');
          const option=state.options.find(o=>sameModel(o.name,name));
          if(!option||option.available===false)throw unavailable('此账号网页未提供指定模型 '+expected.model+'；worker 未发送。');
          if(!option.checked)await dom('choose-model',{label:option.name});
        }
        found=await this.inspect(p,check);check();
      }
      if(!sameEffort(found.effort,expected.effort)){
        await dom('open-model');await this.sleep(100);found=await dom('model');
        const positions=availablePositions(found),known=found.efforts.find(x=>x.available&&sameEffort(x.label,expected.effort));
        const inherited=expected.model_selection?.slider;
        const first=known?.value??(inherited&&inherited.min===found.slider.min&&inherited.max===found.slider.max?inherited.value:sameEffort(expected.effort,'Pro')?positions.at(-1):null);
        const selection=found.selection;
        const order=[...new Set([first,...positions].filter(x=>positions.includes(x)))];
        for(const target of order){
          await dom('focus-effort');
          const current=found.slider.value,key=target>current?'ArrowRight':'ArrowLeft';
          for(let n=0;n<Math.abs(target-current);n++){check();await this.input.key(wc,key);check();}
          for(let check=0;check<10;check++){await this.sleep(100);found=await dom('model');if(found.slider?.value===target)break;}
          if(found.slider?.value!==target)throw Error('网页思考档位控件未响应；尚未确认账号可用档位，worker 未发送。');
          // The public "Latest" choice can name different versions at Pro and
          // Extra High. An explicit operator effort change follows that choice;
          // worker inheritance still requires an exact model match.
          const sameSelection=Array.isArray(selection)&&selection.length>0&&Array.isArray(found.selection)&&found.selection.length===selection.length&&selection.every((name,i)=>sameModel(name,found.selection[i]));
          if(Array.isArray(selection)&&selection.length>0&&!sameSelection)throw unavailable('切换档位时网页模型选项发生变化，消息未发送。');
          if(sameEffort(found.effort,expected.effort))break;
        }
        if(!sameEffort(found.effort,expected.effort))throw unavailable('此账号网页没有可用的“'+expected.effort+'”档位；worker 未发送，也未替换为其他档位。');
      }
      if(bootstrapRecord&&!sameModel(found.model,expected.model)){
        if(!followPageSelection||!observedSetupLatest(bootstrapRecord,expected,found))throw unavailable('网页接入模型与指定的最新同家族极高选项不一致，worker 未发送。');
        uniqueBootstrapControls(found);
      }else if(!followPageSelection&&!sameModel(found.model,expected.model))throw unavailable('网页模型与指定模型不一致，worker 未发送。');
      p.modelSelection=found;p.observation={...p.observation,model:found,effortLabel:found.effort,modelCheckedAt:Date.now(),error:null};return found;
    }finally{if((p.manualInteractionSequence||0)===sequence)await this.input.key(wc,'Escape').catch(()=>{});}
  }
  async verifySetupLatest(p,record,expected,selected){
    const current=await this.inspect(p);
    if(!observedSetupLatest(record,expected,current)||!sameModel(current.model,selected.model)||!sameEffort(current.effort,selected.effort)||
       (current.sliderCount!==undefined&&current.sliderCount!==1)||(current.sliderContainerCount!==undefined&&current.sliderContainerCount!==1))
      throw Object.assign(Error('接入发送前最新模型选项发生变化，worker 未发送。'),{code:'worker_model_unavailable'});
    availablePositions(current);return current;
  }
  async setWorkModel(p,payload,assertCurrent=()=>{}){
    if(this.busy.has(p.id))throw Error('正在核对本轮回执，请稍后切换模型。');
    this.busy.add(p.id);let controlsChanged=false;
    try{
      const r=this.records.get(p.id);if(!r)throw Error('managed_page_not_ready');
      if(!['Pro','极高','高','中'].includes(payload.effort))throw Error('请选择工作模型菜单中的档位。');
      const check={page_id:p.id,expected_model:payload.expected_model,expected_effort:payload.expected_effort};
      await this.runtime.call('model-change-check',check);
      assertCurrent();
      const s=await this.dom(p.view.webContents,'snapshot');
      assertCurrent();
      if(s.url!==r.url)throw Error('managed_page_identity_changed');
      if(s.generating)throw Error('managed_model_wait_for_turn_end');
      if(s.draft||s.composing)throw Error('原网页有未发送草稿，请先处理后再切换。');
      if(!s.editor||!s.controlKnown)throw Error('网页还在加载，模型尚未切换。请稍后重试。');
      const live=await this.inspect(p,assertCurrent);assertCurrent();
      controlsChanged=true;
      const selected=await this.selectModel(p,{model:live.model,effort:payload.effort,model_selection:{...live,slider:null}},{followPageSelection:true,allowManual:true});
      assertCurrent();
      const result=await this.runtime.call('configure-model',{...check,model:selected.model,effort:selected.effort,model_selection:selected});
      assertCurrent();
      p.modelRestorePending=false;
      await this.reconcileAll({background:true});return {...result,model_sends:0};
    }catch(error){
      if(controlsChanged&&!['managed_task_identity_changed','managed_task_response_stale'].includes(error.message))await this.runtime.call('page-issue',{page_id:p.id,kind:'model_mismatch',detail:'工作模型切换尚未完成，请核对原网页后重试。原消息没有因此重发。'}).catch(()=>{});
      throw error;
    }finally{this.busy.delete(p.id);}
  }
  async withdraw(p,payload){
    // The durable transaction fences dispatch/claim races; no browser action is needed.
    const result=await this.runtime.call('withdraw',{...payload,page_id:p.id});
    await this.reconcileAll({background:true});return result;
  }
  async retirePartial(p,payload){
    if(this.busy.has(p.id))throw Error('正在核对原网页回合，请稍后重试。');
    this.busy.add(p.id);
    try{
      const r=this.records.get(p.id);if(!r||r.collaboration_protocol!=='text_v1')throw Error('managed_partial_retirement_worker_required');
      const s=await this.dom(p.view.webContents,'snapshot');
      if(!s.complete||s.historyAtLatest!==true||s.generating||s.draft||s.composing||!s.userTextComplete||!s.userId||!s.assistantId)
        throw Error('网页原回合尚未完整结束，不能收尾。');
      const result=await this.runtime.call('retire-partial',{
        page_id:p.id,request_id:payload.request_id,attempt_id:payload.attempt_id,
        observation_hash:payload.observation_hash,url:s.url,
        user_hash:hash(s.userId),assistant_turn_hash:hash(s.assistantId),user_text:s.userText,
        assistant_text:markdown(s.html),
        reason:payload.reason,confirm:payload.confirm===true,
        complete:!!s.complete,history_at_latest:s.historyAtLatest===true,
        generating:!!s.generating,draft:!!s.draft,composing:!!s.composing
      });
      await this.reconcileAll({background:true});return result;
    }finally{this.busy.delete(p.id);}
  }
  async enroll(p,payload,assertCurrent=()=>{}){const model=await this.inspect(p,assertCurrent);assertCurrent();if(model.model!==payload.model||model.effort!==payload.effort)throw Error('模型已变化，请重新读取后接入。');const r=await this.runtime.call('reserve',{page_id:p.id,title:payload.title,root:payload.root,model:model.model,effort:model.effort,model_selection:model,account:p.account||'B',access:payload.access||'read',write_paths:payload.write_paths||[],resources:[],duration_seconds:payload.duration_seconds??null,max_dispatches:payload.max_dispatches??null,first_turn_instructions:payload.first_turn_instructions||'',collaboration_enabled:payload.collaboration_enabled===true,collaboration_protocol:payload.collaboration_protocol||'tool_v1'});await this.reconcileAll({background:true});return {message:'正在通过本对话的 Local-MCP 接入项目。',state:r.state,page_id:r.page_id};}
  async pause(p,expectedRequestId){await this.runtime.call('pause',{page_id:p.id,paused:true,...(expectedRequestId!==undefined?{expected_request_id:expectedRequestId}:{})});await this.reconcileAll({background:true});return {message:'已暂停新派发；已接受的执行保留原记录。'};}
  async reportIssue(p,r,kind,detail){
    p.status=kind;p.observation={...p.observation,fault:kind};
    // Preserve the first recorded stop; passive observations never clear it.
    if(r.issue_kind||(p.reportedIssue===kind&&r.paused))return;
    await this.runtime.call('page-issue',{page_id:p.id,kind,detail});p.reportedIssue=kind;
  }
  async configureIntake(p,payload,assertCurrent=()=>{}){
    if(this.busy.has(p.id))throw Error('正在核对网页状态，请稍后保存。');
    this.busy.add(p.id);
    try{
      const s=await this.dom(p.view.webContents,'snapshot');if(s.generating)throw Error('网页仍在执行，请等本轮结束后修正访问范围。');
      assertCurrent();
      const result=await this.runtime.call('configure-intake',{...payload,page_id:p.id});await this.reconcileAll({background:true});return result;
    }finally{this.busy.delete(p.id);}
  }
  async refresh(p,{assertOwner=()=>{},navigationIntent}={}){
    if(this.busy.has(p.id))throw Error('正在提交或核对本轮回执，请稍后刷新网页。');
    this.busy.add(p.id);
    try{
      assertOwner();
      const record=this.records.get(p.id),view=p.view,generation=p.documentGeneration,account=p.account||'B';
      const identity=()=>{const row=this.records.get(p.id),saved=this.metadata(p.id);return JSON.stringify(canonical([
        row?.page_id,row?.phase,row?.thread_id,row?.account,row?.url,row?.conversation_mode,row?.latest_request,row?.attempt,row?.paused,row?.own_paused,
        saved?.id,saved?.account,saved?.url,saved?.readingRequestId,saved?.readingAttemptId]));};
      const baseline=identity(),connection=this.connectionGeneration;
      if(record&&account!==(record.account||'B'))throw Error('原任务账号已变化，未刷新；原工作继续保留。');
      const localPending=s=>this.resultCandidates.has(this.records.get(p.id)?.latest_request?.attempt_id)||
        this.approvals?.busy?.has?.(p.id)||
        this.pending.has(p.id)&&!(originalFailedStream(record,s)&&this.pending.get(p.id)?.attempt===record.latest_request.attempt_id&&
          !this.pending.get(p.id)?.state);
      const pending=()=>protectedTurn(this.records.get(p.id));
      const verifyIdle=snapshot=>{
        assertOwner(snapshot);
        if(localPending(snapshot))throw Error('原回合仍在执行或回执待核对；未刷新，也未停止网页工作。');
        if(snapshot?.draft||snapshot?.composing)throw Error('原网页有未发送内容，请先发送或清空后再刷新；工作记录里的草稿会保留。');
        if(snapshot?.generating)throw Error('当前网页仍在生成；未刷新，也未停止网页工作。');
        const accountFailure=reloadableAccountFailure(snapshot);
        if(!knownIdleSnapshot(snapshot)&&!accountFailure)throw Error('原网页状态尚未核对，未刷新。请保留当前页面稍后检查。');
        return accountFailure;
      };
      const snapshot=await this.dom(p.view.webContents,'snapshot');verifyIdle(snapshot);
      const original=boundConversationUrl(record)||(record?.phase==='bound'&&record.conversation_mode==='direct'&&record.url==='https://chatgpt.com/'?
        restoreConversationUrl(record,p,this.metadata(p.id)):null);
      const current=snapshot?.url||p.view.webContents.getURL?.();
      const failedStream=current===original&&(p.account||'B')===(record?.account||'B')&&originalFailedStream(record,snapshot);
      const otherManualPage=()=>p.manualControl&&current!==original;
      if(pending()&&!failedStream&&!otherManualPage())throw Error('原回合仍在执行或回执待核对；未刷新，也未停止网页工作。');
      const assertCurrent=()=>{assertOwner(snapshot);if(this.pool.pages?.get(p.id)!==p||p.closed||this.isClosed(p.id)||p.view!==view||view.webContents.isDestroyed?.()||p.documentGeneration!==generation||(p.account||'B')!==account||view.webContents.getURL?.()!==current||identity()!==baseline||this.connectionGeneration!==connection||localPending(snapshot)||pending()&&!failedStream&&!otherManualPage()||this.stopped||this.disposed||this.observationQuiesced||this.runtime.closed)throw Error('原任务状态已变化，未刷新；原工作继续保留。');};
      assertCurrent();
      const beforeNavigation=async()=>{
        assertCurrent();const fresh=await this.dom(view.webContents,'snapshot');assertCurrent();
        verifyIdle(fresh);const freshUrl=fresh?.url||view.webContents.getURL?.();
        if(freshUrl!==current||pending()&&!originalFailedStream(record,fresh)&&!otherManualPage())
          throw Error('原网页状态已变化，未刷新；原工作继续保留。');
      };
      await this.pool.reload(p.id,undefined,{assertCurrent:beforeNavigation,assertNavigationCurrent:assertCurrent,navigationIntent});
      return {message:'已请求刷新当前网页；原任务和发送回执保留，不发送模型消息。'};
    }finally{this.busy.delete(p.id);}
  }
  async reconnectFailedStream(p,r,s){
    const localPending=()=>this.pending.has(p.id)&&(this.pending.get(p.id)?.attempt!==r?.latest_request?.attempt_id||
      !!this.pending.get(p.id)?.state)||this.resultCandidates.has(r?.latest_request?.attempt_id);
    if((p.account||'B')!==(r?.account||'B')||!originalFailedStream(r,s)||localPending())return false;
    this.failedStreamReconnects??=new Map();
    const key=JSON.stringify([p.id,r.thread_id,r.latest_request.id,r.latest_request.attempt_id,r.latest_request.sent_user_hash,r.url]);
    if(this.failedStreamReconnects.has(key))return false;
    const view=p.view,generation=p.documentGeneration,connection=this.connectionGeneration,account=p.account||'B';
    const identity=row=>JSON.stringify(canonical([row?.page_id,row?.thread_id,row?.account,row?.url,row?.latest_request,row?.paused,row?.own_paused,row?.issue_kind]));
    const baseline=identity(r);
    const assertCurrent=()=>{if(this.stopped||this.observationQuiesced||this.runtime.closed||this.connectionGeneration!==connection||
      this.pool.pages.get(p.id)!==p||p.view!==view||p.documentGeneration!==generation||(p.account||'B')!==account||view.webContents.isDestroyed?.()||view.webContents.getURL?.()!==s.url||
      identity(this.records.get(p.id))!==baseline||localPending())throw Error('failed_stream_original_turn_changed');};
    assertCurrent();
    // Mark before navigation. A lost navigation reply or a replacement
    // document cannot turn this original attempt into a reload loop.
    this.failedStreamReconnects.set(key,{attempt_id:r.latest_request.attempt_id,document_generation:generation,state:'attempted'});
    p.status='回复生成失败 · 正在重连原对话';
    await this.pool.reload(p.id,undefined,{assertCurrent,assertNavigationCurrent:assertCurrent});
    return true;
  }
  async resume(p,expectedRequestId){
    const sequence=p.manualInteractionSequence||0,original=this.records.get(p.id),
      originalThread=original?.thread_id,originalRequest=original?.latest_request?.id??null;
    try{
      try{await this.persistManualPause(p);}
      catch{
        // An explicit resume may reconcile one failed pause. A fresh original
        // row prevents an old rejected Promise from locking this page forever.
        const state=await this.runtime.call('list'),row=state.pages?.find(r=>r.page_id===p.id);
        if(!row||row.thread_id!==originalThread||(row.account||'B')!==(p.account||'B')||
          (row.latest_request?.id??null)!==originalRequest||
          expectedRequestId!==undefined&&require('./task-action-identity.cjs').activeRequestId(row)!==expectedRequestId)
          throw Error('原手动暂停尚未核对，后续发送保持暂停。');
        this.manualPauses.delete(p.id);
      }
      if((p.manualInteractionSequence||0)!==sequence)throw sendError('manual_control','原网页又有手动操作；后续发送保持暂停。');
      await this.runtime.call('pause',{page_id:p.id,paused:false,...(expectedRequestId!==undefined?{expected_request_id:expectedRequestId}:{})});
      if((p.manualInteractionSequence||0)!==sequence){
        this.manualPauses.delete(p.id);await this.persistManualPause(p);
        throw sendError('manual_control','原网页又有手动操作；后续发送保持暂停。');
      }
      p.manualControl=false;this.manualPauses.delete(p.id);this.pool.emit?.('manual-control-changed',{id:p.id});this.pool.emit?.('changed');
    }
    catch(error){throw require('./task-submission.cjs').submissionError(error);}
    await this.reconcileAll({background:true});
  }
  async pauseAll(){
    const previous=this.pauseAllAttempt;
    if(previous&&!previous.confirmed){
      if(previous.runtime!==this.runtime||previous.child!==this.runtime.child||previous.store!==(this.runtime.store||this.runtime.info?.store_id))throw Error('原暂停回执仍待核对，没有再次派发暂停。');
      const state=await this.runtime.call('list');
      if(!Array.isArray(state.pages)||state.store_id!==previous.store||state.pages.some(r=>!r.parent_target&&!r.own_paused))throw Error('原暂停回执仍待核对，没有再次派发暂停。');
      previous.confirmed=true;return {paused:true,reconciled:true};
    }
    const attempt={runtime:this.runtime,child:this.runtime.child,store:this.runtime.store||this.runtime.info?.store_id,confirmed:false};
    this.pauseAllAttempt=attempt;
    let result;try{result=await this.runtime.call('pause-all',{});}catch(error){if(error.message==='runtime_not_connected'&&this.pauseAllAttempt===attempt)this.pauseAllAttempt=null;throw error;}
    if(result?.paused!==true)throw Error('原暂停回执仍待核对，没有再次派发暂停。');
    attempt.confirmed=true;return result;
  }
  async goalOperation(p,operation,payload={},assertCurrent=()=>{}){
    if(!['goal-read','goal-save','goal-review','goal-next','goal-discard','goal-stop'].includes(operation))throw Error('managed_goal_operation_invalid');
    const {id,expected_connection_generation,...request}=payload;
    assertCurrent();
    const result=await this.runtime.call(operation,{...request,page_id:p.id});
    assertCurrent({response:true});
    if(result?.model_sends!==0)throw Error('managed_goal_response_invalid');
    // Preparing is a metadata receipt with an immutable future Send key. It is
    // not a goal view and, particularly, not an accepted model submission.
    const goal=result?.goal;
    if(operation==='goal-next'){
      if(result.state!=='goal_next_prepared')throw Error('managed_goal_response_invalid');
    }else if(!goal||typeof goal!=='object'||typeof goal.configured!=='boolean')throw Error('managed_goal_response_invalid');
    if(operation!=='goal-read'){await this.reconcileAll({background:true});assertCurrent({response:true});}
    return result;
  }
  async continueGoal(p,payload,{workspace,submissions,assertCurrent=()=>{}}){
    assertCurrent();
    const pending=workspace.pendingStarts[p.id];
    if(pending){
      // A saved unknown Send is the authority for this retry. Do not prepare a
      // new grant, resume, or issue another Send while checking its receipt.
      const result=await submissions.start(p.id,pending.objective);
      assertCurrent({response:true,acceptedRequestId:result?.request_id});return result;
    }
    const read=await this.goalOperation(p,'goal-read',{},assertCurrent);
    let next=read.goal.next;
    if(!next)next=await this.goalOperation(p,'goal-next',payload,assertCurrent);
    if(!read.goal.configured||read.goal.mode!=='manual'||read.goal.identity_valid===false||
      !next||next.state!=='goal_next_prepared'||typeof next.operation_id!=='string'||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(next.operation_id)||
      typeof next.objective!=='string'||!next.objective.trim()||next.objective.includes('\0')||[...next.objective.trim()].length>24000)
      throw Error('managed_goal_original_operation_required');
    if(next.source_request_id!==read.goal.request_id||next.source_request_id!==payload.expected_goal_request_id||
      next.expected_run_id!==payload.expected_run_id)throw Error('managed_goal_request_changed');
    assertCurrent();await this.resume(p,null);assertCurrent();
    const result=await submissions.start(p.id,next.objective,null,{operation_id:next.operation_id});
    if(result?.state==='queued_for_web_host'&&result.request_id!==next.operation_id)throw Error('managed_goal_response_invalid');
    assertCurrent({response:true,acceptedRequestId:result?.request_id});
    await this.reconcileAll({background:true});assertCurrent({response:true,acceptedRequestId:result?.request_id});return result;
  }
  async continueBudget(p,payload,{workspace,submissions,assertCurrent=()=>{},executionReference}){
    assertCurrent();
    const pending=workspace.pendingStarts[p.id];
    if(pending){
      const result=await submissions.start(p.id,pending.objective);
      assertCurrent({response:true,acceptedRequestId:result?.request_id});return result;
    }
    const instructions=String(payload.instructions||'').trim();
    if([...instructions].length>11000||instructions.includes('\0'))throw Error('续杯补充请控制在11000字以内。');
    const read=await this.goalOperation(p,'goal-read',{},assertCurrent);
    if(read.goal.configured&&read.goal.mode==='manual')throw Error('managed_goal_use_continue');
    const original=await this.runtime.call('budget-continuation',{page_id:p.id,expected_run_id:payload.expected_run_id});
    assertCurrent();
    const objective=original?.objective+(instructions?'\n\n本次用户要求：\n'+instructions:'');
    if(typeof original?.objective!=='string'||!original.objective.trim()||[...objective.trim()].length>24000)
      throw Error('managed_budget_continuation_invalid');
    await this.resume(p,null);assertCurrent();
    const result=executionReference===undefined?await submissions.start(p.id,objective):await submissions.start(p.id,objective,null,{operation_id:executionReference});
    assertCurrent({response:true,acceptedRequestId:result?.request_id});
    await this.reconcileAll({background:true});assertCurrent({response:true,acceptedRequestId:result?.request_id});return result;
  }
  restore(){
    if(this.disposed)return Promise.reject(Error('web_driver_disposed'));
    if(this.stopped||this.observationQuiesced)return Promise.resolve();
    this.monitorEnabled=true;
    if(this.restorePromise)return this.restorePromise;
    const version=this.monitorVersion;
    // The first read can fail or a renderer can take minutes to recover. Keep
    // one observer alive; readiness depends on the ledger, never those pages.
    const restored=this.reconcileAll({background:true});this.restorePromise=restored;
    void restored.then(()=>this.finishRestore(restored,version),()=>this.finishRestore(restored,version));
    return restored;
  }
  finishRestore(restored,version){
    if(this.restorePromise===restored)this.restorePromise=null;
    this.scheduleObservation();
  }
  trackObservation(promise){
    this.observationTasks.add(promise);
    const clear=()=>this.observationTasks.delete(promise);
    void promise.then(clear,clear);return promise;
  }
  async quiesceObservation({timeoutMs=10000}={}){
    if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('web_observer_drain_timeout_invalid');
    if(!this.observationPause)this.observationPause={monitorEnabled:this.monitorEnabled};
    this.observationQuiesced=true;this.monitorVersion++;clearTimeout(this.timer);this.timer=null;
    const deadline=Date.now()+timeoutMs;
    while(this.observationTasks.size||this.pageReconciliations.size||this.recordsRefresh){
      const remaining=deadline-Date.now();if(remaining<=0)throw Error('web_observer_drain_timeout');
      const tasks=new Set([...this.observationTasks,...this.pageReconciliations.values()]);
      if(this.recordsRefresh)tasks.add(this.recordsRefresh.promise);
      let timer;
      try{await Promise.race([Promise.allSettled([...tasks]),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('web_observer_drain_timeout')),remaining);
      })]);}finally{clearTimeout(timer);}
    }
    return {state:'quiesced',remaining:0,model_sends:0};
  }
  resumeObservation(){
    const paused=this.observationPause;this.observationPause=null;this.observationQuiesced=false;this.monitorVersion++;
    if(!paused||this.stopped||this.disposed)return false;
    if(paused.monitorEnabled)this.monitorEnabled=true;
    this.scheduleObservation();return true;
  }
  scheduleObservation(){
    if(this.timer||this.monitorCycle||!this.monitorEnabled||this.stopped||this.disposed||this.observationQuiesced)return;
    const version=this.monitorVersion;
    this.timer=setTimeout(()=>{
      this.timer=null;if(version!==this.monitorVersion||this.stopped||this.disposed||this.observationQuiesced)return;
      const cycle=this.reconcileAll({background:true});this.monitorCycle=cycle;
      void cycle.catch(e=>{if(version===this.monitorVersion&&!this.stopped)this.onNotice(e.message);}).finally(()=>{
        if(this.monitorCycle===cycle)this.monitorCycle=null;
        this.scheduleObservation();
      });
    },this.observeIntervalMs);this.timer.unref?.();
  }
  readRecords(){
    const generation=this.connectionGeneration;
    if(this.recordsRefresh?.generation===generation)return this.recordsRefresh.promise;
    this.refreshing=true;
    const refresh={generation};
    const reading=(async()=>{
      const state=await this.runtime.call('list');
      if(this.stopped||this.disposed||!this.runtime.ready||generation!==this.connectionGeneration)return null;
      if(!Array.isArray(state?.pages))throw Error('runtime_task_state_invalid');
      this.records=new Map(state.pages.map(p=>[p.page_id,p]));
      for(const r of state.pages){const p=this.pool.pages.get(r.page_id);if(p?.manualControl){
        this.records.set(r.page_id,{...r,paused:true,own_paused:true});
        void this.persistManualPause(p).catch(()=>{});
      }}
      this.pruneObservationMemory();
      this.recordsLoaded=true;
      this.onRecords([...this.records.values()]);
      this.pool.emit?.('changed');
      return state;
    })();refresh.promise=reading;this.recordsRefresh=refresh;
    const clear=()=>{if(this.recordsRefresh===refresh){this.recordsRefresh=null;this.refreshing=false;}};
    void reading.then(clear,clear);return reading;
  }
  pruneObservationMemory(){
    // Completed receipt suppression is a cache, not the durable receipt. Keep
    // every current/local accepted attempt and discard obsolete turn markers.
    const attempts=new Set([...this.records.values()].map(r=>r.latest_request?.attempt_id).filter(Boolean));
    for(const pending of this.pending.values())if(pending?.attempt)attempts.add(pending.attempt);
    for(const attempt of this.completed)if(!attempts.has(attempt))this.completed.delete(attempt);
    if(!this.busy.size)for(const attempt of this.resultCandidates.keys())if(!attempts.has(attempt))this.resultCandidates.delete(attempt);
    for(const cache of [this.observerDue,this.hydrationFailures,this.crashes,this.failures,this.bootstrapPrepared,this.sendFailures]){
      if(!cache)continue;
      for(const id of cache.keys())if(!this.records.has(id)&&!this.pending.has(id)&&!this.busy.has(id)&&!this.pageReconciliations.has(id))cache.delete(id);
    }
  }
  reconcileAll(options={}){return this.trackObservation(this.readAndReconcile(options));}
  async readAndReconcile({background=false}={}){
    if(this.stopped||this.disposed||!this.runtime.ready)return;
    const generation=this.connectionGeneration,state=await this.readRecords();
    if(!state||this.stopped||this.disposed||this.observationQuiesced||generation!==this.connectionGeneration)return;
    const pages=state.pages.map(r=>this.reconcilePage(r,generation));
    // Independent pages progress concurrently. UI actions and restoration
    // only wait for original records; tests/explicit reconciliation can join.
    if(background){for(const page of pages)void page.catch(e=>this.onNotice(e.message));return;}
    await Promise.all(pages);
  }
  reconcilePage(r,connection){
    if(this.pageReconciliations.has(r.page_id))return this.pageReconciliations.get(r.page_id);
    const current=()=>!this.stopped&&!this.disposed&&!this.observationQuiesced&&this.runtime.ready&&connection===this.connectionGeneration&&this.records.get(r.page_id)===r;
    const reconciling=(async()=>{
        if(!current())return;
        const hidden=this.isClosed(r.page_id);
        if(hidden){
          // Persist a close intent accepted while the local service was offline.
          if(!r.paused){await this.runtime.call('pause',{page_id:r.page_id,paused:true});if(!current())return;}
          r.paused=true;
          if(!this.pool.pages.has(r.page_id)&&!protectedTurn(r,{pending:this.pending.has(r.page_id),resultPending:this.resultCandidates.has(r.latest_request?.attempt_id),
            approvalBusy:this.approvals?.busy?.has?.(r.page_id),reading:this.busy.has(r.page_id),closed:true,restoreUrl:restoreConversationUrl(r,this.metadata(r.page_id))}))return;
        }
        if(!this.pool.pages.has(r.page_id)){
          try{const saved=this.metadata(r.page_id),metadata={title:r.title,root:r.root,...saved,account:r.account||'B',hidden};
            const restoreUrl=restoreConversationUrl(r,saved);
            if(this.pool.register)this.pool.register(r.page_id,restoreUrl,metadata);
            else await this.pool.create(r.page_id,restoreUrl,metadata);}
          catch(e){if(current())this.onNotice(e.message);return;}
        }
        if(!current())return;
        const page=this.pool.pages.get(r.page_id);
        const retained=()=>hidden&&protectedTurn(this.records.get(r.page_id),{pending:this.pending.has(r.page_id),resultPending:this.resultCandidates.has(this.records.get(r.page_id)?.latest_request?.attempt_id),
          approvalBusy:this.approvals?.busy?.has?.(r.page_id),closed:true,restoreUrl:restoreConversationUrl(this.records.get(r.page_id),page,this.metadata(r.page_id))});
        const needed=retained()||requiresRenderer(r,{viewing:this.pool.selected===r.page_id,
          pending:this.pending.has(r.page_id),resultPending:this.resultCandidates.has(r.latest_request?.attempt_id),
          approvalBusy:this.approvals?.busy?.has?.(r.page_id),reading:this.busy.has(r.page_id)||!!page?.pins?.size,
          safetyPin:!!page?.residentRequired&&(loaded(page)||/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(restoreConversationUrl(r,page,this.metadata(r.page_id))||'')),
          closed:hidden,restoreUrl:restoreConversationUrl(r,page,this.metadata(r.page_id))});
        if(!loaded(page)){
          if(!needed)return;
          // Bound rows own their address. An accepted, still-unbound bootstrap
          // may retain a same-page saved conversation for receipt reading while
          // the ledger still has its original homepage placeholder.
          page.url=restoreConversationUrl(r,page,this.metadata(r.page_id));
          this.hydrationFailures??=new Map();
          const signature=JSON.stringify([r.account,r.url,page.url,r.paused,r.bootstrap_state,r.latest_request?.id,r.latest_request?.phase,
            this.pool.networkGuard?.ready,this.pool.accountAccessFor?.(page.account||r.account||'B')?.read?.()?.blocked]);
          let prior=this.hydrationFailures.get(r.page_id);
          if(prior?.signature===signature&&Date.now()<prior.next)return;
          // Three read/admission attempts form one bounded batch. A transient
          // failure is retried after cooldown, without mutating the task or
          // requiring a user to alter it merely to reset an exhausted counter.
          if(prior?.signature===signature&&prior.count>=3){
            if(prior.terminal)return;
            prior={...prior,count:0};
          }
          try{await this.pool.ensure?.(r.page_id);this.hydrationFailures.delete(r.page_id);}
          catch(e){const count=prior?.signature===signature?prior.count+1:1;
            const terminal=['account_access_cooldown','browser_url_not_allowed','browser_page_missing'].includes(e.code||e.message);
            this.hydrationFailures.set(r.page_id,{signature,count,terminal,next:Date.now()+(count>=3?this.hydrationCooldownMs:[1500,4000][count-1])});
            if(current()&&(count===1||count===3))this.onNotice(e.message);return;}
          if(!current()||!loaded(page))return;
        }else if(!needed&&this.pool.suspend&&!this.busy.has(r.page_id)){
          // Read at the release decision, then recheck the current durable row.
          // A cached idle observation can miss a new draft or a manual Send.
          this.busy.add(r.page_id);
          try{
            const originalView=page.view,generation=page.documentGeneration,s=await this.dom(originalView.webContents,'snapshot');
            const current=this.records.get(r.page_id);
            if(!this.stopped&&!this.observationQuiesced&&connection===this.connectionGeneration&&page.view===originalView&&page.documentGeneration===generation&&knownIdleSnapshot(s)&&s.historyAtLatest!==false&&!retained()&&!requiresRenderer(current,{viewing:this.pool.selected===r.page_id,
              pending:this.pending.has(r.page_id),resultPending:this.resultCandidates.has(current?.latest_request?.attempt_id),
              approvalBusy:this.approvals?.busy?.has?.(r.page_id),reading:!!page.pins?.size,safetyPin:!!page.residentRequired,
              closed:hidden,restoreUrl:restoreConversationUrl(current,page,this.metadata(r.page_id))})&&!this.stopped){
              const observation={...s,at:Date.now(),generating:!!s.generating};
              page.observation={...page.observation,...observation,error:null,errorAt:null,unknown:false};
              this.pool.running?.(page.id,!!s.generating);
              if(this.pool.suspend(r.page_id,{observation}).suspended)return;
            }
          }catch{/* An unreadable page is retained for the original observation. */}
          finally{this.busy.delete(r.page_id);}
        }
        this.observerDue??=new Map();
        if(!current()||!require('./observer-schedule.cjs').mayObserve(r,this.pool.pages.get(r.page_id),this.observerDue,{selected:this.pool.selected===r.page_id}))return;
        void this.tick(r).catch(e=>{
          // A navigation can change URL between getURL and the public DOM
          // read. Loading/login status belongs to the page, not a sticky
          // global error shown on an unrelated, already connected task.
          if(e.message==='chat_page_required')return;
          const page=this.pool.pages.get(r.page_id);if(page)page.observation={...page.observation,error:e.message,errorAt:Date.now()};
          // Task-local faults must not become a sticky warning on another task.
          this.pool.emit?.('changed');
        });
    })();this.pageReconciliations.set(r.page_id,reconciling);
    const clear=()=>{if(this.pageReconciliations.get(r.page_id)===reconciling)this.pageReconciliations.delete(r.page_id);};
    void reconciling.then(clear,clear);return reconciling;
  }
  async reconcile(id){
    if(this.stopped)return;this.crashes??=new Map();const count=this.crashes.get(id)||0,p=this.pool.pages.get(id);if(!p)return;
    p.observation={...p.observation,error:count>=3?'renderer_crash_limit':'renderer_crashed',errorAt:Date.now()};this.pool.emit?.('changed');
    if(protectedTurn(this.records.get(id),{pending:this.pending.has(id),resultPending:this.resultCandidates.has(this.records.get(id)?.latest_request?.attempt_id)}))return;
    if(count>=3){const r=this.records.get(id);if(r)await this.reportIssue(p,r,'control_failed','本页异常退出已达到3次恢复上限；原任务和工具回执保留，请核对后手动刷新。');return;}
    this.crashes.set(id,count+1);await this.sleep([1000,4000,15000][count]);
    if(!this.stopped&&this.pool.pages.get(id)===p&&p.view&&!p.view.webContents.isDestroyed())await this.refresh(p);
    await this.reconcileAll({background:true});
  }
  pageState(s,model){return {visible:true,generating:s.generating,draft:s.draft,composing:!!s.composing,focused:!!s.focused,blocked:s.blocked,stopped:s.stopped,controls_known:s.editor&&s.controlKnown,model_pro_visible:false,effort_disallowed_visible:false,editor_known:s.editor,user_known:!!s.userId,mode_control_known:s.controlKnown,model_label:model.model,effort_label:model.effort,user_hash:hash(s.userId),failure_hash:hash(s.failure),failure_kind:s.failure?'generation_failed':''};}
  wire(r,action,page,extra={}){return this.runtime.call('wire',{page_id:r.page_id,data:{action,...(action==='finish'?{}:{page}),...extra}});}
  observeStop(p,s,clicked=false){return this.runtime.call('stop-observed',{page_id:p.id,url:s.url,user_hash:hash(s.userId),turn_hash:hash(s.assistantId),generating:!!s.generating,observed_stopped:!!s.stopped,stop_clicked:clicked});}
  async stopGeneration(p,assertCurrent=()=>{}){
    assertCurrent();const owner=this.records.get(p.id);if(!owner)throw Error('managed_stop_owner_unavailable');
    this.stopAttempts??=new Map();this.stopClicks??=new Map();
    const key=JSON.stringify([p.id,owner.thread_id||null,owner.latest_request?.id||null]);
    let attempt=this.stopAttempts.get(key);
    if(attempt?.promise)return attempt.promise;
    if(!attempt){
      const selection=selectStopScope(this.records.values(),p.id);
      attempt={targets:selection.targets.map(record=>({record,page:this.pool.pages.get(record.page_id),
        identity:captureStopTarget(record,this.pool.pages.get(record.page_id),id=>this.records.get(id),
          id=>this.pool.pages.get(id),()=>this.connectionGeneration),issueStarted:record.issue_kind==='user_stopped',
        issueConfirmed:record.issue_kind==='user_stopped'&&record.own_paused===true,
        priorStopRequest:record.issue_kind==='user_stopped',observedStarted:false,user:null})),
        unavailable:selection.unavailable,pauseStarted:owner.issue_kind==='user_stopped',
        pauseConfirmed:owner.issue_kind==='user_stopped'&&owner.own_paused===true};
      this.stopAttempts.set(key,attempt);
    }
    const reconcileOnly=attempt.pauseStarted;
    attempt.promise=(async()=>{
      // Mark before awaiting: an accepted/unknown pause is not replayed by a
      // second click. DOM Stop has the same per-original-turn discipline.
      if(!reconcileOnly){assertCurrent();attempt.pauseStarted=true;
        const expected_request_id=['queued','processing','suspended'].includes(owner.latest_request?.phase)?owner.latest_request.id:null;
        await this.runtime.call('pause',{page_id:p.id,paused:true,expected_request_id});
        assertCurrent();attempt.targets[0].identity.assertCurrent();attempt.pauseConfirmed=true;
      }
      // A lost pause receipt is reconciled from the original ledger. A public
      // idle turn alone cannot certify that future dispatch was paused.
      if(reconcileOnly&&!attempt.pauseConfirmed){
        await this.reconcileAll({background:true});
        const current=this.records.get(p.id);
        if(current?.own_paused===true){assertCurrent();attempt.targets[0].identity.assertCurrent();attempt.pauseConfirmed=true;}
      }
      let confirmed=0,pending=attempt.unavailable.length+Number(!attempt.pauseConfirmed);
      await Promise.all(attempt.targets.map(async target=>{
        const {record,page,identity}=target;
        try{
          assertCurrent();identity.assertCurrent();
          if(!loaded(page)){
            if(reconcileOnly)throw Error('managed_stop_original_document_unavailable');
            await this.pool.ensure?.(record.page_id);identity.pinDocument();
          }
          assertCurrent();identity.assertCurrent();
          const wc=page.view.webContents;let snapshot=await this.dom(wc,'snapshot');
          const originalUser=target.user||snapshot.userId;
          if(!originalUser||snapshot.userId!==originalUser||
            (record.phase==='bound'&&snapshot.url!==record.url)||
            (record.latest_request?.sent_user_hash&&hash(originalUser)!==record.latest_request.sent_user_hash))
            throw Error('managed_stop_original_turn_mismatch');
          target.user=originalUser;
          assertCurrent();identity.assertCurrent();
          if(attempt.pauseConfirmed&&!target.issueStarted){target.issueStarted=true;
            await this.runtime.call('page-issue',{page_id:page.id,kind:'user_stopped',detail:'用户已停止网页派发；本地执行保留原记录，需要核对回执。'});
            assertCurrent();identity.assertCurrent();target.issueConfirmed=true;
          }
          if(target.issueStarted&&!target.issueConfirmed){
            const current=this.records.get(record.page_id);
            if(current?.own_paused===true&&current.issue_kind==='user_stopped')target.issueConfirmed=true;
          }
          const clickKey=JSON.stringify([record.page_id,record.thread_id||null,hash(originalUser)]);
          let click=this.stopClicks.get(clickKey);
          if(target.priorStopRequest&&!click){click={state:'unknown',clicked:false};this.stopClicks.set(clickKey,click);}
          if(snapshot.generating&&attempt.pauseConfirmed&&target.issueConfirmed&&!click){
            click={state:'unknown',clicked:false};this.stopClicks.set(clickKey,click);
            const result=await this.dom(wc,'stop');click.clicked=!!result.clicked;click.state='returned';
            assertCurrent();identity.assertCurrent();
          }
          for(let n=0;n<20&&snapshot.generating;n++){
            await this.sleep(250);assertCurrent();identity.assertCurrent();
            snapshot=await this.dom(wc,'snapshot');
            if(snapshot.userId!==originalUser||record.phase==='bound'&&snapshot.url!==record.url)
              throw Error('managed_stop_original_turn_mismatch');
          }
          assertCurrent();identity.assertCurrent();
          if(snapshot.generating){pending++;return;}
          if(attempt.pauseConfirmed&&!target.observedStarted&&record.phase==='bound'&&(click?.clicked||snapshot.stopped)){
            target.observedStarted=true;await this.observeStop(page,snapshot,!!click?.clicked);
          }
          confirmed++;this.pool.running(page.id,false);
        }catch{pending++;}
      }));
      await this.reconcileAll({background:true});return {confirmed,pending,scope_unavailable:attempt.unavailable,
        pause_confirmed:attempt.pauseConfirmed,reconciliation_only:reconcileOnly,local_execution_stopped:false};
    })();
    try{return await attempt.promise;}finally{attempt.promise=null;}
  }
  sendContext(p,baseline,accepted=null){
    const view=p.view,wc=view?.webContents,account=p.account||'B',generation=p.documentGeneration,connection=this.connectionGeneration;
    const manualCurrent=this.manualGuard(p);
    const connector=connectorForAccount(account),url=baseline?.url;
    const recordKey=()=>{
      const r=this.records.get(p.id);
      return r?JSON.stringify([sendBindingKey(r),r.latest_request?.attempt_id]):null;
    };
    const originalRecord=recordKey();
    const acceptedCurrent=()=>{
      if(accepted?.token!==acceptedAttemptToken)return recordKey()===originalRecord;
      const r=this.records.get(p.id),attempt=r?.latest_request?.attempt_id;
      if(sendBindingKey(r)!==accepted.bindingKey||sendHeld(r)||r.latest_request?.id!==accepted.requestId)return false;
      if(attempt===accepted.attemptId){accepted.projected=true;return true;}
      return !accepted.projected&&attempt===accepted.previousAttempt;
    };
    const expectedBaseline={url:baseline.url,userId:baseline.userId,assistantId:baseline.assistantId};
    const requireOpen=()=>{
      manualCurrent();
      if(this.stopped||this.observationQuiesced||this.runtime.closed)throw sendError('workspace_stopping','工作区正在关闭；未再次发送，原请求保留。');
      if(!wc||p.closed||p.view!==view||view.webContents!==wc||wc.isDestroyed?.()||p.documentGeneration!==generation||
         (p.account||'B')!==account||this.connectionGeneration!==connection||!acceptedCurrent()||
         this.pool.pages?.get(p.id)!==p||!url||wc.getURL?.()!==url)
        throw sendError('send_page_identity_changed','原网页、账号或请求身份已变化；未再次发送，原请求保留。');
    };
    return {wc,account,generation,connection,connector,expectedBaseline,requireOpen,...(accepted?{acceptedAttempt:accepted}:{})};
  }
  async acceptedSendContext(p,baseline,options){
    const startedAt=Date.now(),generation=p.documentGeneration,connection=this.connectionGeneration,account=p.account||'B';
    const record=options.record||this.records.get(p.id),requestId=options.requestId||options.request_id,
      attemptId=options.attemptId||options.attempt_id,promptHash=options.prompt_hash||
        (typeof options.prompt==='string'?hash(options.prompt):null);
    try{
    // A list refresh may publish the very attempt accepted by this dispatch.
    // Permit only that one forward projection after proving the original Host
    // binding, accepted attempt and prepared baseline; no other attempt is a
    // compatible change, including one delivered while these reads await.
    if(!record||record.page_id!==p.id||(record.account||'B')!==(p.account||'B')||record.latest_request?.id!==requestId||sendHeld(record)||
       !/^control_[a-f0-9]{32}$/.test(attemptId||'')||!/^[a-f0-9]{64}$/.test(promptHash||'')||
       typeof options.prompt==='string'&&hash(options.prompt)!==promptHash)
      throw sendError('send_attempt_identity_unverified','原受理请求与发送准备身份未核实；未点击发送。');
    const accepted={token:acceptedAttemptToken,bindingKey:sendBindingKey(record),threadId:record.thread_id,
      requestPhase:record.latest_request.phase,requestId,attemptId,
      promptHash,previousAttempt:record.latest_request?.attempt_id,projected:false,verified:false};
    const context=this.sendContext(p,baseline,accepted),check=context.requireOpen;let verifiedRecord;
    const verifyOriginalPrepared=async()=>{
      check();
      const state=await this.runtime.call('list');check();
      const matches=state?.pages?.filter(row=>row.page_id===p.id),current=matches?.length===1?matches[0]:null;
      if(sendBindingKey(current)!==accepted.bindingKey||sendHeld(current)||current.latest_request?.attempt_id!==attemptId)
        throw sendError('send_attempt_identity_unverified','Host 原绑定或受理发送身份已变化；未点击发送。');
      verifiedRecord=current;
      const view=await this.runtime.call('view',{page_id:p.id});check();
      if(view?.page_id!==p.id||view.thread_id!==accepted.threadId||view.latest_request?.id!==requestId||
         view.latest_request?.attempt_id!==attemptId||view.latest_request?.cancel_requested||
         view.latest_request?.phase!==accepted.requestPhase||view.request?.id!==requestId||
         view.request?.phase!==accepted.requestPhase||view.request?.cancel_requested||view.attempt?.id!==attemptId||
         view.attempt.state!=='dispatching'||view.attempt.dispatched==null||view.attempt.acknowledged!=null)
        throw sendError('send_attempt_identity_unverified','原 attempt 已变化或已有发送回执；未点击发送。');
      const prepared=await this.runtime.call('prepared',{page_id:p.id,attempt_id:attemptId});check();
      if(prepared?.attempt_id!==attemptId||prepared.previous_user_hash!==hash(baseline.userId)||
         prepared.assistant_before_hash!==hash(baseline.assistantId)||prepared.prompt_hash!==promptHash)
        throw sendError('send_attempt_identity_unverified','原网页正文基线与已保存发送准备不一致；未点击发送。');
    };
    await verifyOriginalPrepared();
    // Publish the exact proved projection before editing. A later return to
    // the old attempt is no longer compatible, even within an awaited DOM call.
    if(this.records.get(p.id)?.latest_request?.attempt_id!==attemptId)this.records.set(p.id,verifiedRecord);
    accepted.projected=true;check();accepted.verified=true;
    return {...context,verifyOriginalPrepared};
    }catch(error){
      const failure={page_id:p.id,thread_id:record?.thread_id||null,request_id:requestId||null,attempt_id:attemptId||null,
        account,url:baseline.url,document_generation:generation,connection_generation:connection,
        user_turn_sha256:hash(baseline.userId),assistant_turn_sha256:hash(baseline.assistantId),
        marker:attemptId?'[CLW:'+attemptId+']':null,stage:'accepted-host-verification',send_invoked:false,
        started_at:startedAt,at:Date.now(),error_code:error.code||error.message,known_not_sent:false};
      error.sendPreparation=failure;this.sendFailures.set(p.id,failure);
      p.observation={...p.observation,sendPreparation:failure};throw error;
    }
  }
  async prepareConnector(p,baseline,context=this.sendContext(p,baseline)){
    const {wc,account,connector,expectedBaseline,requireOpen}=context;
    requireOpen();this.pool.accountAccessFor?.(account).assertCanStart();
    const initial=await this.dom(wc,'snapshot');requireOpen();
    if(initial.url!==baseline.url||initial.userId!==baseline.userId||initial.assistantId!==baseline.assistantId||
       initial.generating||initial.composing||initial.blocked||initial.approvalRequired||initial.accessLimited||initial.loginRequired)
      throw sendError('send_baseline_changed','发送前网页记录或地址已变化；未点击发送。',initial);
    await selectManagedConnector({dom:this.dom,wc,name:connector,assertCurrent:requireOpen,sleep:this.sleep,expectedBaseline});
    requireOpen();return context;
  }
  async verifyPreparedSend(p,prepared){
    if(prepared?.token!==preparedSendToken||prepared.page!==p)throw Error('send_preparation_identity_changed');
    const {context,prompt,baseline}=prepared,{wc,connector,requireOpen,account}=context;
    requireOpen();this.pool.accountAccessFor?.(account).assertCanStart();
    const s=await this.dom(wc,'snapshot');requireOpen();
    if(s.url!==baseline.url||s.userId!==baseline.userId||s.assistantId!==baseline.assistantId||s.generating||s.composing||
       s.blocked||s.approvalRequired||s.accessLimited||s.loginRequired)
      throw sendError('send_baseline_changed','等待期间原网页记录或状态已变化；原草稿保留，未点击发送。',s);
    const state=await this.dom(wc,'connector-state');requireOpen();assertSelection(state,connector);
    if(!editorEquivalent(prompt,state.text))throw sendError('editor_prompt_mismatch','等待期间原草稿已变化；保留现有正文，未点击发送。',s);
  }
  async admitBootstrap(p){
    try{return await this.runtime.call('bootstrap',{page_id:p.id,state:'sending'});}
    catch(error){
      if(error.message==='managed_bootstrap_waiting_local_slot')error.bootstrapNotAdmitted=true;
      throw error;
    }
  }
  async cacheBootstrapPreparation(p,r,model,prepared){
    prepared.context.requireOpen();
    const before=this.records.get(p.id),beforeKey=before&&bootstrapDraftKey(before);
    if(!before||bootstrapScopeKey(before)!==bootstrapScopeKey(r))throw Error('send_preparation_identity_changed');
    // Read the accepted public-model contract from the original ledger, rather
    // than retaining a pre-bootstrap-model-ready tick row (Latest may resolve
    // to a different concrete version). This is a read of the same reservation.
    const state=await this.runtime.call('list');prepared.context.requireOpen();
    const current=state.pages?.find(row=>row.page_id===p.id);
    if(!current||current.phase!=='reserved'||current.bootstrap_state!=='pending'||current.paused||current.attention||
       bootstrapScopeKey(current)!==bootstrapScopeKey(r)||!samePreparedModel(current.bootstrap_model_selection||current,model))
      throw Error('send_preparation_identity_changed');
    // The list read cannot replace a newer incompatible row delivered while
    // awaiting it. Only the original row or this exact returned contract is
    // compatible with the known bootstrap-model-ready transition.
    const live=this.records.get(p.id),currentKey=bootstrapDraftKey(current),liveKey=live&&bootstrapDraftKey(live);
    if(!live||live.paused||live.attention||live.issue_kind||live.phase!=='reserved'||live.bootstrap_state!=='pending'||
       liveKey!==beforeKey&&liveKey!==currentKey)throw Error('send_preparation_identity_changed');
    const cached={send:prepared,recordKey:bootstrapDraftKey(current),model:JSON.parse(JSON.stringify(model)),admitted:false};
    if(liveKey!==currentKey)this.records.set(p.id,current);
    const original=prepared.context;
    prepared.context={...original,requireOpen:()=>{
      original.requireOpen();const live=this.records.get(p.id);
      if(!live||live.paused||live.attention||live.phase!=='reserved'||
         !['pending',...(cached.admitted?['sending']:[])].includes(live.bootstrap_state)||bootstrapDraftKey(live)!==cached.recordKey)
        throw Error('send_preparation_identity_changed');
    }};
    prepared.context.requireOpen();this.bootstrapPrepared.set(p.id,cached);
  }
  async send(p,prompt,baseline,marker,context=this.sendContext(p,baseline),beforeSend=null,prepared=null){
    if(!marker||!prompt.includes(marker))throw Error('send_identity_required');
    const {wc,account,generation,connector,expectedBaseline,requireOpen}=context;
    const call=async(action,arg={})=>{requireOpen();const result=await this.dom(wc,action,arg);requireOpen();return result;};
    let sendInvoked=false,stage='connector-preparation';const startedAt=Date.now();
    const sendPreparation=()=>({page_id:p.id,thread_id:context.acceptedAttempt?.threadId||null,request_id:context.acceptedAttempt?.requestId||null,
      attempt_id:context.acceptedAttempt?.attemptId||null,account,url:baseline.url,
      document_generation:generation,connection_generation:context.connection,
      user_turn_sha256:hash(baseline.userId),assistant_turn_sha256:hash(baseline.assistantId),
      marker,stage,send_invoked:sendInvoked,started_at:startedAt,at:Date.now()});
    try{
    if(context.acceptedAttempt){
      const accepted=context.acceptedAttempt,suffix='\n'+marker;
      if(accepted.verified!==true||marker!=='[CLW:'+accepted.attemptId+']'||!prompt.endsWith(suffix)||
         hash(prompt.slice(0,-suffix.length))!==accepted.promptHash||baseline.url!==expectedBaseline.url||
         baseline.userId!==expectedBaseline.userId||baseline.assistantId!==expectedBaseline.assistantId)
        throw sendError('send_attempt_identity_unverified','原受理 attempt 的正文、标记或网页基线不一致；未点击发送。');
    }
    p.observation={...p.observation,sendPreparation:sendPreparation()};
    if(prepared){
      if(prepared.context!==context||prepared.prompt!==prompt||prepared.baseline!==baseline||prepared.marker!==marker)
        throw Error('send_preparation_identity_changed');
      await this.verifyPreparedSend(p,prepared);
    }else{
    await this.prepareConnector(p,baseline,context);
    stage='body-preparation';
    await call('focus-editor',{expectedConnector:connector,expectedBaseline});
    requireOpen();
    // CDP Input.insertText can make Lexical treat a newline or Markdown
    // delimiter as live typing. A plain-text edit and exact public composer
    // readback keep the whole prompt together before the single Send click.
    await call('insert-plain-text',{text:prompt.replace(/\r\n/g,'\n'),expectedConnector:connector,expectedBaseline});
    requireOpen();
    }
    let verified=false,observed='';
    stage='body-verification';
    for(let n=0;n<100;n++){
      observed=(await call('editor-text')).text;
      requireOpen();
      if(editorEquivalent(prompt,observed)){verified=true;break;}
      await this.sleep(100);requireOpen();
    }
    if(!verified){
      const s=await call('snapshot');
      if(s.userId&&s.userId!==baseline.userId&&!s.draft)throw sendError('public_send_identity_mismatch','网页已出现不完整的新消息；原请求保留，未再次点击发送。',s);
      const error=sendError('editor_prompt_mismatch',`网页草稿未保留完整提示（预期 ${prompt.length} 字符，读回 ${observed.length} 字符）；未点击发送。`,s);
      // Fresh original host/public proof is applied in the pre-click catch.
      throw error;
    }
    const before=await call('snapshot');
    requireOpen();
    if(before.url!==baseline.url||before.userId!==baseline.userId||before.assistantId!==baseline.assistantId||before.generating||before.composing)
      throw sendError('send_baseline_changed','发送前网页记录或地址已变化；未点击发送。',before);
    // Bootstrap admission/budget is taken only after app and complete body are
    // verified. An input failure therefore preserves the original pending
    // reservation. Accepted/unknown admission still keeps its original receipt.
    if(beforeSend){
      stage='admission';
      try{await beforeSend();}
      catch(error){
        // The backend checks this ordinary resource wait before any bootstrap
        // state/budget mutation. Keep only this process's original fully
        // verified preparation; never infer ownership from a matching draft.
        if(error.bootstrapNotAdmitted===true){
          try{requireOpen();error.preparedSend={token:preparedSendToken,page:p,prompt,baseline,marker,context};}
          catch{/* Definitive rejection is still unsent; changed ownership cannot resume its preparation. */}
        }
        throw error;
      }
      requireOpen();
    }
    // The real connector pill, exact body and original public record are
    // checked together synchronously with the only Send click.
    if(prepared&&!prepared.finalModel)throw Error('send_preparation_model_unverified');
    requireOpen();
    stage='send';
    sendInvoked=true;
    p.observation={...p.observation,sendPreparation:sendPreparation()};
    await this.dom(wc,'send',{expectedText:prompt,expectedConnector:connector,
      expectedBaseline,...(prepared?{expectedModel:prepared.finalModel}:{})});
    // A slow VPN can take longer than five seconds to publish the user turn.
    // Observe for up to 45 seconds; click Send exactly once, regardless of delay.
    for(let n=0;n<180;n++){
      await this.sleep(250);const s=await this.dom(wc,'snapshot');
      if(s.userId&&s.userId!==baseline.userId&&!s.draft){
        // Long ChatGPT messages can append a public “Show more” control after
        // the trailing marker. The DOM snapshot accepts that exact suffix and
        // counts the marker across every visible user unit; endsWith would
        // strand an otherwise confirmed Send as unknown.
        if(marker.startsWith('[CLW:control_')
          ? s.attemptMarker===marker&&s.attemptMarkerCount===1
          : s.userText?.includes(marker)){
          stage='confirmed';p.observation={...p.observation,sendPreparation:sendPreparation()};
          this.sendFailures.delete(p.id);return s;
        }
        if(s.complete&&!s.generating&&s.historyAtLatest!==false)throw sendError('public_send_identity_mismatch','网页已发送缺少原标记的新消息；原请求保留，未重发。',s);
      }
    }
    throw Error('发送结果未知；已保留原记录，未重发。');
    }catch(error){
      // A named, pre-click failure is different from a lost DOM/tool reply.
      // Record known absence only after fresh original public and host identity
      // proof. Keep the query/prompt draft and do not automatically retry it.
      const known=new Set(['connector_composer_unavailable','connector_selection_mismatch','editor_missing_or_user_draft',
        'connector_query_changed','connector_menu_not_unique','connector_not_available','connector_selection_unconfirmed',
        'connector_menu_not_unique_or_query_changed','connector_row_not_unique_or_disabled','editor_prompt_mismatch',
        'editor_focus_failed','editor_selection_missing','editor_selection_foreign','editor_insert_rejected','send_baseline_changed']);
      if(!sendInvoked&&known.has(error.code||error.message)){
        try{
          await context.verifyOriginalPrepared?.();
          requireOpen();const s=await this.dom(wc,'snapshot');requireOpen();
          if(s.url===baseline.url&&s.userId===baseline.userId&&s.assistantId===baseline.assistantId&&!s.generating){
            error.notSent=true;error.snapshot=s;error.sendProof={pageId:p.id,account,url:s.url,userId:s.userId,
              assistantId:s.assistantId,documentGeneration:generation,sendInvoked:false,marker};
          }
        }catch{/* Unknown readback or changed ownership retains the original unknown outcome. */}
      }
      const failure={...sendPreparation(),error_code:error.code||error.message,
        known_not_sent:error.notSent===true};
      error.sendPreparation=failure;this.sendFailures.set(p.id,failure);
      p.observation={...p.observation,sendPreparation:failure};
      throw error;
    }
  }
  async capturePartialPublicSend(p,r,attemptId,s){
    if(r.collaboration_protocol!=='text_v1'||!s?.complete||s.historyAtLatest!==true||!s.userTextComplete||!s.userId||!s.assistantId||s.generating||s.draft||s.composing||s.url!==r.url)return false;
    const prepared=await this.runtime.call('prepared',{page_id:p.id,attempt_id:attemptId});
    if(!prepared.previous_user_hash||!prepared.assistant_before_hash)return false;
    const result=await this.runtime.call('partial-public-send',{
      page_id:p.id,attempt_id:attemptId,url:s.url,previous_user_hash:prepared.previous_user_hash,
      user_hash:hash(s.userId),assistant_before_hash:prepared.assistant_before_hash,assistant_turn_hash:hash(s.assistantId),
      user_text:s.userText,assistant_text:markdown(s.html),user_text_complete:s.userTextComplete,
      complete:!!s.complete,history_at_latest:s.historyAtLatest===true,generating:!!s.generating,draft:!!s.draft,composing:!!s.composing
    });
    if(result?.state==='partial_or_foreign_public_send'){p.status='公开网页消息不完整，原任务待核对';return true;}
    return false;
  }
  tick(r){
    if(this.observationQuiesced||this.stopped||this.disposed)return Promise.resolve();
    return this.trackObservation(this.observePage(r));
  }
  async observePage(r){if(this.busy.has(r.page_id)||this.stopped||this.observationQuiesced)return;this.busy.add(r.page_id);try{
    const p=this.pool.pages.get(r.page_id);if(!loaded(p))return;const originalView=p.view,wc=originalView.webContents,document=p.documentGeneration,connection=this.connectionGeneration;
    if(r.phase!=='reserved'||r.bootstrap_state!=='pending')this.bootstrapPrepared.delete(p.id);
    if(this.isClosed(r.page_id)||p.manualControl)r={...r,paused:true};
    const location=wc.getURL?.();if(location==='about:blank')return;
    if(location&&!location.startsWith('https://chatgpt.com/')){
      if(/^https:\/\/(auth\.openai\.com|auth0\.openai\.com|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com)\//.test(location)){
        p.observation={...p.observation,loginRequired:true};
        await this.reportIssue(p,r,'login_required','网页登录已失效，请本人重新登录后核对原任务；没有重新发送。');
      }
      return;
    }
    let s=await this.dom(wc,'snapshot');
    if(p.manualControl)r={...r,paused:true};
    if(this.stopped||this.observationQuiesced||this.runtime.closed||connection!==this.connectionGeneration||this.pool.pages.get(p.id)!==p||p.view!==originalView||p.documentGeneration!==document||wc.isDestroyed?.())return;
    const access=this.pool.accountAccessFor?.(p.account||r.account||'B');
    if(s.accessLimited)access?.hold();
    const accessHeld=!!access?.read().blocked;
    // A module/resource can delay DOMContentLoaded while the public editor
    // already exists. The isolated read is immediate and all Send guards still
    // require the real editor, controls, exact URL and model observation.
    if(!p.domReady&&s.editor){p.domReady=true;this.pool.layout?.();}
    const visible=s.visibleModel?.model&&s.visibleModel?.effort?s.visibleModel:null;
    const oldModel=p.observation?.model;
    p.observation={...p.observation,at:Date.now(),url:s.url,emptyHomepage:emptyCarrier(s),editorReady:!!s.editor,historyReady:!!s.userId,historyAtLatest:s.historyAtLatest,userTurnHash:s.userId?hash(s.userId):null,attemptId:/^\[CLW:(control_[a-f0-9]{32})\]$/.exec(s.attemptMarker||'')?.[1]||null,generating:!!s.generating,failure:s.failure||null,complete:!!s.complete,approvalRequired:!!s.approvalRequired,draft:!!s.draft,composing:!!s.composing,loginRequired:!!s.loginRequired,
      effortLabel:s.effortLabel||visible?.effort||'',model:visible||((s.effortLabel&&oldModel&&label(s.effortLabel)!==label(oldModel.effort))?null:oldModel)};
    Object.assign(p.observation,{rawStopPresent:!!s.rawStopPresent,streamInterrupted:!!s.streamInterrupted,processingNotice:!!s.processingNotice,publicProcess:s.publicProcess||null});
    p.residentRequired=!!(s.generating||s.rawStopPresent||s.draft||s.composing||s.approvalRequired);
    this.pool.running(p.id,s.generating);
    this.pool.work?.(p.id,!!r.active_work&&!r.paused);
    if(s.loginRequired){await this.reportIssue(p,r,'login_required','网页登录已失效，请本人重新登录后核对原任务；没有重新发送。');return;}
    if(s.usageLimited){
      await this.reportIssue(p,r,'usage_limit','网页显示模型用量限制；保留原模型、上下文和执行，等待额度恢复。');
      // Continue read-only receipt collection for an already accepted turn.
      // Never let a quota notice prevent preserving its completed result.
      r={...r,paused:true};
    }
    if(s.approvalRequired){
      const approval=await this.approveReturnedFile(p,r,s);
      p.observation.fileApproval=approval?.state||'needs_confirmation';
      p.observation.confirmation=approval?{...approval,requestId:r.latest_request?.id||null}:null;
      return; // The next observation collects the original result; never replay its tool.
    }
    if(s.historyAtLatest===false){
      // Never attribute an old Stop/error/result to the current request. Reading
      // the latest public turn costs no model send and must preserve its receipt.
      p.status='等待最新回复进入可见记录';
      const request=r.latest_request;
      const boundWork=r.phase==='bound'&&s.url===r.url&&request&&
        (['processing','suspended'].includes(request.phase)||(!r.paused&&!accessHeld&&request.phase==='queued'));
      // Enrollment may finish while its page is minimized or scrolled a few
      // pixels away from the new reply. Its accepted tool receipt and public
      // marker still need collection, even under a later local pause. Scrolling
      // only reads the owned page; it never retries enrollment or sends text.
      const acceptedEnrollment=r.phase!=='bound'&&['sent','unknown'].includes(r.bootstrap_state)&&/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(s.url);
      if((boundWork||acceptedEnrollment)&&!s.generating&&!s.draft&&!s.composing&&this.pool.isUserViewing?.(p.id)===false){
        const followId=boundWork?request.id:'bootstrap:'+r.page_id;
        const generation=p.documentGeneration||0,viewport=p.metrics||'',now=Date.now();
        const old=p.historyFollow;
        if(!old||old.requestId!==followId||old.url!==s.url||old.documentGeneration!==generation||old.viewportKey!==viewport)
          p.historyFollow={requestId:followId,url:s.url,documentGeneration:generation,viewportKey:viewport,moves:0,retryAt:0};
        const follow=p.historyFollow;
        // A failed early batch must not hide a later result forever. Navigation
        // remains read-only, bounded per batch and forbidden while the user reads.
        if(follow.moves>=3&&now>=follow.retryAt){follow.moves=0;follow.retryAt=0;}
        if(follow.moves<3){
          // Background viewport setup may still be settling. Do not spend the
          // navigation budget before the original setup has completed.
          if(p.viewportReady){
            const ready=await Promise.race([p.viewportReady.then(()=>true,()=>false),this.sleep(1000).then(()=>false)]);
            if(!ready||p.metrics===null)return;
          }
          // The await above can overlap a layout or navigation; the next tick
          // obtains a fresh snapshot for its new document and viewport.
          if(this.stopped||this.runtime.closed||this.pool.pages.get(p.id)!==p||p.view?.webContents!==wc||!loaded(p)||p.closed||
             (p.documentGeneration||0)!==generation||(p.metrics||'')!==viewport||
             (wc.getURL?.()&&wc.getURL()!==s.url)||this.pool.isUserViewing?.(p.id)!==false)return;
          follow.moves++;if(follow.moves>=3)follow.retryAt=Date.now()+30000;
          await this.dom(wc,'show-latest');
        }
      }
      return; // Let virtualization settle, then verify the original turn normally.
    }
    if(s.historyAtLatest===true)p.historyFollow=null;
    if(await this.reconnectFailedStream(p,r,s))return;
    // A later manual reply must remain visible after the first failure paused
    // enrollment. Diagnostic text alone never authorizes recovery.
    if(r.phase!=='bound'&&r.bootstrap_state!=='pending'&&s.complete&&s.assistantId&&s.publicText&&/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(s.url)){
      const publicText=s.publicText.slice(-6000),sourceHash=hash(JSON.stringify([s.url,s.userId,s.assistantId,publicText]));
      if(sourceHash!==r.intake?.latest_public_reply?.source_hash&&sourceHash!==p.intakeReportHash){
        await this.runtime.call('intake-observed',{page_id:p.id,url:s.url,source_hash:sourceHash,public_text:publicText});
        p.intakeReportHash=sourceHash;
      }
    }
    const resumedStop=s.stopped&&r.resumed_stop_user_hash===hash(s.userId);
    if(r.phase==='bound'&&s.stopped&&!resumedStop&&!s.generating){if(r.observed_stop_user_hash!==hash(s.userId))await this.observeStop(p,s);return;}
    // Passive fault reporting also works under an inherited parent pause. It
    // cannot send, reopen a stopped task or acknowledge a local execution.
    if(r.phase==='receiver_enrolled'&&r.first_turn_mode==='task_v1'&&s.failure&&s.historyAtLatest===true&&s.bootstrapMarker===`[CLW-BOOTSTRAP:${p.id}]`&&s.bootstrapMarkerCount===1&&r.latest_request?.phase==='processing'){
      await this.runtime.call('first-task-failed',{page_id:p.id,url:s.url,marker:s.bootstrapMarker,marker_count:s.bootstrapMarkerCount,history_at_latest:true,user_hash:hash(s.userId),failure:s.failure});return;
    }
    if(r.phase!=='bound'&&!r.attention&&(s.failure||(r.phase==='reserved'&&r.bootstrap_state!=='pending'&&s.complete))){
      await this.runtime.call('page-issue',{page_id:p.id,kind:s.failure?'bootstrap_failed':'bootstrap_receipt_missing',detail:s.failure?'网页接入时发生明确错误；原工具执行保留，未重发。\n'+s.failure:'接入回答已结束，但未取得工具接入回执；未重试。\n'+s.publicText.slice(-3000)});return;
    }
    if(r.phase!=='bound'&&!r.attention&&r.bootstrap_state==='unknown'&&s.editor&&!s.generating&&!s.userId){
      await this.runtime.call('page-issue',{page_id:p.id,kind:'bootstrap_receipt_missing',detail:'接入发送状态未知，恢复后未找到原公开网页回执。保留原工具执行，需要核对；未重新发送。'});return;
    }
    if(r.phase==='receiver_enrolled'&&r.first_turn_mode==='task_v1'&&['queued','suspended','completed','blocked'].includes(r.latest_request?.phase)&&
       s.complete&&!s.generating&&!s.failure&&s.historyAtLatest===true&&s.bootstrapMarker===`[CLW-BOOTSTRAP:${p.id}]`&&s.bootstrapMarkerCount===1){
      await this.runtime.call('bind-first-turn',{page_id:p.id,url:s.url,public_text:s.publicText,
        preparation_markdown:markdown(s.html),source_hash:hash(s.assistantId+'\n'+s.publicText),
        history_at_latest:true,public_complete:true,user_marker:s.bootstrapMarker,marker_count:s.bootstrapMarkerCount});return;
    }
    // A local enrollment receipt plus its exact public echo can finish intake
    // under pause. This does not resume business work or issue another Send.
    if(r.phase==='receiver_enrolled'&&r.marker&&s.complete&&!s.generating&&s.publicText?.includes(r.marker)){
      const prepared=r.first_turn_instructions?{preparation_markdown:markdown(s.html),source_hash:hash(s.assistantId+'\n'+s.publicText)}:{};
      await this.runtime.call('bind',{page_id:p.id,url:s.url,public_text:s.publicText,...prepared});return;
    }
    if(r.phase==='receiver_enrolled'&&s.complete&&!s.generating&&!r.attention){
      await this.runtime.call('page-issue',{page_id:p.id,kind:'bootstrap_receipt_missing',detail:'工具已接入，但本轮最终回复缺少原接入标记。请核对原网页，未自动重发。'});return;
    }
    if(r.paused&&r.phase!=='bound')return;
    if(r.phase!=='bound'){
      if(accessHeld)return;
      if(s.failure){await this.runtime.call('page-issue',{page_id:p.id,kind:'bootstrap_failed',detail:'网页接入时发生明确错误。已接受的工具执行与发送记录保留，请核对原回执。\n'+s.failure});return;}
      if(r.phase==='reserved'&&r.bootstrap_state!=='pending'&&s.complete){await this.runtime.call('page-issue',{page_id:p.id,kind:'bootstrap_receipt_missing',detail:'接入回答已结束，但未取得工具接入回执。未自动重试。\n'+s.publicText.slice(-3000)});return;}
      const waitingDraft=this.bootstrapPrepared.get(p.id);
      if(r.phase==='reserved'&&r.bootstrap_state==='pending'&&s.editor&&s.controlKnown&&!s.generating&&(!s.draft||waitingDraft)&&!s.composing){
        if(r.bootstrap_wait){p.status='等待工作目录空闲 · 尚未发送';return;}
        if(waitingDraft){
          let admissionInvoked=false;
          try{
            waitingDraft.send.context.requireOpen();
            await this.verifyPreparedSend(p,waitingDraft.send);
            // Read the original choice without restoring a user-changed model
            // while a prepared draft is waiting in the composer.
            const model=await this.inspect(p,waitingDraft.send.context.requireOpen);
            waitingDraft.send.context.requireOpen();
            if(!samePreparedModel(model,waitingDraft.model))throw Error('send_preparation_model_changed');
            const prepared=waitingDraft.send;
            await this.send(p,prepared.prompt,prepared.baseline,prepared.marker,prepared.context,async()=>{
              admissionInvoked=true;
              await this.admitBootstrap(p);
              waitingDraft.admitted=true;prepared.context.requireOpen();
              const final=await this.inspect(p,prepared.context.requireOpen,{keepMenuOpen:true,expectedBaseline:prepared.context.expectedBaseline});
              prepared.context.requireOpen();
              if(!samePreparedModel(final,waitingDraft.model))throw Error('send_preparation_model_changed');
              prepared.finalModel={model:final.model,effort:final.effort,selection:final.selection?.slice()};
            },prepared);
            this.bootstrapPrepared.delete(p.id);
            await this.runtime.call('bootstrap',{page_id:p.id,state:'sent'});
          }catch(e){
            if(e.bootstrapNotAdmitted===true){
              if(e.preparedSend)waitingDraft.send=e.preparedSend;else this.bootstrapPrepared.delete(p.id);
              p.status='等待工作目录空闲 · 尚未发送';return;
            }
            this.bootstrapPrepared.delete(p.id);
            if(!admissionInvoked){
              await this.runtime.call('page-issue',{page_id:p.id,kind:'control_failed',detail:e.message+' 原准备稿已变化或无法核对；现有草稿保留，未自动发送。'});return;
            }
            await this.runtime.call('bootstrap',{page_id:p.id,state:'unknown'}).catch(()=>{});throw e;
          }
          return;
        }
        const failure=this.failures.get(p.id);if(failure&&Date.now()<failure.next)return;
        const enrollment=r.bootstrap_model_selection;
        const expected=enrollment?{model:enrollment.model,effort:enrollment.effort,model_selection:enrollment}:r;
        if(/\bpro\b/i.test(expected.model+' '+expected.effort)&&!String(r.first_turn_instructions||'').trim()){
          await this.runtime.call('page-issue',{page_id:p.id,kind:'preparation_required',detail:'这条接入没有主控的首轮研究或方案要求，不能独占一次 Pro。请核对接入模型与任务内容；消息尚未发送，工作模型没有降档。'});return;
        }
        let selected,followSetup;try{
          followSetup=setupLatestBootstrap(r,expected);
          selected=await this.selectModel(p,expected,followSetup?{followPageSelection:true,bootstrapRecord:r}:{});
          if(followSetup){
            // Re-read the owned public menu before authorizing the first Send.
            // A stale picker or a changed choice cannot use the setup exception.
            selected=await this.verifySetupLatest(p,r,expected,selected);
          }
          this.failures.delete(p.id);
        }catch(e){
          const count=(failure?.count||0)+1;this.failures.set(p.id,{count,next:Date.now()+[1500,4000,15000][Math.min(count-1,2)]});
          if(e.code!=='worker_model_unavailable'&&count<3)throw e;
          await this.runtime.call('page-issue',{page_id:p.id,kind:e.code==='worker_model_unavailable'?'model_unavailable':'control_failed',detail:(e.code==='worker_model_unavailable'?'':'网页模型菜单经过 3 次核对仍未就绪；接入尚未发送。')+e.message});return;}
        await this.runtime.call('bootstrap-model-ready',{page_id:p.id,model_selection:selected});
        if(followSetup){
          // The durable observation call may await its owner. Recheck after its
          // reply so a manual menu change during that wait never authorizes Send.
          try{selected=await this.verifySetupLatest(p,r,expected,selected);}
          catch(e){await this.runtime.call('page-issue',{page_id:p.id,kind:e.code==='worker_model_unavailable'?'model_unavailable':'control_failed',detail:e.message});return;}
        }
        // Establish the actual app before reserving a bootstrap Send/budget.
        // A known menu failure leaves the original unsent reservation pending;
        // selection never clears a draft or becomes an unknown model Send.
        let connectorContext;
        try{connectorContext=await this.prepareConnector(p,s);}
        catch(e){await this.runtime.call('page-issue',{page_id:p.id,kind:'control_failed',detail:e.message+' 首轮尚未点击发送；原输入框保留。'});return;}
        let bootstrapAdmissionInvoked=false;
        try{
          const marker=`[CLW-BOOTSTRAP:${p.id}]`;
          await this.send(p,r.bootstrap_text+'\n'+marker,s,marker,connectorContext,async()=>{
            bootstrapAdmissionInvoked=true;
            await this.admitBootstrap(p);
          });
          await this.runtime.call('bootstrap',{page_id:p.id,state:'sent'});
        }catch(e){
          if(e.bootstrapNotAdmitted===true){
            if(e.preparedSend){
              try{await this.cacheBootstrapPreparation(p,r,selected,e.preparedSend);}
              catch(error){await this.runtime.call('page-issue',{page_id:p.id,kind:'control_failed',detail:error.message+' 原待发送记录无法核对；原草稿保留，未自动发送。'});return;}
            }
            p.status='等待工作目录空闲 · 尚未发送';return;
          }
          if(!bootstrapAdmissionInvoked){
            await this.runtime.call('page-issue',{page_id:p.id,kind:'control_failed',detail:e.message+' 首轮尚未点击发送；原草稿与待接入记录保留，未自动重发。'});return;
          }
          await this.runtime.call('bootstrap',{page_id:p.id,state:'unknown'}).catch(()=>{});throw e;
        }}
      return;
    }
    if(s.url!==r.url){
      if(p.manualControl){p.status='你正在浏览其他对话 · 原任务已保留';return;}
      if(r.conversation_mode==='direct'){
        const rebound=await this.bindDirectCarrier(p,r,s);if(rebound)r=rebound;
      }
      if(sameRecovery(r)&&r.carrier_recovery.attempt_id){
        const rebound=await this.bindRecoveredCarrier(p,r,s);
        if(rebound)r=rebound;
      }
      if(s.url!==r.url){
        const recovered=!accessHeld?await this.recoverEmptyCarrier(p,r,s):null;
        if(recovered&&sameRecovery(recovered)&&emptyCarrier(s))r=recovered;
        else {p.status='网页地址变化，需要核对';return;}
      }
    }
    const emptyRestored=sameRecovery(r)&&emptyCarrier(s);
    // Waiting/long thinking causes no new model send and no failure timeout.
    if(s.blocked){await this.runtime.call('page-issue',{page_id:p.id,kind:'usage_limit',detail:'网页提示登录或用量限制，已暂停自动派发，未更换账号或模型。'});return;}
    const originalRequest=r.latest_request,originalAttempt=originalRequest?.attempt_id;
    if(s.generating&&!s.draft&&!s.composing&&!s.stopped&&s.editor&&s.controlKnown&&s.historyAtLatest!==false&&s.userId&&
       originalRequest?.id&&!originalRequest.cancel_requested&&!originalRequest.sent_user_hash&&
       ['queued','processing','suspended'].includes(originalRequest.phase)&&/^control_[a-f0-9]{32}$/.test(originalAttempt||'')&&
       s.attemptMarker===`[CLW:${originalAttempt}]`&&s.attemptMarkerCount===1){
      // Receipt collection is independent of waiting for the model to finish.
      // This read cannot create an offer or Send. Keep the exact accepted
      // request, document and prepared baseline across both awaited reads.
      const originalBinding=sendBindingKey(r),originalAccount=p.account||r.account||'B',originalChild=this.runtime.child;
      const current=()=>{const record=this.records.get(p.id);return !this.stopped&&!this.observationQuiesced&&!this.runtime.closed&&
        this.runtime.child===originalChild&&connection===this.connectionGeneration&&this.pool.pages.get(p.id)===p&&
        p.view===originalView&&p.documentGeneration===document&&!wc.isDestroyed?.()&&wc.getURL?.()===s.url&&
        (p.account||record?.account||'B')===originalAccount&&sendBindingKey(record)===originalBinding&&
        record?.latest_request?.attempt_id===originalAttempt&&!record.latest_request.cancel_requested;};
      if(!current())return;
      const receipt=await this.runtime.call('pending-receipt',{page_id:p.id,url:s.url});
      if(!current())return;
      if(['original_attempt_requires_reconciliation','model_received_browser_confirmation_pending'].includes(receipt?.state)&&
         receipt.attempt_id===originalAttempt){
        const prepared=await this.runtime.call('prepared',{page_id:p.id,attempt_id:originalAttempt});
        if(!current())return;
        const pending=this.pending.get(p.id);
        if(prepared?.attempt_id!==originalAttempt||!/^[a-f0-9]{64}$/.test(prepared.previous_user_hash||'')||
           prepared.previous_user_hash===hash(s.userId)||!/^[a-f0-9]{64}$/.test(prepared.assistant_before_hash||'')||
           !/^[a-f0-9]{64}$/.test(prepared.prompt_hash||'')||
           receipt.assistant_before_hash&&receipt.assistant_before_hash!==prepared.assistant_before_hash||
           pending&&(pending.attempt!==originalAttempt||pending.assistantBefore!==prepared.assistant_before_hash)){
          p.status='原发送基线待核对';return;
        }
        await this.wire(r,'sent',this.pageState(s,{model:r.model,effort:r.effort}),{
          attempt_id:originalAttempt,assistant_before_hash:prepared.assistant_before_hash});
        this.sendFailures.delete(p.id);this.failures.delete(p.id);p.observation.error=null;
        return;
      }
    }
    if(s.generating||s.draft||s.composing)return;
    if(r.attention&&r.paused&&!accessHeld&&s.complete&&s.historyAtLatest===true&&s.attemptMarkerCount===1&&/^\[CLW:control_[a-f0-9]{32}\]$/.test(s.attemptMarker||'')){
      await this.runtime.call('recover-ended-turn',{page_id:p.id,attempt_id:s.attemptMarker.slice(5,-1),browser:{
        page_id:p.id,url:s.url,at:Date.now(),attempt_id:s.attemptMarker.slice(5,-1),marker_count:s.attemptMarkerCount,
        user_hash:hash(s.userId),history_at_latest:s.historyAtLatest===true,complete:!!s.complete,generating:!!s.generating,
        loginRequired:!!s.loginRequired,approvalRequired:!!s.approvalRequired,draft:!!s.draft,composing:!!s.composing}});
      return;
    }
    if(r.work_model_pending&&!accessHeld&&!r.paused){
      if(!s.editor||!s.controlKnown)return;
      const failure=this.failures.get(p.id);if(failure&&Date.now()<failure.next)return;
      try{
        const selected=await this.selectModel(p,r);
        await this.runtime.call('work-model-ready',{page_id:p.id,model_selection:selected});
        p.modelRestorePending=false;
        this.failures.delete(p.id);p.observation.error=null;
      }catch(e){
        const count=(failure?.count||0)+1;this.failures.set(p.id,{count,next:Date.now()+[1500,4000,15000][Math.min(count-1,2)]});
        if(e.code==='worker_model_unavailable'||count>=3)await this.runtime.call('page-issue',{page_id:p.id,kind:e.code==='worker_model_unavailable'?'model_unavailable':'control_failed',detail:'项目已接入，但工作模型尚未确认；没有用接入模型代替工作模型发送目标。'+e.message});
        else throw e;
      }
      return;
    }
    // Health/result polling must not keep opening a menu in front of the user.
    // Verify the public picker immediately before an actual Send instead.
    // A normal bound conversation has its enrollment turn. The editor can
    // appear before history after slow navigation; do not offer/dispatch against
    // an empty baseline or spend control retries while those turns are loading.
    // Only the exact, persisted unadmitted-first-task carrier descriptor uses
    // the verified empty homepage baseline through the original dispatch path.
    const emptyDirect=r.conversation_mode==='direct'&&r.url==='https://chatgpt.com/'&&emptyCarrier(s);
    if(!s.userId&&!emptyRestored&&!emptyDirect){p.status='等待对话记录加载';return;}
    const model={model:r.model,effort:r.effort};const page=this.pageState(s,model);
    let pending=this.pending.get(p.id);const state=r.paused
      ?await this.runtime.call('pending-receipt',{page_id:p.id,url:s.url})
      :await this.wire(r,'pulse',page,s.failure?{public_failure:{url:s.url,marker:s.attemptMarker,marker_count:s.attemptMarkerCount,history_at_latest:s.historyAtLatest,terminal_failure:s.failure}}:{});
    if(this.observationQuiesced||this.stopped)return;
    if(state.state!=='offer'){p.observation.error=null;this.failures.delete(p.id);}
    if(['original_attempt_requires_reconciliation','model_received_browser_confirmation_pending'].includes(state.state)){
      // A crash after Send can only be reconciled against an observed unique
      // user turn carrying the exact durable attempt marker. Never resubmit.
      const marker=`[CLW:${state.attempt_id}]`;
      if(s.userId&&s.attemptMarker===marker&&s.attemptMarkerCount===1){const prepared=await this.runtime.call('prepared',{page_id:p.id,attempt_id:state.attempt_id});await this.wire(r,'sent',page,{attempt_id:state.attempt_id,assistant_before_hash:prepared.assistant_before_hash});}
      else if(state.state==='original_attempt_requires_reconciliation'&&await this.capturePartialPublicSend(p,r,state.attempt_id,s))return;
      else p.status='发送待核对';return;
    }
    if(state.state==='offer'){
      if(accessHeld||r.paused||p.manualControl||s.rawStopPresent===true)return; // Still collect already accepted replies below; never submit new work.
      const manualCurrent=this.manualGuard(p);
      const failure=this.failures.get(p.id);if(failure&&Date.now()<failure.next)return;
      let selected,grant;
      try{
      // A restored document may remember a different selection. Observe it;
      // only an explicit model-setting action is allowed to change it.
      const generation=p.documentGeneration;
      manualCurrent();selected=await this.inspect(p,manualCurrent);manualCurrent();
      s=await this.dom(wc,'snapshot');manualCurrent();
      if(p.documentGeneration!==generation||(s.url!==r.url&&!sameRecovery(r))||
        !s.editor||!s.controlKnown||s.generating||s.draft||s.composing)return;
      if(!sameModel(selected.model,r.model)||!sameEffort(selected.effort,r.effort)){
        await this.runtime.call('page-issue',{page_id:p.id,kind:'model_mismatch',detail:'任务设定为 '+r.model+' / '+r.effort+'，网页现为 '+selected.model+' / '+selected.effort+'。消息尚未发送。请在任务设置核对并采用网页设置，或在网页选回原设置，再恢复。'});
        return;
      }
      access?.assertCanStart();
      if(this.observationQuiesced||this.stopped)return;
      manualCurrent();grant=await this.wire(r,'dispatch',this.pageState(s,selected),{attempt_id:state.attempt_id});
      }catch(e){
        if(e.code==='manual_control')return;
        if(e.code==='account_access_cooldown')return;
        if(e.code==='worker_model_unavailable'){
          await this.reportIssue(p,r,'model_unavailable',e.message);return;
        }
        const count=(failure?.count||0)+1;this.failures.set(p.id,{count,next:Date.now()+[1500,4000,15000][Math.min(count-1,2)]});
        if(count>=3)await this.runtime.call('page-issue',{page_id:p.id,kind:'control_failed',detail:'发送准备连续 3 次失败，已暂停自动核对。原消息与回执保留，未创建替代请求。原因：'+e.message});
        throw e;
      }
      this.failures.delete(p.id);p.observation.error=null;if(!grant.dispatch)return;
      pending={attempt:state.attempt_id,assistantBefore:hash(s.assistantId)};this.pending.set(p.id,pending);
      try{manualCurrent();}catch{return;} // Preserve the original accepted grant for reconciliation.
      if(this.observationQuiesced||this.stopped)return; // An already accepted grant remains original and unresolved.
      await this.runtime.call('prepare',{page_id:p.id,attempt_id:state.attempt_id,assistant_before_hash:pending.assistantBefore,prompt_hash:hash(grant.prompt)});
      const marker=`[CLW:${state.attempt_id}]`;let sent;
      try{
        if(grant.attempt_id!==state.attempt_id)throw sendError('send_attempt_identity_unverified','受理 grant 与原 offer 的 attempt 不一致；未点击发送。');
        const context=await this.acceptedSendContext(p,s,{record:r,requestId:state.request_id,
          attemptId:grant.attempt_id,prompt:grant.prompt});
        sent=await this.send(p,grant.prompt+'\n'+marker,s,marker,context);
      }
      catch(e){
        if(e.notSent===true){
          await this.wire(r,'finish',null,{attempt_id:state.attempt_id,result:'not_sent'});
          await this.runtime.call('page-issue',{page_id:p.id,kind:'control_failed',detail:e.message+' 原消息保留，可撤回后修正；没有自动重发。'});
          this.pending.delete(p.id);return;
        }
        if(e.code==='public_send_identity_mismatch'&&await this.capturePartialPublicSend(p,r,state.attempt_id,e.snapshot))return;
        throw e;
      }
      if(sameRecovery(r)){
        const rebound=await this.bindRecoveredCarrier(p,r,sent,state.attempt_id);
        if(!rebound){p.status='原发送已点击 · 等待新对话地址与原标记';return;}
        r=rebound;
      }
      if(r.conversation_mode==='direct'&&sent.url!==r.url){
        const rebound=await this.bindDirectCarrier(p,r,sent,state.attempt_id);
        if(!rebound){p.status='原发送已点击 · 等待新对话地址与原标记';return;}r=rebound;
      }
      await this.wire(r,'sent',this.pageState(sent,model),{attempt_id:state.attempt_id,assistant_before_hash:pending.assistantBefore});return;
    }
    if(state.state==='browser_result_pending'&&(s.failure||(s.complete&&s.assistantId))&&page.user_hash!==state.sent_user_hash){
      // ChatGPT can replace optimistic/group DOM ids after a saved-page reload.
      // A tool_v1 turn still needs its independent tool outcome. text_v1 has
      // no tool outcome by design, so send the completed public turn identity
      // for the backend's separate protocol-specific checks.
      if(s.attemptMarker===`[CLW:${state.attempt_id}]`&&s.attemptMarkerCount===1){
        await this.runtime.call('reconcile-user',{page_id:p.id,url:s.url,attempt_id:state.attempt_id,previous_user_hash:state.sent_user_hash,user_hash:page.user_hash,marker:s.attemptMarker,marker_count:s.attemptMarkerCount,
          complete:!!s.complete,history_at_latest:s.historyAtLatest===true,assistant_turn_hash:hash(s.assistantId),terminal_failure:s.failure||''});
      }else p.status='原网页消息身份需要核对';
      return;
    }
    if(state.state==='browser_result_pending'&&s.complete&&s.assistantId&&hash(s.assistantId)!==state.assistant_before_hash&&page.user_hash===state.sent_user_hash){
      if(this.completed.has(state.attempt_id))return;const content=markdown(s.html);if(!content)return;
      const signature=hash(s.assistantId+'\n'+content);const prior=this.resultCandidates.get(state.attempt_id);if(!prior||prior.signature!==signature){this.resultCandidates.set(state.attempt_id,{signature,at:Date.now()});return;}if(Date.now()-prior.at<1500)return;
      const artifact=await this.runtime.call('artifact',{page_id:p.id,attempt_id:state.attempt_id,text:content,assistant_turn_hash:hash(s.assistantId)});
      const result=await this.wire(r,'result',page,{attempt_id:state.attempt_id,assistant_turn_hash:hash(s.assistantId),text:content.length<=46000?content:content.slice(0,1000)+`\n\n完整原文：[Markdown](${artifact.path})\nSHA256: ${artifact.sha256}\n请读取完整文件后再整合。`});
      if(['completed','yielded','needs_attention'].includes(result.state)){this.completed.add(state.attempt_id);this.pending.delete(p.id);this.resultCandidates.delete(state.attempt_id);this.pool.running(p.id,false);}
    }
  }finally{this.busy.delete(r.page_id);}}
  stop(){this.stopped=true;this.connectionGeneration++;this.monitorVersion++;this.monitorEnabled=false;this.bootstrapPrepared.clear();clearTimeout(this.timer);this.timer=null;this.restorePromise=null;this.monitorCycle=null;}
  dispose(){if(this.disposed)return;this.stop();this.disposed=true;this.pool.removeListener?.('manual-interaction',this.onManualInteraction);this.runtime.removeListener('ready',this.onRuntimeReady);this.runtime.removeListener('disconnected',this.onRuntimeDisconnected);}
}
module.exports={WebDriver,protectedTurn,knownIdleSnapshot,returnedFileApprovalTask};
