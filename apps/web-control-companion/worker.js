/* Narrow capability kept only in trusted extension session storage. */
'use strict';
importScripts('policy.js');
const ENDPOINT='http://127.0.0.1:18944/api/harness/control-wire';
const key=id=>'clwControlTab:'+id;
const queues=new Map();
const storageReady=chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
async function wire(body,token){
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),10000);
  try{
    const r=await fetch(ENDPOINT,{method:'POST',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json',...(token?{'X-CLW-Control':token}:{})},body:JSON.stringify(body),signal:c.signal});
    const text=await r.text();if(text.length>16000)throw Error('control_response_too_large');
    const v=JSON.parse(text);if(!r.ok||v.success!==true)throw Error(v.code||'control_unconfirmed');return v;
  }finally{clearTimeout(timer);}
}
async function handle(m,sender){
  await storageReady;
  if(!m||typeof m.type!=='string')throw Error('control_message_invalid');
  const popup=!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');
  if(['pair','resume','disable'].includes(m.type)){
    if(!popup||!Number.isInteger(m.tabId))throw Error('control_explicit_popup_required');
    const tab=await chrome.tabs.get(m.tabId);
    if(tab.url!==m.chatUrl||!CLWControlPolicy.isChat(tab.url))throw Error('control_tab_changed');
    if(m.type==='disable'){
      const p=(await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
      await chrome.storage.session.remove(key(tab.id));
      if(p)try{await wire({action:'disable',generation:p.generation,chat_url:p.chatUrl,tab_nonce:p.nonce},p.token);}catch{}
      return {stopped_locally:true,native_execution_stopped:false};
    }
    if(m.type==='resume'){
      const p=(await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
      if(!p||p.chatUrl!==tab.url)throw Error('control_pair_required');
      await chrome.storage.session.set({[key(tab.id)]:{...p,documentId:null}});
      return {resumed_observer_only:true};
    }
    if(m.confirm!==true)throw Error('control_confirm_required');
    const nonce=crypto.randomUUID().replaceAll('-','');
    const v=await wire({action:'pair',code:String(m.code||'').trim().toUpperCase(),chat_url:tab.url,tab_nonce:nonce});
    if(!CLWControlPolicy.permitted(v.model_label,v.effort_label))throw Error('control_model_policy_rejected');
    await chrome.storage.session.set({[key(tab.id)]:{token:v.control_token,generation:v.generation,chatUrl:tab.url,nonce,documentId:null,model_label:v.model_label,effort_label:v.effort_label}});
    return {paired:true,model_label:v.model_label,effort_label:v.effort_label,generation:v.generation};
  }
  if(!sender.tab||sender.frameId!==0||!sender.documentId)throw Error('control_paired_document_required');
  const tab=await chrome.tabs.get(sender.tab.id),p=(await chrome.storage.session.get(key(tab.id)))[key(tab.id)];
  if(!p||sender.url!==p.chatUrl||tab.url!==p.chatUrl||sender.tab.url!==p.chatUrl)throw Error('control_pair_missing_or_navigation_changed');
  if(m.type==='hello'){
    if(p.documentId&&p.documentId!==sender.documentId)throw Error('control_document_changed_explicit_resume');
    if(!p.documentId)await chrome.storage.session.set({[key(tab.id)]:{...p,documentId:sender.documentId}});
    return {model_label:p.model_label,effort_label:p.effort_label};
  }
  if(m.type!=='wire'||p.documentId!==sender.documentId||!CLWControlPolicy.actionValid(m.data))throw Error('control_unsupported_or_foreign_action');
  const v=await wire({...m.data,generation:p.generation,chat_url:p.chatUrl,tab_nonce:p.nonce},p.token);
  // Never expose additional future server fields or capabilities to a page.
  const fields=['state','dispatch','attempt_id','request_id','user_hash','failure_hash','recovery','model_label','effort_label','attempt_state','prompt','task_completed','model_received','native_execution_stopped'];
  return Object.fromEntries(fields.filter(k=>Object.hasOwn(v,k)).map(k=>[k,v[k]]));
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  const id=sender.tab?.id??m?.tabId??'invalid';
  const previous=queues.get(id)||Promise.resolve();
  const current=previous.catch(()=>{}).then(()=>handle(m,sender));queues.set(id,current);
  current.then(value=>reply({ok:true,value})).catch(e=>reply({ok:false,error:e.name==='AbortError'?'control_transport_unknown_no_retry':String(e.message).slice(0,160)})).finally(()=>{if(queues.get(id)===current)queues.delete(id);});
  return true;
});
chrome.tabs.onRemoved.addListener(id=>{void chrome.storage.session.remove(key(id));});
