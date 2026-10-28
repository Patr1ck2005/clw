'use strict';

// A task record survives without a renderer. Only work that needs the original
// browser receipt, or an explicit user view, requires its page in memory.
const conversationUrl=url=>typeof url==='string'&&/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(url);
function currentLifecycle(record){
  const lifecycle=record?.renderer_lifecycle,request=record?.latest_request;
  return lifecycle?.version===1&&lifecycle.page_id===record.page_id&&lifecycle.thread_id===(record.thread_id??null)&&
    lifecycle.request_id===(request?.id??null)&&lifecycle.request_phase===(request?.phase??null)&&
    lifecycle.attempt_id===(request?.attempt_id??null)&&typeof lifecycle.required==='boolean'?lifecycle:null;
}
function originalTurnRequiresRenderer(record,{closed=false,restoreUrl}={}){
  if(!record)return false;
  const lifecycle=currentLifecycle(record);
  if(lifecycle){
    if(!lifecycle.required)return false;
    if(lifecycle.reason==='bootstrap_original_page_only'&&closed&&record.paused&&
       !conversationUrl(restoreUrl??record.url))return false;
    return true;
  }
  if(record.phase!=='bound'&&(['sending','sent','unknown'].includes(record.bootstrap_state)||record.phase==='receiver_enrolled'))return true;
  const request=record.latest_request;
  return ['processing','suspended','unknown'].includes(request?.phase)||
    request?.phase==='queued'&&!!(request.attempt_id||request.sent_user_hash);
}
function requiresRenderer(record,{viewing=false,pending=false,resultPending=false,approvalBusy=false,safetyPin=false,reading=false,closed=false,restoreUrl}={}){
  if(viewing||pending||resultPending||approvalBusy||safetyPin||reading)return true;
  if(!record)return false;
  if(originalTurnRequiresRenderer(record,{closed,restoreUrl}))return true;
  if(record.paused)return false;
  const request=record.latest_request;
  return !!record.active_work||!!record.work_model_pending||request?.phase==='queued'||
    (record.phase!=='bound'&&record.bootstrap_state==='pending'&&!record.bootstrap_wait);
}
function loaded(page){return !!page?.view?.webContents&&!page.view.webContents.isDestroyed?.();}
module.exports={requiresRenderer,originalTurnRequiresRenderer,currentLifecycle,loaded};
