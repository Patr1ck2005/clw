'use strict';
const {createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(value||'').digest('hex');
const home='https://chatgpt.com/';
function emptyCarrier(s){
  return !!s&&s.url===home&&s.editor===true&&s.controlKnown===true&&(s.historyAtLatest===true||s.historyAtLatest===null)&&
    ['generating','draft','composing','approvalRequired','loginRequired','blocked','accessLimited','complete'].every(k=>s[k]===false)&&
    !s.userId&&!s.assistantId&&!s.userText&&!s.publicText&&!s.html&&!s.failure&&!s.unknown&&!s.error&&
    !s.attemptMarker&&!s.bootstrapMarker&&s.attemptMarkerCount===0&&s.bootstrapMarkerCount===0;
}
function emptyEvidence(s,documentGeneration){
  if(!emptyCarrier(s))throw Error('managed_empty_carrier_not_verified');
  return {url:s.url,at:Date.now(),document_generation:documentGeneration,editor:true,control_known:true,history_at_latest:s.historyAtLatest,
    user_hash:digest(s.userId),assistant_hash:digest(s.assistantId),generating:false,draft:false,composing:false,
    approval:false,login:false,blocked:false,access_limited:false,complete:false,marker_count:0};
}
function sameRecovery(r,d=r?.carrier_recovery){
  return !!r&&!!d&&d.state==='prepared'&&d.page_id===r.page_id&&d.thread_id===r.thread_id&&
    d.request_id===r.latest_request?.id&&d.account===(r.account||'B')&&d.original_url===r.url;
}
function bindingEvidence(s,attemptId){
  if(!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]{16,128}$/.test(s?.url||'')||!s.userId||
    s.attemptMarker!==`[CLW:${attemptId}]`||s.attemptMarkerCount!==1||(s.historyAtLatest!==true&&s.historyAtLatest!==null)||
    ['draft','composing','loginRequired','blocked','accessLimited'].some(k=>s[k]!==false))return null;
  return {at:Date.now(),user_hash:digest(s.userId),marker:s.attemptMarker,marker_count:1,history_at_latest:s.historyAtLatest,
    draft:false,composing:false,login:false,blocked:false,access_limited:false};
}
module.exports={emptyCarrier,emptyEvidence,sameRecovery,bindingEvidence};
