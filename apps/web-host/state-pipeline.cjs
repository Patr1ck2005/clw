'use strict';

// The task ledger and record-history own receipts and bodies. This module only
// projects their current public state; it never issues a command or retries one.
const OBSERVATION_FIELDS=['at','url','editorReady','historyReady','historyAtLatest','userTurnHash','attemptId',
  'generating','failure','complete','approvalRequired','draft','composing','loginRequired','effortLabel',
  'model','modelCheckedAt','error','errorAt','unknown','fault','fileApproval','publicProcess'];
function projectObservation(value){
  if(!value)return null;
  return Object.fromEntries(OBSERVATION_FIELDS.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
}
function projectTaskRelations(records){
  records=[...records];const byTarget=new Map(),relations=new Map();
  for(const record of records)if(record.target_id){
    if(byTarget.has(record.target_id))byTarget.set(record.target_id,null);else byTarget.set(record.target_id,record);
  }
  for(const record of records){
    const target=record.stop_scope?.parent_target??record.parent_target??null;
    const parent=target?byTarget.get(target):null;
    relations.set(record.page_id,{target_id:record.target_id,parent_target:record.parent_target||null,
      parent:parent?.page_id||null,parent_identity_unavailable:!!target&&!parent});
  }
  return relations;
}
function projectPage(page,selected){
  const result={...page,observation:projectObservation(page.observation),
    has_first_turn_instructions:!!String(page.first_turn_instructions||'').trim(),
    has_first_turn_draft:!!String(page.firstTurnDraft||'').trim()};
  // Bound first-turn prose already has a record-history entry and a saved
  // backend draft. Daily page status must not retransmit it with every pulse.
  if(page.id!==selected||page.bound===true){
    delete result.firstTurnDraft;delete result.first_turn_instructions;
  }
  // Goal prose and human feedback belong to the selected ledger view or an
  // explicit goal-read. Page heartbeats carry only navigation metadata.
  if(result.goal){const {objective,review,next,...metadata}=result.goal;result.goal=metadata;}
  if(page.id!==selected){
    if(result.observation)delete result.observation.publicProcess;
    // Preparation status participates in navigation, but its original prose is
    // only needed when this task is selected. Keep the outcome and references.
    if(result.preparation_result){const {text,public_text,reply,...metadata}=result.preparation_result;result.preparation_result=metadata;}
    if(result.intake?.latest_public_reply){const reply=result.intake.latest_public_reply;
      result.intake={...result.intake,latest_public_reply:{...reply,
        ...(typeof reply.public_text==='string'?{public_text:reply.public_text.slice(0,600),public_text_length:reply.public_text.length}:{})}};
    }
  }
  return result;
}
function projectWorkspaceState(state){
  const view=state.view?.page_id===state.selected?state.view:null;
  return {...state,pages:(state.pages||[]).map(page=>projectPage(page,state.selected)),view,
    closed:(state.closed||[]).map(({firstTurnDraft,first_turn_instructions,...page})=>page)};
}
// Sampling times change frequently even when the task does not. They remain in
// the published snapshot, while a bounded heartbeat refreshes their freshness.
// Receipt IDs, terminal states, errors, body revisions and history rows are all
// retained in the comparison.
function comparisonState(state){
  const pages=(state.pages||[]).map(page=>{
    if(!page.observation)return page;
    const {at,modelCheckedAt,...observation}=page.observation;
    return {...page,observation};
  });
  const codexWeb=state.codexWeb?{...state.codexWeb}:state.codexWeb;
  if(codexWeb?.nativeActivity){const {lastReadAtMs,...activity}=codexWeb.nativeActivity;codexWeb.nativeActivity=activity;}
  if(codexWeb?.displayIndex){const {lastRefreshAtMs,...index}=codexWeb.displayIndex;codexWeb.displayIndex=index;}
  return {...state,pages,codexWeb};
}
const stateSignature=state=>JSON.stringify(comparisonState(state));
class StatePublisher {
  constructor({collect,send,onProjection=()=>{},onError=()=>{},schedule=setImmediate,cancel=clearImmediate,now=Date.now,heartbeatMs=10000}){
    Object.assign(this,{collect,send,onProjection,onError,schedule,cancel,now,heartbeatMs});
    this.metrics={requests:0,collections:0,published:0,unchanged:0,bytes:0,fullSnapshots:0,patches:0};
    this.lastSent=-Infinity;this.closed=false;this.revision=0;this.fieldSignatures=new Map();
  }
  request({force=false}={}){
    if(this.closed)return;
    this.metrics.requests++;this.force=this.force||force;
    if(this.scheduled!==undefined)return;
    this.scheduled=this.schedule(()=>{this.scheduled=undefined;this.flush();});
  }
  flush(){
    if(this.closed)return false;
    if(this.scheduled!==undefined){this.cancel(this.scheduled);this.scheduled=undefined;}
    const force=this.force;this.force=false;
    try{
      const state=projectWorkspaceState(this.collect());this.metrics.collections++;
      try{this.onProjection(state);}catch(error){this.onError(error);}
      const comparable=comparisonState(state),signatures=new Map(),changed={};
      for(const [key,value]of Object.entries(comparable)){
        const signature=JSON.stringify(value);signatures.set(key,signature);
        if(this.fieldSignatures.get(key)!==signature)changed[key]=state[key];
      }
      for(const key of this.fieldSignatures.keys())if(!signatures.has(key))changed[key]=null;
      const now=this.now(),heartbeat=now-this.lastSent>=this.heartbeatMs,full=force||this.revision===0;
      if(!full&&!heartbeat&&!Object.keys(changed).length){this.metrics.unchanged++;return false;}
      // Fresh observation timestamps matter, but unchanged history/catalogs do
      // not belong in a heartbeat. All patches keep the original field shapes.
      if(heartbeat&&!full)changed.pages=state.pages;
      const revision=this.revision+1,packet=full?{...state,statePatch:false,stateRevision:revision}:
        {...changed,statePatch:true,baseRevision:this.revision,stateRevision:revision};
      this.send(packet);this.fieldSignatures=signatures;this.revision=revision;this.lastSent=now;
      this.metrics.published++;this.metrics.bytes+=Buffer.byteLength(JSON.stringify(packet));
      this.metrics[full?'fullSnapshots':'patches']++;return true;
    }catch(error){this.force=this.force||force;this.onError(error);return false;}
  }
  close(){this.closed=true;if(this.scheduled!==undefined)this.cancel(this.scheduled);this.scheduled=undefined;}
}

// A read started for A must not become A's current view after A -> B -> A, a
// runtime reconnect, or a new request. Both identity and selection generation
// are checked. Metadata polling is independent from diagnostic persistence.
class SelectedViewPoller {
  constructor({identity,read,readActivity=null,onView,onError=()=>{},now=Date.now,intervalMs=2500}){
    Object.assign(this,{identity,read,readActivity,onView,onError,now,intervalMs});this.generation=0;this.key=null;this.lastRead=-Infinity;
    this.quiesced=false;this.pendingReads=new Set();
  }
  invalidate(){this.generation++;this.key=null;this.lastRead=-Infinity;}
  quiesce({timeoutMs=10000}={}){
    // Close admission synchronously. Existing reads remain real, owned RPCs;
    // timeout never cancels them or clears their original pending identity.
    this.quiesced=true;
    const pending=[...this.pendingReads];
    if(!pending.length)return Promise.resolve({drained:true,pending:0});
    let timer;
    const timeout=new Promise(resolve=>{timer=setTimeout(resolve,Number.isFinite(timeoutMs)?Math.max(0,timeoutMs):10000);});
    return Promise.race([Promise.allSettled(pending),timeout]).then(()=>
      ({drained:this.pendingReads.size===0,pending:this.pendingReads.size})).finally(()=>clearTimeout(timer));
  }
  resume(){this.quiesced=false;}
  refresh({force=false}={}){
    if(this.quiesced)return Promise.resolve(false);
    const identity=this.identity(),key=identity?JSON.stringify(identity):null;
    if(key!==this.key){this.generation++;this.key=key;this.lastRead=-Infinity;this.onView(null);}
    if(!identity)return Promise.resolve(false);
    if(this.inflight?.key===key&&this.inflight.generation===this.generation)return this.inflight.promise;
    if(!force&&this.now()-this.lastRead<this.intervalMs)return Promise.resolve(false);
    const generation=this.generation;this.lastRead=this.now();
    const pending={key,generation};
    if(this.readActivity)this.startActivity(identity,key,generation);
    pending.promise=Promise.resolve().then(()=>this.read(identity)).then(value=>{
      if(generation!==this.generation||JSON.stringify(this.identity())!==key)return false;
      if(!value||value.page_id!==identity.pageId||(identity.threadId&&value.thread_id!==identity.threadId))throw Error('selected_view_identity_mismatch');
      pending.view=value;this.latestAccepted=pending;this.onView(this.withActivity(pending));return true;
    }).catch(error=>{
      if(generation===this.generation&&JSON.stringify(this.identity())===key)this.onError(error);
      return false;
    }).finally(()=>{if(this.inflight===pending)this.inflight=null;this.pendingReads.delete(pending.promise);});
    this.pendingReads.add(pending.promise);
    this.inflight=pending;return pending.promise;
  }
  withActivity(pending){
    const activity=this.activity;
    if(!activity||activity.key!==pending.key||activity.generation!==pending.generation)return pending.view;
    return {...pending.view,session_activity:activity.value,
      session_activity_loading:!activity.settled&&!activity.hasRead,session_activity_unavailable:activity.unavailable};
  }
  startActivity(identity,key,generation){
    if(this.quiesced)return Promise.resolve(false);
    if(this.activity?.key===key&&this.activity.generation===generation&&
      (!this.activity.settled||this.now()-this.activity.at<this.intervalMs))return this.activity.promise;
    const previous=this.activity?.key===key&&this.activity.generation===generation?this.activity:null;
    const activity={key,generation,at:this.now(),value:previous?.value||null,hasRead:!!previous?.hasRead,
      settled:false,unavailable:!!previous?.unavailable};this.activity=activity;
    activity.promise=Promise.resolve().then(()=>this.readActivity(identity)).then(value=>{activity.value=value;activity.unavailable=false;},()=>{activity.unavailable=true;})
      .finally(()=>{
        try{
          activity.settled=true;activity.hasRead=true;activity.at=this.now();const pending=this.latestAccepted;
          if(this.activity===activity&&generation===this.generation&&pending?.key===key&&pending.generation===generation&&
            JSON.stringify(this.identity())===key)this.onView(this.withActivity(pending));
        }finally{this.pendingReads.delete(activity.promise);}
      });
    this.pendingReads.add(activity.promise);return activity.promise;
  }
}
module.exports={projectObservation,projectTaskRelations,projectPage,projectWorkspaceState,stateSignature,StatePublisher,SelectedViewPoller};
