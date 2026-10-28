'use strict';
const {createHash}=require('node:crypto');
const {connectorForAccount}=require('./connector-identity.cjs');

const digest=value=>createHash('sha256').update(value).digest('hex');
const SHA256=/^[a-f0-9]{64}$/;
const EXECUTION=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Object.assign(Error(code),{code,accepted:false});};
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value===undefined?null:value);
}
function reservation(row){
  const fields=['page_id','target_id','parent_target','thread_id','root','title','model','effort','url',
    'phase','bootstrap_state','paused','own_paused','account','access','write_paths','resources',
    'collaboration_protocol','first_turn_mode','bootstrap_model_selection','work_model_pending',
    'latest_request','issue_kind','attention','observed_stop_user_hash','resumed_stop_user_hash','successor','successor_state'];
  const value=Object.fromEntries(fields.map(key=>[key,row?.[key]]));
  // Keep first-task identity without copying its prompt, ticket or token into
  // a recovery intent or an operator-visible receipt.
  for(const key of ['settings','bootstrap_text','first_turn_instructions','marker'])
    value[key+'_sha256']=digest(typeof row?.[key]==='string'?row[key]:canonical(row?.[key]));
  return digest(canonical(value));
}
function eligibleRecord(row,page){
  return !!row&&row.page_id===page.id&&row.account===page.account&&['A','B'].includes(row.account)&&
    typeof row.root==='string'&&!!row.root&&row.root===page.root&&row.phase==='reserved'&&
    row.bootstrap_state==='pending'&&row.paused===true&&row.own_paused===true&&
    row.issue_kind==='control_failed'&&row.thread_id===null&&row.latest_request===null&&
    !row.successor&&!row.successor_state&&
    !(row.observed_stop_user_hash&&row.resumed_stop_user_hash!==row.observed_stop_user_hash);
}
function emptyPublicBaseline(snapshot,url,draft){
  return !!snapshot&&snapshot.url===url&&snapshot.editor===true&&snapshot.controlKnown===true&&
    (snapshot.historyAtLatest===true||snapshot.historyAtLatest===null)&&snapshot.complete===false&&snapshot.draft===draft&&
    ['generating','composing','approvalRequired','accessLimited','blocked','loginRequired','stopped','usageLimited']
      .every(key=>snapshot[key]===false)&&
    ['userId','assistantId','userText','publicText','html','failure'].every(key=>snapshot[key]==='')&&
    snapshot.attemptMarker===null&&snapshot.attemptMarkerCount===0&&
    snapshot.bootstrapMarker===null&&snapshot.bootstrapMarkerCount===0&&!snapshot.error&&!snapshot.unknown&&snapshot.known!==false;
}

async function resetBootstrapQuery({driver,page,payload,operationId,assertCurrent,resetStore}){
  if(!object(payload)||Object.keys(payload).some(key=>!['id','expected_query_sha256','expected_connection_generation'].includes(key))||
     payload.id!==page?.id||!SHA256.test(payload.expected_query_sha256||'')||
     !Number.isSafeInteger(payload.expected_connection_generation)||payload.expected_connection_generation<0||
     !EXECUTION.test(operationId||'')||typeof assertCurrent!=='function'||
     typeof resetStore?.get!=='function'||typeof resetStore?.persist!=='function')fail('bootstrap_query_reset_invalid');
  const prior=resetStore.get();
  if(prior!==undefined&&prior!==null&&(!object(prior)||prior.state!=='cleared'||
     !EXECUTION.test(prior.operation_id||'')||prior.page_id!==page.id||prior.account!==page.account||prior.root!==page.root||
     !SHA256.test(prior.contract_sha256||'')||!SHA256.test(prior.query_sha256||'')||prior.operation_id===operationId))
    fail('bootstrap_query_original_operation_requires_reconciliation');
  const original=driver?.records?.get(page.id);
  if(!eligibleRecord(original,page))fail('bootstrap_query_reservation_unavailable');
  const connector=connectorForAccount(original.account),query='@'+connector;
  if(payload.expected_query_sha256!==digest(query))fail('bootstrap_query_digest_mismatch');
  const view=page.view,wc=view?.webContents,runtime=driver.runtime,pool=driver.pool;
  const documentGeneration=page.documentGeneration,connectionGeneration=driver.connectionGeneration;
  const originalBinding=reservation(original),url=wc?.getURL?.();
  if(!wc||!/^https:\/\/chatgpt\.com\/$/.test(url||'')||url!==original.url||
     driver.busy?.has(page.id)||driver.pending?.has(page.id)||driver.bootstrapPrepared?.has(page.id)||
     driver.approvals?.busy?.has?.(page.id))fail('bootstrap_query_original_operation_pending');
  let intent=null,clearInvoked=false;
  const check=()=>{
    assertCurrent();const row=driver.records.get(page.id);
    if(driver.stopped||driver.disposed||driver.observationQuiesced||driver.runtime!==runtime||runtime.closed||runtime.ready!==true||
       driver.recordsLoaded!==true||driver.pool!==pool||pool?.pages?.get(page.id)!==page||page.closed||
       page.view!==view||view.webContents!==wc||wc.isDestroyed?.()||page.documentGeneration!==documentGeneration||
       driver.connectionGeneration!==connectionGeneration||wc.getURL?.()!==url||!eligibleRecord(row,page)||reservation(row)!==originalBinding||
       driver.pending?.has(page.id)||driver.bootstrapPrepared?.has(page.id)||driver.approvals?.busy?.has?.(page.id))
      fail('bootstrap_query_original_identity_changed');
    const current=resetStore.get();
    if(intent?canonical(current)!==canonical(intent):canonical(current)!==canonical(prior))
      fail('bootstrap_query_reset_intent_changed');
  };
  const host=async expected=>{
    check();const proof=await runtime.call('bootstrap-query-reset-check',{page_id:page.id});check();
    if(proof?.eligible!==true||proof.code!=='bootstrap_query_reset_eligible'||proof.page_id!==page.id||
       proof.account!==original.account||proof.root!==original.root||proof.phase!=='reserved'||proof.bootstrap_state!=='pending'||
       proof.thread_id!==null||proof.own_paused!==true||proof.issue_kind!=='control_failed'||proof.budget_admitted!==false||
       !SHA256.test(proof.contract_sha256||''))fail('bootstrap_query_host_precondition_failed');
    if(expected&&canonical(proof)!==canonical(expected))fail('bootstrap_query_host_contract_changed');
    return proof;
  };
  const read=async draft=>{
    check();const snapshot=await driver.dom(wc,'snapshot');check();
    if(!emptyPublicBaseline(snapshot,url,draft))fail('bootstrap_query_public_baseline_changed');
    const composer=await driver.dom(wc,'connector-state',{expectedConnector:connector});check();
    if(composer?.editorCount!==1||!Array.isArray(composer.selected)||composer.selected.length!==0||composer.visibleSelectedCount!==0||
       ['generating','composing','approvalRequired','accessLimited','blocked'].some(key=>composer[key]!==false)||
       typeof composer.text!=='string'||composer.text!==(draft?query:'')||draft&&digest(composer.text)!==payload.expected_query_sha256)
      fail('bootstrap_query_public_query_changed');
    return snapshot;
  };
  const persist=value=>{
    // WorkspaceState.save is synchronous and flushes its atomic file. An
    // asynchronous/unconfirmed adapter cannot authorize a browser mutation.
    const result=resetStore.persist(value);
    if(result&&typeof result.then==='function'){
      void Promise.resolve(result).catch(()=>{});
      fail('bootstrap_query_reset_persistence_unconfirmed');
    }
    if(canonical(resetStore.get())!==canonical(value))fail('bootstrap_query_reset_persistence_unconfirmed');
    intent=value;
  };
  driver.busy.add(page.id);
  try{
    const proof=await host(),baseline=await read(true);
    await host(proof);check();
    persist({state:'pending',operation_id:operationId,contract_sha256:proof.contract_sha256,
      page_id:page.id,account:original.account,root:original.root,query_sha256:payload.expected_query_sha256});
    check();
    clearInvoked=true;
    const cleared=await driver.dom(wc,'connector-clear-query',{expectedConnector:connector,expectedText:query,
      reconciliationId:operationId,expectedBaseline:{url:baseline.url,userId:baseline.userId,assistantId:baseline.assistantId}});
    check();if(cleared?.cleared!==true)fail('bootstrap_query_clear_unconfirmed');
    await read(false);await host(proof);check();
    const pendingIntent=intent;
    try{persist({...pendingIntent,state:'cleared'});}
    catch(error){
      // A writer may update its in-memory object before a flush fails. Keep
      // the original pending intent available to both this owner and restart.
      intent=pendingIntent;try{resetStore.persist(pendingIntent);}catch{}
      throw error;
    }
    check();
    return {state:'bootstrap_query_cleared',page_id:page.id,operation_id:operationId,
      query_sha256:payload.expected_query_sha256,contract_sha256:proof.contract_sha256,
      model_sends:0,original_reservation_preserved:true,paused:true,issue_preserved:true};
  }catch(error){
    if(clearInvoked)throw Object.assign(Error('bootstrap_query_clear_unknown'),{
      code:'bootstrap_query_clear_unknown',accepted:true,cause:error,operation_id:operationId});
    const code=typeof error?.code==='string'?error.code:/^[a-z][a-z0-9_]{0,127}$/.test(error?.message||'')?error.message:'bootstrap_query_precheck_failed';
    throw Object.assign(Error(code),{code,accepted:false,cause:error});
  }finally{driver.busy.delete(page.id);}
}
module.exports={resetBootstrapQuery};
