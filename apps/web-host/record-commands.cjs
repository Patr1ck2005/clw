'use strict';
const actions=new Set(['record-history','record-index','record-body']);
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f]/.test(value);
const trace=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const taskKey=row=>row.source?.threadId||'unmapped:'+row.traceId;
async function readRecords(action,payload,{runtime,nativeBridge,resolvePage}){
  if(!actions.has(action))throw Error('record_action_invalid');
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('record_request_invalid');
  const request={};
  if(payload.position!==undefined){if(!['first','latest'].includes(payload.position))throw Error('record_position_invalid');request.position=payload.position;}
  if(payload.limit!==undefined){if(!Number.isSafeInteger(payload.limit)||payload.limit<1||payload.limit>80)throw Error('record_limit_invalid');request.limit=payload.limit;}
  if(action==='record-index'){
    if(payload.query!==undefined&&(typeof payload.query!=='string'||payload.query.length>200))throw Error('record_query_invalid');
    request.query=payload.query||'';
  }
  if(payload.mode==='web'){
    if(!safeId(payload.id))throw Error('record_page_required');
    const page=resolvePage(payload.id);if(!page||page.id!==payload.id||page.kind==='account')throw Error('record_page_invalid');
    for(const key of ['seq','before_seq','after_seq','around_seq'])if(payload[key]!==undefined){
      if(!Number.isSafeInteger(payload[key])||payload[key]<1)throw Error('record_cursor_invalid');request[key]=payload[key];
    }
    if(action==='record-body'&&!request.seq)throw Error('record_cursor_required');
    if(!runtime?.ready)throw Error('runtime_not_connected');
    return runtime.call(action,{page_id:page.id,...request});
  }
  if(payload.mode==='codex'){
    if(!safeId(payload.task_key))throw Error('record_task_required');request.task_key=payload.task_key;
    for(const key of ['before_trace','after_trace','around_trace'])if(payload[key]!==undefined){
      if(!trace(payload[key]))throw Error('record_cursor_invalid');request[key]=payload[key];
    }
    if(action==='record-body'){
      if(!trace(payload.traceId))throw Error('record_cursor_required');
      const row=await nativeBridge?.turn(payload.traceId);
      if(!row||row.traceId!==payload.traceId||taskKey(row)!==payload.task_key)throw Error('record_body_identity_mismatch');
      return {task_key:payload.task_key,row};
    }
    const read=action==='record-history'?nativeBridge?.history:nativeBridge?.recordIndex;
    if(typeof read!=='function')throw Error('record_history_unavailable');
    return read(request);
  }
  throw Error('record_mode_invalid');
}
module.exports={readRecords,actions};
