/* Unified CLW Web Companion. Page never receives project credentials or task bodies. */
'use strict';
importScripts('policy.js','control-policy.js','managed-window.js');
importScripts('page-monitor-worker.js');
importScripts('local-control.js');
const ENDPOINT='http://127.0.0.1:18944/api/harness/control-wire';
const RECOVERY_ENDPOINT='http://127.0.0.1:18944/api/harness/recovery-wire';
const key=id=>'clwUnifiedTab:'+id,recoveryKey=id=>'clwRecoveryTab:'+id,KNOWN_KEY='clwKnownChatUrls',BACKGROUND_ALARM='clw-background-bound-scan',queues=new Map();
const monitorBadges=new Map();
function monitorBadge(id,state){
  if(!Number.isInteger(id)||!chrome.action)return;
  const attention=['paused','exhausted','unknown','dispatching'].includes(state.state)||state.reason==='connection_wait_long'||/^reload_(unknown|failed|not_confirmed|limit_reached)$/.test(state.reason||''),stopped=state.bound===false||['unbound','stopped'].includes(state.state);
  const text=stopped?'':attention?'!':state.observer_recent===false?'?':'•';
  const title=stopped?'CLW：监护当前原网页对话':attention?'CLW：监护需要处理，请打开扩展查看':text==='?'?'CLW：等待新鲜页面观察':'CLW：当前页监护中';
  if(monitorBadges.get(id)===text+title)return;monitorBadges.set(id,text+title);
  void Promise.allSettled([chrome.action.setBadgeText?.({tabId:id,text}),chrome.action.setBadgeBackgroundColor?.({tabId:id,color:attention?'#be505d':'#8c66d8'}),chrome.action.setTitle?.({tabId:id,title})]);
}
function queueTab(id,fn){
  const previous=queues.get(id)||Promise.resolve();
  const current=previous.catch(()=>{}).then(fn);queues.set(id,current);
  const cleanup=()=>{if(queues.get(id)===current)queues.delete(id);};current.then(cleanup,cleanup);
  return current;
}
const storageReady=Promise.all([chrome.storage.session?.setAccessLevel?chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}):Promise.resolve(),chrome.storage.local?.setAccessLevel?chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}):Promise.resolve()]);
void storageReady.then(async()=>{await CLWManagedWindow.restore();await backgroundBoot();if(chrome.runtime.id)CLWLocalControl.start();}).catch(()=>{});
async function injectMonitor(id,generation,documentId=null){
  const target={tabId:id,...(documentId?{documentIds:[documentId]}:{})};
  await chrome.scripting.executeScript({target,files:['page-monitor-page.js']});
  // The first observation returns through this worker's per-tab queue. Do not
  // hold that queue waiting for the observation we are about to enqueue.
  await chrome.scripting.executeScript({target,func:g=>{void globalThis.CLWPageMonitorPage.start(g).catch(()=>{});return {observer_start_requested:true};},args:[generation]});
}
async function resumeReload(tab){
  const resume=await CLWPageMonitorWorker.resumeAfterReload(tab.id);
  if(!resume)return false;
  await injectMonitor(tab.id,resume.generation);return true;
}
async function performReload(reload){
  let attempted=false;
  try{
    const tab=await chrome.tabs.get(reload.tabId);if(tab.url!==reload.chatUrl||tab.pendingUrl||!reload.documentId)throw Error('monitor_reload_page_changed');
    attempted=true;
    const returned=(await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[reload.documentId]},func:async(url,user,progress)=>globalThis.CLWPageMonitorPage.reloadIfIdle(url,user,progress),args:[reload.chatUrl,reload.user_key,reload.progress_key]}))[0]?.result;
    if(returned?.reload_requested===false){
      const state=await CLWPageMonitorWorker.cancelReload(tab.id,reload.generation,returned.snapshot);
      if(state&&!state.state?.includes('paused'))await injectMonitor(tab.id,reload.generation,reload.documentId);
      return;
    }
    await CLWPageMonitorWorker.finishReload(tab.id,reload.generation,returned?.reload_requested===true?'requested':'unknown');
  }
  catch(e){await CLWPageMonitorWorker.finishReload(reload.tabId,reload.generation,attempted?'unknown':'failed');throw e;}
}
async function executeLocalCommand(command){
  await storageReady;
  return queueTab(command.tabId,async()=>{
    const tab=await chrome.tabs.get(command.tabId);
    if(tab.url!==command.chatUrl||tab.pendingUrl||!CLWRecoveryPolicy.isChat(tab.url))throw Error('operator_original_page_changed');
    if(command.type==='reload_extension'){
      chrome.runtime.reload();
      return {state:'unknown',result:{extension_reload_requested:true,verify_next_instance_and_version:true}};
    }
    const control=(action)=>CLWPageMonitorWorker.control(action,tab.id,tab.url);
    if(command.type==='unwatch'){
      const stopped=await control('stop');
      // Background cancellation must not wait for a frozen page's renderer.
      void chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>globalThis.__clwPageMonitorStop?.()}).catch(()=>{});
      return {state:'completed',result:stopped};
    }
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['page-monitor-page.js']});
    const inspection=(await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>globalThis.CLWPageMonitorPage.inspect()}))[0];
    if(!inspection?.documentId||inspection.result?.url!==tab.url||command.documentId&&command.documentId!==inspection.documentId)throw Error('operator_original_document_changed');
    const target={tabId:tab.id,documentIds:[inspection.documentId]};
    if(command.type==='inspect')return {state:'completed',result:{documentId:inspection.documentId,...inspection.result,monitor:await control('status')}};
    if(command.type==='approve_tool'){
      const result=(await chrome.scripting.executeScript({target,func:async(url,user)=>globalThis.CLWPageMonitorPage.approveMcpTool(url,user),args:[tab.url,inspection.result.snapshot.user_key]}))[0]?.result;
      if(!result)throw Error('operator_approval_result_unknown');
      return result;
    }
    if(command.type==='watch'){
      const state=await control('start');await injectMonitor(tab.id,state.generation,inspection.documentId);
      return {state:'completed',result:await control('status')};
    }
    if(command.type==='stop_generation'){
      await chrome.scripting.executeScript({target,func:()=>globalThis.__clwPageMonitorStop?.()});await control('stop');
      const r=(await chrome.scripting.executeScript({target,func:url=>globalThis.CLWPageMonitorPage.stopGeneration(url),args:[tab.url]}))[0];
      return {state:'completed',result:r.result};
    }
    const state=await control('status');
    if(state.pending_result&&state.pending_result!=='planned')throw Error('operator_original_send_requires_reconciliation');
    if(state.reload_state)throw Error('operator_original_reload_requires_reconciliation');
    if(command.type==='reload'){
      const current=await chrome.tabs.get(tab.id);if(current.url!==tab.url||current.pendingUrl)throw Error('operator_original_page_changed');
      await chrome.tabs.reload(tab.id);return {state:'completed',result:{reload_scheduled:true,new_document_verified:false,chatUrl:tab.url}};
    }
    if(command.type!=='continue'&&command.type!=='send')throw Error('operator_command_unknown');
    const text=command.type==='continue'?(command.payload.text||CLWPageMonitorWorker.PROMPT):command.payload.text;
    // The broker claimed this explicit command once. It is never reissued by
    // reconnecting the peer; the original receipt must resolve an unknown send.
    await control('stop');
    const sent=(await chrome.scripting.executeScript({target,func:async(text,url,user)=>globalThis.CLWPageMonitorPage.sendText(text,url,user),args:[text,tab.url,inspection.result.snapshot.user_key]}))[0]?.result;
    if(!sent)throw Error('operator_send_result_unknown');
    if(sent.state==='completed'){
      const next=await control('start');await injectMonitor(tab.id,next.generation,inspection.documentId);
      sent.result.monitor=await control('status');
    }
    return sent;
  });
}
CLWLocalControl.configure({execute:executeLocalCommand});
async function wire(body,token){
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),10000);
  try{
    const r=await fetch(ENDPOINT,{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json',...(token?{'X-CLW-Control':token}:{})},body:JSON.stringify(body),signal:c.signal});
    const text=await r.text();if(text.length>262144)throw Error('control_response_too_large');
    const v=JSON.parse(text);if(!r.ok||v.success!==true)throw Error(v.code||'control_unconfirmed');return v;
  }finally{clearTimeout(timer);}
}
async function recoveryWire(body,token){
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),10000);
  try{
    const r=await fetch(RECOVERY_ENDPOINT,{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json',...(token?{'X-CLW-Recovery':token}:{})},body:JSON.stringify(body),signal:c.signal});
    const text=await r.text();if(text.length>16000)throw Error('recovery_response_too_large');
    const v=JSON.parse(text);if(!r.ok||v.success!==true)throw Error(v.code||'recovery_not_confirmed');return v;
  }finally{clearTimeout(timer);}
}
const stableTab=tab=>!!tab&&!tab.discarded&&!tab.frozen&&!tab.pendingUrl&&tab.status!=='loading'&&CLWControlPolicy.isChat(tab.url||'');
async function transportActive(tab){
  if(!stableTab(tab)||tab.active!==true||!Number.isInteger(tab.windowId))return false;
  try{const w=await chrome.windows.get(tab.windowId);return w.type==='normal'&&w.state!=='minimized'&&w.focused===false;}catch{return false;}
}
async function attestPage(tab,page){return {...page,visible:page?.visible===true||await transportActive(tab)};}
async function knownPages(){return (await chrome.storage.local.get(KNOWN_KEY))[KNOWN_KEY]||{};}
async function rememberPage(url,meta){
  const all=await knownPages();all[url]={title:meta.title||'CLW Web 对话',model_label:meta.model_label||'',effort_label:meta.effort_label||''};
  await chrome.storage.local.set({[KNOWN_KEY]:all});
}
async function forgetPage(url){const all=await knownPages();if(Object.hasOwn(all,url)){delete all[url];await chrome.storage.local.set({[KNOWN_KEY]:all});}}
async function injectPassive(tab,reset=false){
  if(!stableTab(tab))throw Error('control_background_tab_not_ready');
  if(reset)await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{globalThis.__clwControlStop?.();globalThis.__clwRecoveryStop?.();globalThis.__clwBackgroundBridgeCleanup?.();globalThis.__clwControlPageCleanup?.();delete globalThis.CLWControlPage;delete globalThis.__clwBackgroundBridgeInstalled;}});
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['control-policy.js','control-page.js','enrollment-page.js','background-bridge.js']});
}
async function injectProofBridge(tab){
  if(!stableTab(tab))throw Error('control_background_tab_not_ready');
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['enrollment-page.js','background-bridge.js']});
}
async function proofProbe(tab){
  if(!stableTab(tab))throw Error('control_background_tab_not_ready');
  let result;
  try{result=await chrome.tabs.sendMessage(tab.id,{type:'clw-background-probe'});}catch{await injectProofBridge(tab);result=await chrome.tabs.sendMessage(tab.id,{type:'clw-background-probe'});}
  if(!result||result.url!==tab.url)throw Error('control_background_probe_unconfirmed');
  return result.proof||null;
}
async function passiveProbe(tab){
  if(!stableTab(tab))throw Error('control_background_tab_not_ready');
  let result;
  try{result=await chrome.tabs.sendMessage(tab.id,{type:'clw-background-probe'});}catch{await injectPassive(tab);result=await chrome.tabs.sendMessage(tab.id,{type:'clw-background-probe'});}
  if(result?.stale){await injectPassive(tab,true);result=await chrome.tabs.sendMessage(tab.id,{type:'clw-background-probe'});}
  else if(result?.needs_page){await injectPassive(tab);result=await chrome.tabs.sendMessage(tab.id,{type:'clw-background-probe'});}
  if(!result||result.url!==tab.url||result.stale)throw Error('control_background_probe_unconfirmed');
  return result;
}
async function startObserver(tab){if(!stableTab(tab))throw Error('control_background_tab_not_ready');await chrome.scripting.executeScript({target:{tabId:tab.id},files:['control-content.js']});}
function normalizedProof(proof){
  if(!proof)return {};
  if(typeof proof.enrollment==='string'&&/^CLW-ENROLL:[0-9a-f]{32}:[A-Za-z0-9_-]{32}$/.test(proof.enrollment))return {enrollment:proof.enrollment};
  if(typeof proof.enrollment_ticket==='string'&&/^clwi_[A-Za-z0-9_-]{43}$/.test(proof.enrollment_ticket))return {enrollment_ticket:proof.enrollment_ticket};
  throw Error('team_background_enrollment_proof_invalid');
}
async function autoBind(tab,proof=null,known=false){
  if(!stableTab(tab))return {state:'background_tab_not_ready'};
  if(await CLWPageMonitorWorker.isBound(tab.id))return {state:'manual_page_monitor_owns_page'};
  const prior=(await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
  if(prior&&prior.chatUrl===tab.url){
    await startObserver(tab);return {state:'background_observer_resumed',paired:true,title:prior.title||'CLW Web 对话'};
  }
  const probe=await passiveProbe(tab),page=await attestPage(tab,probe.page);
  if(!page?.visible||!page.controls_known||!CLWControlPolicy.confirmable(page))return {state:'background_page_not_safe'};
  const pageProof=proof||probe.proof,proofFields=normalizedProof(pageProof);
  if(!known&&!Object.keys(proofFields).length)return {state:'background_unregistered_page_ignored'};
  await requireProtocol();
  const nonce=crypto.randomUUID().replaceAll('-','');
  const boot=await wire({action:'bootstrap',chat_url:tab.url,tab_nonce:nonce,page,confirm_low_cost:true,...proofFields});
  if(boot.state==='wrong_registered_page'||boot.state==='enrollment_required')return {state:boot.state};
  if(!Array.isArray(boot.candidates)||boot.candidates.length!==1||boot.auto_bind_safe!==true)return {state:'background_binding_not_unique'};
  const bound=await bindDiscovery(tab,page,nonce,boot.candidates[0].discovery_id,true);
  await startObserver(tab);
  return {state:'background_bound',...bound};
}
async function considerTab(tab,discoverProof=false){
  if(!stableTab(tab))return;
  if(await CLWPageMonitorWorker.isBound(tab.id))return;
  const known=await knownPages(),isKnown=Object.hasOwn(known,tab.url);
  if(!isKnown&&!discoverProof)return;
  if(!isKnown){const proof=await proofProbe(tab);if(!proof)return;return autoBind(tab,proof,false);}
  return autoBind(tab,null,true);
}
async function boundTick(){
  const known=await knownPages(),tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
  for(const tab of tabs){
    if(!stableTab(tab))continue;
    if(await CLWPageMonitorWorker.isBound(tab.id)){
      if(await resumeReload(tab))continue;
      try{await chrome.tabs.sendMessage(tab.id,{type:'clw-monitor-tick'});}catch{}
      continue;
    }
    const pair=(await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
    if(pair&&pair.chatUrl===tab.url){
      try{await chrome.tabs.sendMessage(tab.id,{type:'clw-background-tick'});}catch{}
    }else if(Object.hasOwn(known,tab.url)){
      try{await considerTab(tab,false);}catch{}
    }
  }
}
async function backgroundCandidate(tab){
  if(!stableTab(tab)||!Number.isInteger(tab.windowId))return;
  let w;try{w=await chrome.windows.get(tab.windowId);}catch{return;}
  if(w.type!=='normal'||w.state==='minimized'||w.focused)return;
  try{await considerTab(tab,true);}catch{}
}
async function scanBackgroundActiveTabs(){
  const tabs=await chrome.tabs.query({active:true,url:'https://chatgpt.com/*'});
  for(const tab of tabs)await queueTab(tab.id,()=>backgroundCandidate(tab));
}
async function backgroundBoot(){
  await chrome.alarms.create(BACKGROUND_ALARM,{periodInMinutes:0.5});
  const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'}),known=await knownPages();
  for(const tab of tabs){
    if(!stableTab(tab))continue;
    if(await CLWPageMonitorWorker.isBound(tab.id)){await resumeReload(tab);continue;}
    try{
      if(Object.hasOwn(known,tab.url))await queueTab(tab.id,()=>considerTab(tab,false));
      else await queueTab(tab.id,async()=>{const proof=await proofProbe(tab);if(proof)await autoBind(tab,proof,false);});
    }catch{}
  }
}
async function exactTab(m){
  if(!Number.isInteger(m.tabId))throw Error('control_explicit_popup_required');
  const tab=await chrome.tabs.get(m.tabId);
  if(tab.url!==m.chatUrl||!CLWControlPolicy.isChat(tab.url))throw Error('control_tab_changed');
  return tab;
}
async function requireProtocol(){
  const capabilities=await wire({action:'capabilities'});
  if(capabilities.control_protocol!==4||capabilities.receiver_enrollment!==true||capabilities.run_budgets!==true||capabilities.browser_public_result!==true)throw Error('control_protocol_update_required_no_send');
}
async function saveBound(tab,nonce,v){
  if(!CLWControlPolicy.bindingPermitted(v.model_label,v.effort_label))throw Error('control_model_policy_rejected');
  await chrome.storage.session.set({[key(tab.id)]:{token:v.control_token,generation:v.generation,chatUrl:tab.url,nonce,documentId:null,model_label:v.model_label,effort_label:v.effort_label,title:v.title}});
  await rememberPage(tab.url,v);
  return {paired:true,title:v.title,adopted_request_id:v.adopted_request_id||null,model_label:v.model_label,effort_label:v.effort_label,generation:v.generation};
}
async function bindDiscovery(tab,page,nonce,discoveryId,verified=false){
  if(!verified)await requireProtocol();
  const v=await wire({action:'bind',discovery_id:discoveryId,confirm:true,confirm_low_cost:true,chat_url:tab.url,tab_nonce:nonce,page});
  return saveBound(tab,nonce,v);
}
async function enable(m){
  const tab=await exactTab(m),page=await attestPage(tab,m.page);
  if(m.confirm!==true||!page||!page.visible||!CLWControlPolicy.confirmable(page))throw Error('control_visible_model_not_allowed');
  const nonce=crypto.randomUUID().replaceAll('-','');
  if(m.enrollment!==undefined&&!(typeof m.enrollment==='string'&&/^CLW-ENROLL:[0-9a-f]{32}:[A-Za-z0-9_-]{32}$/.test(m.enrollment)))throw Error('team_browser_receipt_invalid');
  if(m.enrollment_ticket!==undefined&&!(typeof m.enrollment_ticket==='string'&&/^clwi_[A-Za-z0-9_-]{43}$/.test(m.enrollment_ticket)))throw Error('team_browser_ticket_invalid');
  if(m.enrollment&&m.enrollment_ticket)throw Error('team_multiple_browser_proofs');
  await requireProtocol();
  const proofFields=m.enrollment?{enrollment:m.enrollment}:m.enrollment_ticket?{enrollment_ticket:m.enrollment_ticket}:{};
  const boot=await wire({action:'bootstrap',chat_url:tab.url,tab_nonce:nonce,page,confirm_low_cost:true,...(Object.keys(proofFields).length?proofFields:{confirm_page_binding:true})});
  if(boot.state==='enrollment_required')return {enrollment_required:true,titles:boot.titles||[]};
  if(boot.state==='wrong_registered_page')return {wrong_page:true,current_titles:boot.current_titles||[],pending_titles:boot.pending_titles||[]};
  if(!Array.isArray(boot.candidates)||boot.candidates.length<1)throw Error('control_no_registered_clw_conversation');
  if(boot.candidates.length===1)return bindDiscovery(tab,page,nonce,boot.candidates[0].discovery_id,true);
  return {needs_selection:true,nonce,candidates:boot.candidates};
}
async function handle(m,sender){
  await storageReady;
  if(!m||typeof m.type!=='string')throw Error('control_message_invalid');
  if(m.type.startsWith('monitor-')){
    const result=await CLWPageMonitorWorker.handle(m,sender);monitorBadge(sender.tab?.id??m.tabId,result);
    if(result.reload)await performReload(result.reload);return result;
  }
  const popup=!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');
  if(m.type==='local-control-status'){
    if(!popup)throw Error('control_explicit_popup_required');
    const saved=await chrome.storage.session.get('clwLocalControlPeer');
    return {connected:!!saved.clwLocalControlPeer?.peer_token};
  }
  if((m.type==='pair'||m.type==='control-enable'||m.type==='control-select'||m.type==='control-resume')&&
     Number.isInteger(m.tabId)&&await CLWPageMonitorWorker.isBound(m.tabId))throw Error('monitor_already_owns_page');
  if(m.type==='clw-background-proof-found'){
    if(!sender.tab||sender.frameId!==0||sender.url!==m.url)throw Error('control_background_sender_invalid');
    const tab=await chrome.tabs.get(sender.tab.id);if(tab.url!==sender.url)throw Error('control_tab_changed');
    return autoBind(tab,m.proof,false);
  }
  if(m.type==='managed-join'||m.type==='managed-stop'){
    if(!popup||m.confirm!==true)throw Error('pool_explicit_confirmation_required');
    if(m.type==='managed-stop')return CLWManagedWindow.halt();
    return CLWManagedWindow.join(await exactTab(m),async id=>(await chrome.storage.session.get(key(id)))[key(id)]);
  }
  if(m.type==='open-new-page'){
    if(!popup||m.confirm!==true)throw Error('pool_explicit_confirmation_required');
    const opened=await chrome.tabs.create({url:'https://chatgpt.com/',active:true});
    return {tab_opened:Number.isInteger(opened.id),conversation_created:false,model_started:false};
  }
  // 0.1.1 compatibility while open pages transition to the unified 0.2.0 carrier.
  if(['pair','resume','disable'].includes(m.type)){
    if(!popup||!Number.isInteger(m.tabId))throw Error('explicit_popup_required');
    const tab=await chrome.tabs.get(m.tabId);if(tab.url!==m.chatUrl||!CLWRecoveryPolicy.isChat(tab.url))throw Error('exact_tab_changed');
    if(m.type==='disable'){await chrome.storage.session.remove(recoveryKey(tab.id));return {disabled:true};}
    if(m.type==='resume'){const p=(await chrome.storage.session.get(recoveryKey(tab.id)))[recoveryKey(tab.id)];if(!p||p.chat_url!==tab.url)throw Error('pair_required');return {resumed:true};}
    const v=await recoveryWire({action:'pair',code:m.code,chat_url:tab.url});
    await chrome.storage.session.set({[recoveryKey(tab.id)]:{token:v.recovery_token,chat_url:tab.url,peer_id:v.peer_id}});return {paired:true};
  }
  if(m.type==='wire'&&sender.tab&&sender.frameId===0){
    const tab=await chrome.tabs.get(sender.tab.id),p=(await chrome.storage.session.get(recoveryKey(tab.id)))[recoveryKey(tab.id)];
    if(!p||sender.url!==p.chat_url||tab.url!==p.chat_url)throw Error('pair_missing_or_navigation_changed');
    const allowed={status:['page'],observe:['request_id','kind','failure_key','user_key','safe'],dispatch:['request_id','attempt_id'],finish:['attempt_id','result']};
    const a=m.data;if(!a||!allowed[a.action]||Object.keys(a).some(k=>!['action',...allowed[a.action]].includes(k)))throw Error('unsupported_action');
    const v=await recoveryWire({...a,chat_url:p.chat_url},p.token);return Object.fromEntries(Object.entries(v).filter(([k])=>!k.includes('token')));
  }
  if(['control-enable','control-select','control-resume','control-disable'].includes(m.type)){
    if(!popup)throw Error('control_explicit_popup_required');
    const tab=await exactTab(m);
    if(m.type==='control-disable'){
      const p=(await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
      await chrome.storage.session.remove(key(tab.id));
      await forgetPage(tab.url);
      if(p)try{await wire({action:'disable',generation:p.generation,chat_url:p.chatUrl,tab_nonce:p.nonce},p.token);}catch{}
      return {stopped_locally:true,native_execution_stopped:false};
    }
    if(m.type==='control-resume'){
      const p=(await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
      if(p&&p.chatUrl===tab.url){await requireProtocol();await chrome.storage.session.set({[key(tab.id)]:{...p,documentId:null}});return {paired:true,title:p.title||'CLW Web 对话',resumed_observer_only:true};}
      return enable(m);
    }
    if(m.type==='control-select'){
      const page=await attestPage(tab,m.page);
      if(m.confirm!==true||!page.visible||!CLWControlPolicy.confirmable(page))throw Error('control_visible_model_not_allowed');
      if(typeof m.nonce!=='string'||!/^[0-9a-f]{32}$/.test(m.nonce))throw Error('control_discovery_nonce_invalid');
      return bindDiscovery(tab,page,m.nonce,m.discoveryId);
    }
    return enable(m);
  }
  if(!sender.tab||sender.frameId!==0||!sender.documentId)throw Error('control_paired_document_required');
  const tab=await chrome.tabs.get(sender.tab.id),p=(await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
  if(!p||sender.url!==p.chatUrl||tab.url!==p.chatUrl||sender.tab.url!==p.chatUrl)throw Error('control_pair_missing_or_navigation_changed');
  if(m.type==='control-hello'){
    await requireProtocol();
    if(p.documentId&&p.documentId!==sender.documentId)throw Error('control_document_changed_explicit_resume');
    if(!p.documentId)await chrome.storage.session.set({[key(tab.id)]:{...p,documentId:sender.documentId}});
    return {model_label:p.model_label,effort_label:p.effort_label,transport_active:await transportActive(tab)};
  }
  if(m.type==='control-transport')return {active:await transportActive(tab)};
  if(m.type!=='control-wire'||p.documentId!==sender.documentId)throw Error('control_unsupported_or_foreign_action');
  const data=m.data?.page?{...m.data,page:await attestPage(tab,m.data.page)}:m.data;
  if(!CLWControlPolicy.actionValid(data))throw Error('control_unsupported_or_foreign_action');
  const v=await wire({...data,generation:p.generation,chat_url:p.chatUrl,tab_nonce:p.nonce},p.token);
  const fields=['state','dispatch','attempt_id','request_id','user_hash','failure_hash','recovery','model_label','effort_label','attempt_state','prompt','task_completed','model_received','native_execution_stopped'];
  return Object.fromEntries(fields.filter(k=>Object.hasOwn(v,k)).map(k=>[k,v[k]]));
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  const id=sender.tab?.id??m?.tabId??'invalid',current=queueTab(id,()=>handle(m,sender));
  current.then(value=>reply({ok:true,value})).catch(e=>reply({ok:false,error:e.name==='AbortError'?'control_transport_unknown_no_retry':String(e.message).slice(0,160)}));
  return true;
});
chrome.tabs.onActivated?.addListener(({tabId})=>{void queueTab(tabId,async()=>backgroundCandidate(await chrome.tabs.get(tabId))).catch(()=>{});});
chrome.windows?.onFocusChanged?.addListener(windowId=>{
  if(windowId!==chrome.windows.WINDOW_ID_NONE)return;
  void scanBackgroundActiveTabs().catch(()=>{});
});
chrome.tabs.onRemoved.addListener(id=>{void chrome.storage.session.remove(key(id));void chrome.storage.session.remove(recoveryKey(id));void CLWPageMonitorWorker.stopForTab(id);});
chrome.tabs.onUpdated?.addListener((id,change,tab)=>{if((change.status==='complete'||change.url)&&CLWControlPolicy.isChat(tab.url||'')){void queueTab(id,async()=>{if(!await resumeReload(tab))await considerTab(tab,true);}).catch(()=>{});}});
chrome.alarms?.onAlarm.addListener(alarm=>{if(alarm.name===CLWManagedWindow.ALARM)void CLWManagedWindow.rotate(async id=>(await chrome.storage.session.get(key(id)))[key(id)]);if(alarm.name===BACKGROUND_ALARM){void boundTick();if(chrome.runtime.id)CLWLocalControl.start();}});
