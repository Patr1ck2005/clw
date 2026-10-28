'use strict';
const {createHash}=require('node:crypto');
const {connectorForAccount}=require('./connector-identity.cjs');
const {sameModel,sameEffort}=require('./model-settings.cjs');
const hash=text=>createHash('sha256').update(text||'').digest('hex');
const fail=code=>{throw Error(code);};

async function reconcileSendPreparation({driver,page,payload,operationId,assertCurrent}){
  if(!operationId||!payload||Object.keys(payload).some(key=>!['id','expected_connection_generation',
    'expected_request_id','expected_attempt_id','legacy_incident'].includes(key))||
    typeof payload.expected_request_id!=='string'||!/^control_[a-f0-9]{32}$/.test(payload.expected_attempt_id||''))
    fail('send_preparation_recovery_invalid');
  const original=driver.records.get(page.id),requestId=payload.expected_request_id,attemptId=payload.expected_attempt_id;
  const account=page.account||'B',connector=connectorForAccount(account),marker=`[CLW:${attemptId}]`;
  const wc=page.view?.webContents,documentGeneration=page.documentGeneration,connection=driver.connectionGeneration;
  if(!wc||driver.busy.has(page.id)||driver.pending.has(page.id)&&driver.pending.get(page.id)?.attempt!==attemptId||driver.approvals?.busy?.has?.(page.id)||
    driver.resultCandidates.has(attemptId))fail('send_preparation_original_operation_pending');
  const binding=row=>JSON.stringify([row?.page_id,row?.thread_id,row?.account,row?.root,row?.url,row?.model,row?.effort,
    row?.access,row?.write_paths,row?.resources,row?.parent_target,row?.collaboration_protocol,
    row?.latest_request?.id,row?.latest_request?.phase,row?.latest_request?.attempt_id]);
  const originalBinding=binding(original);
  const check=()=>{
    assertCurrent();const row=driver.records.get(page.id);
    if(driver.stopped||driver.observationQuiesced||driver.runtime.closed||page.view?.webContents!==wc||wc.isDestroyed?.()||
      page.documentGeneration!==documentGeneration||driver.connectionGeneration!==connection||
      !row||row.phase!=='bound'||binding(row)!==originalBinding||row.latest_request?.id!==requestId||
      row.latest_request?.attempt_id!==attemptId||row.latest_request?.phase!=='processing'||row.latest_request.cancel_requested||
      row.paused||row.own_paused||row.attention||row.issue_kind||
      row.observed_stop_user_hash&&row.resumed_stop_user_hash!==row.observed_stop_user_hash||
      (row.account||'B')!==account||wc.getURL?.()!==row.url)
      fail('send_preparation_original_identity_changed');
  };
  const read=async baseline=>{
    check();const s=await driver.dom(wc,'snapshot');check();
    if(s.url!==original.url||s.editor!==true||s.controlKnown!==true||s.historyAtLatest!==true||s.generating||s.composing||
      s.approvalRequired||s.accessLimited||s.blocked||s.loginRequired||s.stopped||
      s.attemptMarker===marker&&s.attemptMarkerCount>0||
      baseline&&(s.userId!==baseline.userId||s.assistantId!==baseline.assistantId))
      fail('send_preparation_public_baseline_changed');
    const c=await driver.dom(wc,'connector-state',{expectedConnector:connector});check();
    if(c.editorCount!==1||c.generating||c.composing||c.approvalRequired||c.accessLimited||c.blocked||
      !Array.isArray(c.selected)||!(c.selected.length===0||c.selected.length===1&&c.selected[0]===connector&&c.visibleSelectedCount===1)||
      !(c.text===''||c.text==='@'+connector&&c.selected.length===0))fail('send_preparation_query_changed');
    return {s,c};
  };
  let acceptedContext=null,acceptedBaseline=null,authorizedStartedAt=null,sendStarted=false;
  driver.busy.add(page.id);
  try{
    const before=await read();
    const model=await driver.inspect(page,check,{expectedBaseline:{url:before.s.url,userId:before.s.userId,assistantId:before.s.assistantId}});check();
    if(!sameModel(model.model,original.model)||!sameEffort(model.effort,original.effort))fail('send_preparation_original_model_changed');
    const fresh=await read(before.s),s=fresh.s,c=fresh.c;
    let proof=driver.sendFailures.get(page.id);
    if(payload.legacy_incident){
      if(payload.legacy_incident!=='example-send-preparation'||proof)fail('send_preparation_proof_conflict');
      proof={legacy_incident:payload.legacy_incident};
    }else if(!proof||proof.send_invoked!==false||proof.known_not_sent!==true||proof.attempt_id!==attemptId||
      proof.request_id!==requestId||proof.account!==account||proof.url!==s.url||
      proof.document_generation!==documentGeneration||proof.connection_generation!==connection||
      proof.user_turn_sha256!==hash(s.userId)||proof.assistant_turn_sha256!==hash(s.assistantId))
      fail('send_preparation_preclick_proof_missing');
    const prepared=await driver.runtime.call('prepared',{page_id:page.id,attempt_id:attemptId});check();
    const changedFailureBaseline=prepared.assistant_before_hash!==hash(s.assistantId);
    if(changedFailureBaseline&&!payload.legacy_incident)fail('send_preparation_public_baseline_changed');
    if(!changedFailureBaseline)acceptedContext=await driver.acceptedSendContext(page,s,{request_id:requestId,attempt_id:attemptId,prompt_hash:prepared.prompt_hash});
    acceptedBaseline=s;check();
    const grant=await driver.runtime.call('reconcile-send-preparation',{
      page_id:page.id,url:s.url,operation_id:operationId,expected_request_id:requestId,expected_attempt_id:attemptId,
      browser:{url:s.url,account,model:model.model,effort:model.effort,user_turn_sha256:hash(s.userId),assistant_turn_sha256:hash(s.assistantId),
        attempt_marker:marker,attempt_marker_count:0,editor_ready:true,controls_known:true,history_at_latest:true,
        generating:false,composing:false,approval_required:false,access_limited:false,blocked:false,login_required:false,stopped:false,
        composer:{editor_count:1,text_bytes:Buffer.byteLength(c.text,'utf8'),text_sha256:hash(c.text),selected:c.selected},
        ...(changedFailureBaseline?{baseline_previous_marker:s.attemptMarker,baseline_previous_marker_count:s.attemptMarkerCount,
          failure:s.failure,complete:s.complete}:{})},proof});
    check();
    if(grant.authorized!==true)return {state:'original_preparation_reconciliation_recorded',attempt_id:attemptId,model_sends:0};
    authorizedStartedAt=Date.now();
    if(grant.state!=='prepared_send_recovery_authorized'||grant.attempt_id!==attemptId||grant.request_id!==requestId||
      typeof grant.prompt!=='string'||hash(grant.prompt)!==grant.prompt_hash||
      grant.previous_user_hash!==hash(s.userId)||grant.assistant_before_hash!==hash(s.assistantId))
      fail('send_preparation_original_grant_invalid');
    if(prepared.prompt_hash!==grant.prompt_hash)fail('send_preparation_original_grant_invalid');
    if(!acceptedContext)acceptedContext=await driver.acceptedSendContext(page,s,{request_id:requestId,attempt_id:attemptId,prompt_hash:grant.prompt_hash});
    const context=acceptedContext;
    check();const last=await read(s);
    context.requireOpen();
    if(last.c.text){
      const cleared=await driver.dom(wc,'connector-clear-query',{expectedConnector:connector,expectedText:'@'+connector,
        reconciliationId:operationId,expectedBaseline:{url:s.url,userId:s.userId,assistantId:s.assistantId}});
      context.requireOpen();check();if(cleared?.cleared!==true)fail('send_preparation_query_clear_unconfirmed');
    }
    await context.verifyOriginalPrepared();check();
    const pending={attempt:attemptId,assistantBefore:hash(s.assistantId)};driver.pending.set(page.id,pending);
    sendStarted=true;
    const sent=await driver.send(page,grant.prompt+'\n'+marker,s,marker,context);
    await driver.wire(original,'sent',driver.pageState(sent,model),{attempt_id:attemptId,assistant_before_hash:pending.assistantBefore});
    driver.sendFailures.delete(page.id);driver.failures.delete(page.id);
    page.observation={...page.observation,error:null,reconciledPreparation:{operation_id:operationId,attempt_id:attemptId,at:Date.now()}};
    return {state:'original_prepared_send_confirmed',request_id:requestId,attempt_id:attemptId,
      no_new_request:true,no_new_dispatch:true,model_sends:1};
  }catch(error){
    // Losing a reply after Send starts remains unknown. A positively failed
    // query cleanup before that call can retain a new, bounded pre-click proof.
    if(authorizedStartedAt!==null&&!sendStarted&&new Set(['send_preparation_query_changed',
      'send_preparation_query_clear_unconfirmed','editor_focus_failed','editor_selection_missing',
      'editor_selection_foreign','send_baseline_changed']).has(error.code||error.message)){
      try{
        await acceptedContext.verifyOriginalPrepared();check();await read(acceptedBaseline);check();
        const proof={page_id:page.id,thread_id:original.thread_id,request_id:requestId,attempt_id:attemptId,account,url:original.url,
          document_generation:documentGeneration,connection_generation:connection,user_turn_sha256:hash(acceptedBaseline.userId),
          assistant_turn_sha256:hash(acceptedBaseline.assistantId),marker,stage:'recovery-preparation',send_invoked:false,
          started_at:authorizedStartedAt,at:Date.now(),error_code:error.code||error.message,known_not_sent:true};
        driver.sendFailures.set(page.id,proof);page.observation={...page.observation,sendPreparation:proof};
      }catch{/* A changed draft or unavailable original proof is retained for reconciliation. */}
    }
    throw error;
  }finally{driver.busy.delete(page.id);}
}
module.exports={reconcileSendPreparation};
