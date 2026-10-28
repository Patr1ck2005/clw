'use strict';
const {randomUUID}=require('node:crypto');
const messages={
  workspace_busy_or_unreconciled:'项目仍有未核对的执行占用，目标没有发送。输入已保留。',
  workspace_has_unresolved_send:'项目有发送结果待核对，输入已保留，请勿重复派发。',
  host_request_unresolved:'此任务的上一目标尚未结束，请等待原目标完成。',
  host_note_request_not_current:'原任务已经结束，追加内容没有发送。输入已保留，可作为下一个目标提交。',
  host_finalizing_no_append:'主控正在保存本次最终结果，追加内容没有发送。输入已保留，完成后可作为下一个目标提交。',
  host_handoff_in_progress:'正在交接到后继对话，追加内容没有发送。输入已保留，请在后继任务中继续。',
  managed_page_not_ready:'此任务尚未接入或已暂停，目标没有发送。'
};
Object.assign(messages,{
  managed_budget_needs_time_and_sends:'续杯还需要可用时间和发送次数，目标没有发送。请打开“续杯”补足。',
  managed_budget_wait_for_close:'上一轮仍在收尾，目标没有发送。原回执完成后再继续。',
  managed_budget_source_changed:'原任务状态已变化，目标没有发送。请重新核对续杯。'
});
Object.assign(messages,{
  managed_resume_window_expired:'运行时间已到期，内容已保存。请在“续杯”中延长时间后恢复。',
  managed_resume_sends_exhausted:'本轮可用发送次数已用完（保留一次收尾），内容已保存。请续杯后恢复。',
  managed_resume_controller_paused:'主控运行仍暂停，内容已保存。请先恢复主控任务。',
  managed_resume_run_closed:'原运行已经结束，内容已保存。请在原对话提交下一个目标。',
  managed_resume_finalizing:'原运行正在收尾，内容已保存。请先核对原结果。',
  team_use_resume_maintenance:'全队处于维护暂停，内容已保存。请从维护入口恢复原检查点。'
});
function submissionError(error){return messages[error.message]?Error(messages[error.message]):error;}
class TaskSubmission {
  constructor(runtime,workspace){this.runtime=runtime;this.workspace=workspace;this.busy=new Set();}
  captureIntent(intent){
    if(!intent||typeof intent!=='object'||Array.isArray(intent)||typeof intent.operation_id!=='string'||!intent.operation_id||
      typeof intent.objective!=='string'||!intent.objective.trim())throw Error('managed_submission_original_intent_invalid');
    return {reference:intent,operation_id:intent.operation_id,objective:intent.objective,expected_request_id:intent.expected_request_id??null};
  }
  assertIntent(pageId,intent){
    const current=this.workspace.pendingStarts[pageId];
    if(current!==intent.reference||current?.operation_id!==intent.operation_id||current?.objective!==intent.objective||
      (current?.expected_request_id??null)!==intent.expected_request_id)throw Error('managed_submission_original_intent_changed');
  }
  persistIntent(pageId,intent){
    const previous=this.workspace.pendingStarts[pageId];
    if(intent)this.workspace.pendingStarts[pageId]=intent;
    else delete this.workspace.pendingStarts[pageId];
    try{this.workspace.save();}
    catch(error){
      // Keep memory aligned with the last durable intent. In particular, a
      // failed cleanup after acceptance must never permit a new operation ID.
      if(previous)this.workspace.pendingStarts[pageId]=previous;
      else delete this.workspace.pendingStarts[pageId];
      throw error;
    }
  }
  finish(pageId,intent,result){
    // A late response belongs to the frozen operation. It must not clear a new
    // durable intent, even if another flow reused this page or mutated the row.
    this.assertIntent(pageId,intent);
    if(['queued_for_web_host','note_saved_not_native_interrupt'].includes(result?.state)){
      this.persistIntent(pageId,null);return result;
    }
    if(result?.state==='rejected'){
      this.persistIntent(pageId,null);
      if(result.code==='workspace_busy_or_unreconciled'&&result.blocker?.result_path){
        const blocker=result.blocker;
        const name=blocker.result_path.replace(/[\\/]+$/,'').split(/[\\/]/).pop();
        const status={queued:'排队中',reserved:'准备启动',running:'运行中',unknown:'执行状态待核对',terminal_pending:'等待收尾核对'}[blocker.state]||'等待核对';
        throw Error(`目录被 Codex＋Web 任务「${name}」占用（${status}）：${blocker.workspace}。本目标未发送，输入已保留。请在 Codex＋Web 中查看该任务；结束并核对占用后可发送。`);
      }
      const error=Error(messages[result.code]||('目标未接受：'+result.code+'。输入已保留。'));
      // Operator goal controls need the authoritative rejection to offer safe
      // discard. Preserve the existing composer error while retaining receipt.
      error.submissionReceipt=result;throw error;
    }
    throw Error('目标的提交结果尚未确认，已保留原操作和输入。再次检查时会查询原回执，不重复发送。');
  }
  async reconcile(pageId,objective,assertCurrent=()=>{}){
    if(typeof pageId!=='string'||!pageId||typeof objective!=='string')throw Error('managed_submission_reconcile_invalid');
    if(this.busy.has(pageId))throw Error('正在确认这个目标，请稍候。');
    this.busy.add(pageId);
    try{
      assertCurrent();const pending=this.workspace.pendingStarts[pageId];
      // This read-only entry never falls through to start, creates an operation
      // key, or treats disappearance of the local intent as business success.
      if(!pending)return {state:'rejected',code:'managed_submission_original_intent_missing',model_sends:0};
      const intent=this.captureIntent(pending);
      if(intent.objective!==objective)throw Error('managed_submission_original_objective_required');
      const receipt=await this.runtime.call('receipt',{operation_id:intent.operation_id});
      if(receipt?.operation_id!==intent.operation_id)throw Error('managed_submission_receipt_identity_invalid');
      const result=receipt.state==='completed'?receipt.result:receipt.result||receipt;
      if(['queued_for_web_host','note_saved_not_native_interrupt'].includes(result?.state)){
        const expectedState=intent.expected_request_id?'note_saved_not_native_interrupt':'queued_for_web_host';
        const expectedRequest=intent.expected_request_id||intent.operation_id;
        if(receipt.state!=='completed'||result.state!==expectedState||result.request_id!==expectedRequest||
          Object.hasOwn(result,'operation_id')&&result.operation_id!==intent.operation_id)
          throw Error('managed_submission_receipt_identity_invalid');
      }
      assertCurrent({response:true,acceptedRequestId:['queued_for_web_host','note_saved_not_native_interrupt'].includes(result?.state)?result.request_id:null});
      return this.finish(pageId,intent,result);
    }finally{this.busy.delete(pageId);}
  }
  async start(pageId,objective,expectedRequestId=null,options={}){
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='operation_id'))
      throw Error('managed_goal_operation_invalid');
    const suppliedOperation=Object.hasOwn(options,'operation_id')?options.operation_id:null;
    if(Object.hasOwn(options,'operation_id')&&(typeof suppliedOperation!=='string'||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(suppliedOperation)))
      throw Error('managed_goal_operation_invalid');
    if(!objective?.trim())throw Error('请输入工作目标。');
    const limit=expectedRequestId?16000:24000;
    if([...objective.trim()].length>limit)throw Error('内容超过 '+limit+' 字符，尚未提交。请将长交接保存为项目内 Markdown 文件，再发送读取路径和目标；原输入完整保留。');
    if(this.busy.has(pageId))throw Error('正在确认这个目标，请稍候。');
    this.busy.add(pageId);
    try{
      let intent=this.workspace.pendingStarts[pageId];
      if(intent){
        if(suppliedOperation&&intent.operation_id!==suppliedOperation)throw Error('managed_goal_original_operation_required');
        if(intent.objective!==objective)throw Error('上一目标的提交结果待核对，请先保留原目标完成核对。');
        const original=this.captureIntent(intent),receipt=await this.runtime.call('receipt',{operation_id:original.operation_id});
        if(receipt?.operation_id&&receipt.operation_id!==original.operation_id)throw Error('managed_submission_receipt_identity_invalid');
        return this.finish(pageId,original,receipt.state==='completed'?receipt.result:receipt.result||receipt);
      }
      intent={operation_id:suppliedOperation||randomUUID(),objective,...(expectedRequestId?{expected_request_id:expectedRequestId}:{})};
      this.persistIntent(pageId,intent);
      const original=this.captureIntent(intent);
      let result;
      try{result=await this.runtime.call('start',{page_id:pageId,...intent});}
      catch(error){
        if(['runtime_not_connected','managed_page_not_ready','managed_budget_needs_time_and_sends','managed_budget_wait_for_close','managed_budget_source_changed'].includes(error.message)){
          this.assertIntent(pageId,original);
          this.persistIntent(pageId,null);throw messages[error.message]?Error(messages[error.message]):error;
        }
        throw error;
      }
      return this.finish(pageId,original,result);
    }finally{this.busy.delete(pageId);}
  }
}
async function startExistingTask({pageById,driver,submissions},payload,options){
  if(typeof payload.id!=='string'||!payload.id)throw Error('发送任务未指定，输入已保留。');
  // Capture the owner before any await; sidebar selection is never authority.
  const page=pageById(payload.id),resume=payload.resume===true;
  if(resume)throw Error('恢复自动推进须单独操作，内容未发送，输入已保留。');
  const record=driver.records?.get(page.id),originalPending=submissions.workspace?.pendingStarts?.[page.id];
  if(record?.paused&&!payload.expected_request_id&&!originalPending)throw Error('自动推进仍暂停，请先单独恢复；输入已保留。');
  let result;
  if(payload.objective?.trim())result=options===undefined?
    await submissions.start(page.id,payload.objective,payload.expected_request_id):
    await submissions.start(page.id,payload.objective,payload.expected_request_id,options);
  else throw Error('请输入工作目标。');
  return result;
}
module.exports={TaskSubmission,startExistingTask,submissionError};
