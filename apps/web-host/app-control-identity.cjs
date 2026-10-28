'use strict';
// App control shares the application's commands; this envelope pins the owner
// and original task before entering that dispatcher. It never retries work.
const taskActions=new Set(['select','rename','refresh','close','pause','resume','start',
  'reconcile-submission','goal-read','goal-save','goal-review','goal-discard','goal-stop','goal-continue',
  'refill-budget','stop-generation','inspect','set-model','adopt-model',
  'start-first-turn','enroll','configure-intake','prompt-preview','withdraw','budget-continue','task-status','task-observation','reconcile-send-preparation','reset-bootstrap-query']);
const appActions=new Set(['show','background','theme','status','inspect-ui','capture-shell','quota-history','quota-verify',
  'reload-shell','reload-page-adapter','ui-view','quit','exit-status','reconcile-exit','cancel-exit','codex-verify','new','login','codex-start','native-codex-start','window-size','mcp-call-details',
  'preview-read','preview-bootstrap','preview-connect','preview-check','preview-export','connection-read','connection-save']);
const nativeActions=new Set(['codex-view-turn','codex-resume-turn']);
const recordActions=new Set(['record-history','record-index','record-body']);
const capabilities=[...appActions,...taskActions,...nativeActions,...recordActions];
function rejected(code){return Object.assign(Error(code),{accepted:false,code});}
function taskIdentity(page,record,generation){
  return {page_id:page.id,thread_id:record?.thread_id||null,
    request_id:record?.latest_request?.id||null,
    active_request_id:['queued','processing','suspended'].includes(record?.latest_request?.phase)?record.latest_request.id:null,
    account:record?.account||page.account||'B',root:record?.root||page.root||'',
    document_generation:page.documentGeneration||0,runtime_generation:generation};
}
function assertControlIdentity(action,payload,expected,snapshot){
  if(!capabilities.includes(action))throw rejected('app_control_action_unavailable');
  if(!expected||expected.app_instance_id!==snapshot.app_instance_id||expected.root!==snapshot.root||
    expected.runtime_generation!==snapshot.runtime_generation)
    throw rejected('app_control_owner_changed');
  if(['new','login','codex-start'].includes(action)&&!['A','B'].includes(payload.account))
    throw rejected('app_control_account_required');
  if(action.startsWith('preview-')&&Object.keys(payload).length)throw rejected('preview_control_payload_invalid');
  if(action==='connection-read'&&Object.keys(payload).length)throw rejected('connection_request_invalid');
  if(action==='quota-history'&&(!['A','B'].includes(payload.account)||Object.keys(payload).some(k=>!['account','since'].includes(k))))
    throw rejected('quota_history_payload_invalid');
  if(action==='quota-verify'&&(!['A','B'].includes(payload.account)||Object.keys(payload).some(k=>k!=='account')))
    throw rejected('quota_history_payload_invalid');
  if(action==='exit-status'&&Object.keys(payload).length||action==='reconcile-exit'&&
    (Object.keys(payload).sort().join(',')!=='exit_id'||!(/^[a-f0-9-]{36}$/).test(payload.exit_id||'')||payload.exit_id!==snapshot.exit?.exit_id))
    throw rejected('exit_original_context_changed');
  if(action==='quit'&&(Object.keys(payload).some(key=>!['maintenance','exit_id'].includes(key))||
    Object.hasOwn(payload,'maintenance')&&typeof payload.maintenance!=='boolean'||
    Object.hasOwn(payload,'exit_id')&&payload.exit_id!==snapshot.exit?.exit_id))throw rejected('exit_payload_invalid');
  const recordTask=recordActions.has(action)&&payload.mode==='web'||action==='mcp-call-details'&&payload.scope==='task';
  if(taskActions.has(action)||recordTask){
    const current=snapshot.tasks.find(row=>row.id===payload.id);
    const task=expected.task;
    if(!current||!task||Object.keys(current.identity).some(key=>task[key]!==current.identity[key]))
      throw rejected('app_control_task_changed');
    if(Object.hasOwn(payload,'expected_connection_generation')&&payload.expected_connection_generation!==snapshot.runtime_generation||
      Object.hasOwn(payload,'expected_request_id')&&payload.expected_request_id!==task.active_request_id)
      throw rejected('app_control_payload_identity_conflict');
  }
  if(nativeActions.has(action)||recordActions.has(action)&&payload.mode==='codex'){
    const rows=snapshot.native_tasks||[],target=expected.native_task;
    const row=rows.find(row=>nativeActions.has(action)?row.trace_id===payload.traceId:
      action==='record-body'?row.task_key===payload.task_key&&row.trace_id===payload.traceId:row.task_key===payload.task_key);
    if(!row||!target||Object.keys(row).some(key=>target[key]!==row[key]))throw rejected('app_control_native_task_changed');
  }
  if(['ui-view','reload-shell','reload-page-adapter','inspect-ui','capture-shell'].includes(action)&&
    expected.selected!==snapshot.selected)throw rejected('app_control_selection_changed');
  if(action==='reload-page-adapter'){
    if(Object.keys(payload).some(key=>key!=='expected_page_dom_sha256')||
      !/^[a-f0-9]{64}$/.test(payload.expected_page_dom_sha256||''))
      throw rejected('app_page_adapter_payload_invalid');
    const adapter=expected.page_adapter,current=snapshot.page_adapter;
    if(!adapter||Object.keys(adapter).some(key=>!['sha256','revision'].includes(key))||
      !/^[a-f0-9]{64}$/.test(adapter.sha256||'')||!Number.isSafeInteger(adapter.revision)||adapter.revision<1||
      !current||adapter.sha256!==current.sha256||adapter.revision!==current.revision)
      throw rejected('app_page_adapter_changed');
  }
  return true;
}
function commandPayload(action,payload,expected){
  if(taskActions.has(action)&&!['select','rename','refresh','close','withdraw','prompt-preview'].includes(action))
    return {...payload,expected_connection_generation:expected.runtime_generation,
      ...(['pause','resume','reconcile-submission','start'].includes(action)?{expected_request_id:expected.task.active_request_id}:{})};
  return payload;
}
module.exports={capabilities,taskActions,taskIdentity,assertControlIdentity,commandPayload,rejected};
