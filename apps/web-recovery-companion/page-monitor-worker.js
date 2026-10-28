/* Exact-tab standalone recovery. No task host, network, model selection, or chat text. */
(() => {
  'use strict';
  const PROMPT='继续原任务。先核对已有成果和在途作业，从未完成处继续，完成当前所有可推进的工作。';
  const TAB_PREFIX='clwPageMonitorTab:',OWNER_PREFIX='clwPageMonitorOwner:',JOURNAL_PREFIX='clwPageMonitorJournal:';
  const BACKOFFS=Object.freeze([15000,45000,120000]);
  const CONNECTION_WAIT_LONG_MS=90000;
  const RELOAD_STALL_MS=180000,MAX_RELOADS=2;
  const KINDS=new Set(['idle','generating','cannot_think','generation_failed','connection_lost','connection_wait','unsupported','blocked','offline','draft']);
  const FAILURES=new Set(['cannot_think','generation_failed','connection_lost']);
  const STATES=new Set(['watching','backoff','waiting','paused','dispatching','clicked','unknown','exhausted','stopped']);
  const PHASES=new Set(['planned','dispatching','clicked','unknown']);
  const HASH=/^[0-9a-f]{64}$/;
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const CHAT=/^https:\/\/chatgpt\.com\/(?:g\/[A-Za-z0-9_-]{1,128}\/)?c\/[A-Za-z0-9-]{16,128}$/;
  const BOOLS=['controls_known','generating','draft','focused','composing','online','blocked','stopped','continuation_seen'];
  const SNAPSHOT_KEYS=['user_key','assistant_key','failure_key','kind',...BOOLS];
  const LEGACY_JOURNAL_KEYS=['version','retry_count','state','reason','kind','updated_at','observed_at','expected_user','baseline_failure','used_failures','pending','paused'];
  const WAIT_JOURNAL_KEYS=[...LEGACY_JOURNAL_KEYS,'connection_wait_since'];
  const JOURNAL_KEYS=[...WAIT_JOURNAL_KEYS,'last_progress_key','last_progress_at','reload_wait_since','reload_count','reload'];
  const RELOAD_KEYS=['tab_id','generation','old_document_id','requested_at','state'];
  const PENDING_KEYS=['attempt_id','user_key','assistant_key','failure_key','kind','phase','due_at'];
  const REASONS=new Set(['attached_waiting_baseline','initial_snapshot_observed','existing_failure_observed','watching_for_explicit_failure','failure_backoff','retry_due','generating','connection_wait','connection_wait_long','reload_requested','reload_unknown','reload_failed','reload_not_confirmed','reload_limit_reached','draft','focused','composing','offline','blocked','controls_unknown','user_stopped','manual_gesture','manual_takeover','dispatch_committed','click_reported_delivery_unconfirmed','delivery_unknown','continuation_delivered','not_sent','failure_already_granted','retry_limit_reached','explicit_stop','tab_removed','waiting_delivery_confirmation','storage_uncertain_explicit_start_required']);
  let tail=Promise.resolve();
  const storageUncertain=new Set();
  let activeTabId=null;
  // A single queue also protects URL ownership and journals shared by different tabs.
  const serialize=fn=>{const next=tail.catch(()=>{}).then(fn);tail=next;return next;};
  const forTab=(id,fn)=>serialize(async()=>{activeTabId=id;try{return await fn();}finally{activeTabId=null;}});
  const tabKey=id=>TAB_PREFIX+id,ownerKey=id=>OWNER_PREFIX+id,journalKey=id=>JOURNAL_PREFIX+id;
  const fail=code=>{throw Error(code);};
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
  const hash=x=>typeof x==='string'&&(x===''||HASH.test(x));
  const stamp=x=>Number.isSafeInteger(x)&&x>=0;
  const idValid=id=>Number.isSafeInteger(id)&&id>=0;
  const unresolved=j=>j.pending&&j.pending.phase!=='planned';
  const now=()=>Date.now();
  async function store(area,method,arg){
    try{return await chrome.storage[area][method](arg);}
    catch(error){storageUncertain.add(activeTabId);throw error;}
  }

  function validateMessage(m){
    if(!object(m)||typeof m.type!=='string')fail('monitor_message_invalid');
    const fields={
      'monitor-start':['type','tabId','chatUrl','confirm'],
      'monitor-status':['type','tabId','chatUrl'],
      'monitor-stop':['type','tabId','chatUrl'],
      'monitor-observe':['type','generation','snapshot'],
      'monitor-dispatch':['type','generation','attempt_id','snapshot'],
      'monitor-finish':['type','generation','attempt_id','result'],
      'monitor-gesture':['type','generation'],
    }[m.type];
    const optionalConfirm=['monitor-status','monitor-stop'].includes(m.type)&&Object.hasOwn(m,'confirm');
    if(!fields||!exact(m,optionalConfirm?[...fields,'confirm']:fields)||(optionalConfirm&&m.confirm!==true))fail('monitor_message_invalid');
    if(m.type==='monitor-start'&&m.confirm!==true)fail('monitor_explicit_confirmation_required');
    if(m.type==='monitor-start'||m.type==='monitor-status'||m.type==='monitor-stop'){
      if(!idValid(m.tabId)||typeof m.chatUrl!=='string'||!CHAT.test(m.chatUrl))fail('monitor_exact_chat_required');
    }else{
      if(typeof m.generation!=='string'||!UUID.test(m.generation))fail('monitor_generation_invalid');
      if(Object.hasOwn(m,'attempt_id')&&(typeof m.attempt_id!=='string'||!UUID.test(m.attempt_id)))fail('monitor_attempt_invalid');
      if(Object.hasOwn(m,'result')&&!['not_sent','clicked','unknown'].includes(m.result))fail('monitor_result_invalid');
      if(Object.hasOwn(m,'snapshot')){
        const s=m.snapshot;
        const progress=Object.hasOwn(s,'progress_key');
        if(!exact(s,progress?[...SNAPSHOT_KEYS,'progress_key']:SNAPSHOT_KEYS)||(progress&&!(typeof s.progress_key==='string'&&HASH.test(s.progress_key)))||!hash(s.user_key)||!hash(s.assistant_key)||!hash(s.failure_key)||!KINDS.has(s.kind)||!BOOLS.every(k=>typeof s[k]==='boolean'))fail('monitor_snapshot_invalid');
      }
    }
    if(JSON.stringify(m).length>2048)fail('monitor_message_too_large');
  }
  function validateBinding(b,id){
    if(!exact(b,['version','tabId','chatUrl','url_key','generation','documentId','baseline_pending'])||b.version!==1||b.tabId!==id||!CHAT.test(b.chatUrl)||!HASH.test(b.url_key)||!UUID.test(b.generation)||!(b.documentId===null||(typeof b.documentId==='string'&&b.documentId.length>0&&b.documentId.length<=256))||typeof b.baseline_pending!=='boolean')fail('monitor_binding_corrupt');
    return b;
  }
  function validateJournal(j){
    // 0.6.0 journals predate this metadata. Accept only that exact older schema.
    if(exact(j,LEGACY_JOURNAL_KEYS))j={...j,connection_wait_since:null};
    if(exact(j,WAIT_JOURNAL_KEYS))j={...j,last_progress_key:'',last_progress_at:null,reload_wait_since:null,reload_count:0,reload:null};
    if(!exact(j,JOURNAL_KEYS)||j.version!==1||!Number.isInteger(j.retry_count)||j.retry_count<0||j.retry_count>3||!STATES.has(j.state)||!REASONS.has(j.reason)||!KINDS.has(j.kind)||!stamp(j.updated_at)||!(j.observed_at===null||stamp(j.observed_at))||!(j.connection_wait_since===null||stamp(j.connection_wait_since))||!hash(j.last_progress_key)||!(j.last_progress_at===null||stamp(j.last_progress_at))||((j.last_progress_key==='')!==(j.last_progress_at===null))||!(j.reload_wait_since===null||stamp(j.reload_wait_since))||!Number.isInteger(j.reload_count)||j.reload_count<0||j.reload_count>MAX_RELOADS||!hash(j.expected_user)||!hash(j.baseline_failure)||!Array.isArray(j.used_failures)||j.used_failures.length!==j.retry_count||!j.used_failures.every(x=>typeof x==='string'&&HASH.test(x))||new Set(j.used_failures).size!==j.used_failures.length||typeof j.paused!=='boolean')fail('monitor_journal_corrupt');
    if(j.pending!==null){
      const p=j.pending;
      if(!exact(p,PENDING_KEYS)||!UUID.test(p.attempt_id)||![p.user_key,p.assistant_key,p.failure_key].every(x=>typeof x==='string'&&HASH.test(x))||!FAILURES.has(p.kind)||!PHASES.has(p.phase)||!stamp(p.due_at)||(p.phase!=='planned'&&!j.used_failures.includes(p.failure_key))||(p.phase==='planned'&&(j.retry_count>=3||j.used_failures.includes(p.failure_key))))fail('monitor_journal_corrupt');
    }
    if(j.reload!==null){
      const r=j.reload;
      if(!exact(r,RELOAD_KEYS)||!idValid(r.tab_id)||!UUID.test(r.generation)||typeof r.old_document_id!=='string'||!r.old_document_id||r.old_document_id.length>256||!stamp(r.requested_at)||!['requested','unknown','failed'].includes(r.state)||j.reload_count===0||j.pending!==null)fail('monitor_journal_corrupt');
    }
    return j;
  }
  async function urlKey(url){
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url));
    return Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
  }
  async function binding(id){const b=(await store('session','get',tabKey(id)))[tabKey(id)];return b===undefined?null:validateBinding(b,id);}
  async function journal(urlId){
    const j=(await store('local','get',journalKey(urlId)))[journalKey(urlId)];
    if(j===undefined)return null;
    const normalized=validateJournal(j);
    if(normalized!==j)await save(normalized,urlId);
    return normalized;
  }
  async function save(j,urlId){j.updated_at=now();validateJournal(j);await store('local','set',{[journalKey(urlId)]:j});}
  function fresh(){return {version:1,retry_count:0,state:'watching',reason:'attached_waiting_baseline',kind:'idle',updated_at:now(),observed_at:null,expected_user:'',baseline_failure:'',used_failures:[],pending:null,paused:false,connection_wait_since:null,last_progress_key:'',last_progress_at:null,reload_wait_since:null,reload_count:0,reload:null};}
  const connectionWaitMs=j=>j.connection_wait_since===null?0:Math.max(0,now()-j.connection_wait_since);
  const connectionWaitReason=j=>connectionWaitMs(j)>=CONNECTION_WAIT_LONG_MS?'connection_wait_long':'connection_wait';
  const reloadWaitMs=j=>j.reload_wait_since===null||j.last_progress_at===null?0:Math.max(0,now()-Math.max(j.reload_wait_since,j.last_progress_at));
  function view(j,b,extra={}){
    if(!j)return {state:'unbound',reason:'monitor_not_started',generation:null,attempts:0,kind:'idle',updated_at:null,observer_recent:false,connection_wait_since:null,connection_wait_ms:0,last_progress_at:null,reload_wait_since:null,reload_wait_ms:0,reload_count:0,reload_state:null,...extra};
    const uncertain=storageUncertain.has(b?.tabId??activeTabId);
    const state=!b?(j.state==='stopped'?'stopped':'unbound'):uncertain?'paused':j.state;
    const reason=!b&&j.state!=='stopped'?'monitor_not_started':uncertain?'storage_uncertain_explicit_start_required':j.reason;
    return {state,reason,generation:b?.generation||null,attempts:j.retry_count,kind:j.kind,updated_at:j.observed_at,state_updated_at:j.updated_at,observer_recent:!!b&&!b.baseline_pending&&j.observed_at!==null&&now()>=j.observed_at&&now()-j.observed_at<=45000,bound:!!b,connection_wait_since:j.connection_wait_since,connection_wait_ms:connectionWaitMs(j),last_progress_at:j.last_progress_at,reload_wait_since:j.reload_wait_since,reload_wait_ms:reloadWaitMs(j),reload_count:j.reload_count,reload_state:j.reload?.state||null,...(j.pending?{pending_result:j.pending.phase,...(j.pending.phase==='planned'?{next_retry_at:j.pending.due_at}:{})}:{}),...extra};
  }
  async function exactTab(m){
    const tab=await chrome.tabs.get(m.tabId);
    if(tab.id!==m.tabId||tab.url!==m.chatUrl||tab.pendingUrl)fail('monitor_tab_changed');
    return tab;
  }
  async function requireNoLegacy(id){
    const keys=['clwUnifiedTab:'+id,'clwRecoveryTab:'+id],saved=await store('session','get',keys);
    if(keys.some(k=>saved[k]!=null))fail('monitor_legacy_binding_active');
  }
  async function start(m){
    const tab=await exactTab(m);await requireNoLegacy(tab.id);
    const urlId=await urlKey(tab.url),oldBinding=await binding(tab.id),owner=(await store('session','get',ownerKey(urlId)))[ownerKey(urlId)];
    if(oldBinding&&oldBinding.chatUrl!==tab.url)fail('monitor_previous_binding_requires_stop');
    if(owner!==undefined){
      if(!exact(owner,['tabId','generation'])||!idValid(owner.tabId)||!UUID.test(owner.generation))fail('monitor_owner_corrupt');
      if(owner.tabId!==tab.id){
        const other=await binding(owner.tabId);
        if(other)fail('monitor_duplicate_url_owner');
        // An interrupted session removal can leave an owner without a live binding.
        await store('session','remove',ownerKey(urlId));
      }
    }
    const j=await journal(urlId)||fresh();
    if(unresolved(j))fail('monitor_delivery_unresolved');
    if(j.reload&&j.reload.tab_id!==tab.id)fail('monitor_reload_unresolved');
    j.paused=false;j.state=j.reload?'waiting':j.pending?'backoff':j.retry_count>=BACKOFFS.length?'exhausted':'watching';
    j.reason=j.reload?'reload_'+j.reload.state:j.pending?'failure_backoff':j.retry_count>=BACKOFFS.length?'retry_limit_reached':'attached_waiting_baseline';
    await save(j,urlId);
    const b={version:1,tabId:tab.id,chatUrl:tab.url,url_key:urlId,generation:j.reload?.generation||crypto.randomUUID(),documentId:null,baseline_pending:!j.reload};
    await store('session','set',{[tabKey(tab.id)]:b,[ownerKey(urlId)]:{tabId:tab.id,generation:b.generation}});
    storageUncertain.delete(tab.id);
    return view(j,b,{started:true});
  }
  async function disable(id,reason){
    const b=await binding(id);
    if(!b)return {stopped:true,bound:false};
    // Removing the session gate first also makes a failed durable stop fail closed.
    await store('session','remove',tabKey(id));
    const owner=(await store('session','get',ownerKey(b.url_key)))[ownerKey(b.url_key)];
    if(owner?.tabId===id&&owner.generation===b.generation)await store('session','remove',ownerKey(b.url_key));
    const j=await journal(b.url_key);
    if(j){if(j.pending?.phase==='planned')j.pending=null;j.paused=true;j.state='stopped';j.reason=reason;await save(j,b.url_key);}
    return view(j,null,{stopped:true,bound:false});
  }
  async function contentBinding(m,sender){
    if(!object(sender)||!sender.tab||!idValid(sender.tab.id)||sender.frameId!==0||typeof sender.documentId!=='string'||sender.documentId.length===0||sender.documentId.length>256)fail('monitor_top_document_required');
    let b=await binding(sender.tab.id);
    if(!b||sender.url!==b.chatUrl||sender.tab.url!==b.chatUrl||m.generation!==b.generation)fail('monitor_binding_mismatch');
    await exactTab({tabId:b.tabId,chatUrl:b.chatUrl});await requireNoLegacy(b.tabId);
    const owner=(await store('session','get',ownerKey(b.url_key)))[ownerKey(b.url_key)];
    if(owner?.tabId!==b.tabId||owner.generation!==b.generation)fail('monitor_owner_mismatch');
    if(b.documentId!==null&&b.documentId!==sender.documentId)fail('monitor_document_changed_explicit_start_required');
    // During an owned reload, only a different verified document may bind.
    const j=await journal(b.url_key);
    if(b.documentId===null&&!j?.reload){b={...b,documentId:sender.documentId};await store('session','set',{[tabKey(b.tabId)]:b});}
    return b;
  }
  function terminal(s){return FAILURES.has(s.kind)&&!s.generating;}
  function eligible(s){return terminal(s)&&!!s.user_key&&!!s.assistant_key&&!!s.failure_key;}
  function safeReason(s){
    if(s.stopped)return 'user_stopped';
    if(!s.online||s.kind==='offline')return 'offline';
    if(s.kind==='connection_wait')return 'connection_wait';
    if(s.generating||s.kind==='generating')return 'generating';
    if(s.draft||s.kind==='draft')return 'draft';
    if(s.focused)return 'focused';
    if(s.composing)return 'composing';
    if(s.blocked||s.kind==='blocked')return 'blocked';
    if(!s.controls_known||s.kind==='unsupported')return 'controls_unknown';
    return '';
  }
  const matches=(p,s)=>p.user_key===s.user_key&&p.assistant_key===s.assistant_key&&p.failure_key===s.failure_key&&p.kind===s.kind;
  function pause(j,reason){j.paused=true;j.state='paused';j.reason=reason;j.reload_wait_since=null;if(j.pending?.phase==='planned')j.pending=null;}
  function reloadSafe(s,b,j){
    return !j.paused&&!storageUncertain.has(b.tabId)&&!j.pending&&!j.reload&&s.kind==='connection_wait'&&s.online&&s.controls_known&&!s.draft&&!s.focused&&!s.composing&&!s.blocked&&!s.stopped&&!!s.user_key&&s.user_key===j.expected_user&&typeof s.progress_key==='string'&&HASH.test(s.progress_key);
  }
  function trackProgress(s,b,j){
    if(s.controls_known&&!['unsupported','offline'].includes(s.kind)&&s.progress_key&&s.progress_key!==j.last_progress_key){j.last_progress_key=s.progress_key;j.last_progress_at=now();}
    if(!reloadSafe(s,b,j))j.reload_wait_since=null;
    else if(j.reload_wait_since===null)j.reload_wait_since=now();
  }
  async function maybeReload(s,b,j){
    if(!reloadSafe(s,b,j)||reloadWaitMs(j)<RELOAD_STALL_MS)return null;
    if(j.reload_count>=MAX_RELOADS){j.reason='reload_limit_reached';return null;}
    // Persist the unique effect and invalidate the old observer before returning it.
    await exactTab({tabId:b.tabId,chatUrl:b.chatUrl});await requireNoLegacy(b.tabId);
    const generation=crypto.randomUUID();
    j.reload_count+=1;j.reload={tab_id:b.tabId,generation,old_document_id:b.documentId,requested_at:now(),state:'requested'};
    j.state='waiting';j.reason='reload_requested';
    await save(j,b.url_key);
    const next={...b,generation,documentId:null,baseline_pending:false};
    await store('session','set',{[tabKey(b.tabId)]:next,[ownerKey(b.url_key)]:{tabId:b.tabId,generation}});
    return view(j,next,{reload:{tabId:b.tabId,chatUrl:b.chatUrl,generation,documentId:b.documentId,user_key:j.expected_user,progress_key:j.last_progress_key}});
  }
  async function finishReloadImpl(id,generation,result){
    if(!idValid(id)||typeof generation!=='string'||!UUID.test(generation)||!['requested','unknown','failed'].includes(result))fail('monitor_reload_result_invalid');
    const b=await binding(id);if(!b)return null;
    const j=await journal(b.url_key);
    if(!j?.reload||j.reload.tab_id!==id||j.reload.generation!==generation||b.generation!==generation)return null;
    // A delayed weaker receipt cannot clear a failed/unknown result or a pause.
    if(j.reload.state==='failed'||(j.reload.state==='unknown'&&result==='requested'))return view(j,b);
    j.reload.state=result;
    if(result==='failed')pause(j,'reload_failed');
    else if(!j.paused){j.state='waiting';j.reason='reload_'+result;}
    await save(j,b.url_key);return view(j,b);
  }
  async function resumeAfterReloadImpl(id){
    if(!idValid(id))fail('monitor_tab_invalid');
    const b=await binding(id);if(!b)return null;
    const j=await journal(b.url_key);
    if(!j?.reload||j.paused||storageUncertain.has(id)||j.reload.state==='failed'||j.reload.tab_id!==id||j.reload.generation!==b.generation)return null;
    const tab=await exactTab({tabId:id,chatUrl:b.chatUrl});await requireNoLegacy(id);
    if(tab.status!=='complete')return null;
    // Only reinjection is permitted here. Never return another native reload grant.
    return {generation:b.generation};
  }
  async function observeReload(m,b,j,documentId){
    if(j.reload.generation!==b.generation||j.reload.tab_id!==b.tabId||documentId===j.reload.old_document_id){
      pause(j,'reload_not_confirmed');await save(j,b.url_key);return view(j,b);
    }
    const s=m.snapshot;
    if(s.stopped)pause(j,'user_stopped');
    if(!s.controls_known||!s.user_key){
      j.kind=s.kind;j.observed_at=now();if(!j.paused){j.state='waiting';j.reason='reload_'+j.reload.state;}
      await save(j,b.url_key);return view(j,b);
    }
    j.reload=null;j.reload_wait_since=null;
    if(j.last_progress_key)j.last_progress_at=now();
    b={...b,documentId,baseline_pending:false};
    await save(j,b.url_key);await store('session','set',{[tabKey(b.tabId)]:b});
    // The original expected user and failure baseline remain authoritative.
    return observe(m,b,j);
  }
  async function observe(m,b,j){
    const s=m.snapshot;j.kind=s.kind;j.observed_at=now();
    if(s.kind==='connection_wait'){
      if(j.connection_wait_since===null)j.connection_wait_since=j.observed_at;
    }else if(!['unsupported','offline'].includes(s.kind))j.connection_wait_since=null;
    if(storageUncertain.has(b.tabId))pause(j,'storage_uncertain_explicit_start_required');
    if(s.stopped)pause(j,'user_stopped');
    if(b.baseline_pending){
      // An incomplete DOM is not a user turn. Keep waiting for a usable baseline
      // instead of later interpreting the first real user key as manual input.
      if(!s.controls_known||!s.user_key){
        if(!j.paused){j.state='waiting';j.reason='controls_unknown';}
        await save(j,b.url_key);return view(j,b);
      }
      // A banner while Stop is visible is not yet an old terminal failure.
      if(!j.pending){
        // Only an explicit start followed by a genuinely new manual user turn
        // begins a new chain. Rebinding the same turn or an automatic continuation
        // keeps the original budget, and pending work can never be reset here.
        if(j.expected_user&&s.user_key!==j.expected_user&&!s.continuation_seen){j.retry_count=0;j.used_failures=[];j.reload_count=0;j.last_progress_key='';j.last_progress_at=null;j.reload_wait_since=null;j.connection_wait_since=s.kind==='connection_wait'?now():null;}
        j.expected_user=s.user_key;j.baseline_failure=terminal(s)?s.failure_key:'';
      }
      b={...b,baseline_pending:false};
      trackProgress(s,b,j);
      if(!j.paused){
        j.state=j.pending?'backoff':j.retry_count>=BACKOFFS.length?'exhausted':'watching';j.reason='initial_snapshot_observed';
        if(s.kind==='connection_wait'){j.state='waiting';j.reason=safeReason(s)==='offline'?'offline':connectionWaitReason(j);}
      }
      await save(j,b.url_key);await store('session','set',{[tabKey(b.tabId)]:b});
      return view(j,b);
    }
    trackProgress(s,b,j);
    if(unresolved(j)){
      if(s.user_key&&s.user_key!==j.pending.user_key&&s.continuation_seen){
        j.expected_user=s.user_key;j.pending=null;
        j.state=j.paused?'paused':j.retry_count>=3?'exhausted':'watching';j.reason=j.paused?'manual_gesture':'continuation_delivered';
      }else{
        if(s.user_key!==j.expected_user)pause(j,'manual_takeover');
        else if(!j.paused){j.state=j.pending.phase;j.reason='waiting_delivery_confirmation';}
      }
      await save(j,b.url_key);return view(j,b);
    }
    if(s.user_key!==j.expected_user)pause(j,'manual_takeover');
    if(j.paused){await save(j,b.url_key);return view(j,b);}
    if(s.kind==='connection_wait'){
      j.state='waiting';j.reason=safeReason(s)==='offline'?'offline':connectionWaitReason(j);
      const reload=await maybeReload(s,b,j);if(reload)return reload;
      await save(j,b.url_key);return view(j,b);
    }
    if(j.retry_count>=3){j.state='exhausted';j.reason='retry_limit_reached';await save(j,b.url_key);return view(j,b);}
    const unsafe=safeReason(s);
    if(unsafe){j.state='waiting';j.reason=unsafe;await save(j,b.url_key);return view(j,b);}
    if(!eligible(s)){
      j.pending=null;j.state='watching';j.reason='watching_for_explicit_failure';
    }else if(s.failure_key===j.baseline_failure){
      j.pending=null;j.state='watching';j.reason='existing_failure_observed';
    }else if(j.used_failures.includes(s.failure_key)){
      j.pending=null;j.state='watching';j.reason='failure_already_granted';
    }else{
      if(!j.pending||!matches(j.pending,s))j.pending={attempt_id:crypto.randomUUID(),user_key:s.user_key,assistant_key:s.assistant_key,failure_key:s.failure_key,kind:s.kind,phase:'planned',due_at:now()+BACKOFFS[j.retry_count]};
      j.state='backoff';j.reason=now()>=j.pending.due_at?'retry_due':'failure_backoff';
    }
    await save(j,b.url_key);
    return view(j,b,j.pending&&now()>=j.pending.due_at?{offer:{attempt_id:j.pending.attempt_id,prompt:PROMPT}}:{});
  }
  async function dispatch(m,b,j){
    const s=m.snapshot,p=j.pending;
    if(storageUncertain.has(b.tabId)||b.baseline_pending||j.paused||j.reload||!p||p.phase!=='planned'||p.attempt_id!==m.attempt_id||j.retry_count>=3||now()<p.due_at||s.user_key!==j.expected_user||!matches(p,s)||!eligible(s)||safeReason(s)||j.used_failures.includes(s.failure_key))fail('monitor_dispatch_not_permitted');
    p.phase='dispatching';j.retry_count+=1;j.used_failures.push(p.failure_key);j.state='dispatching';j.reason='dispatch_committed';j.kind=s.kind;
    // This is the only sending grant. Persistence must complete before it is returned.
    await save(j,b.url_key);
    return view(j,b,{dispatch:true,prompt:PROMPT,attempt_id:p.attempt_id});
  }
  async function finish(m,b,j){
    if(!j.pending||j.pending.attempt_id!==m.attempt_id||j.pending.phase==='planned')fail('monitor_attempt_mismatch');
    if(m.result==='not_sent'){
      // Once a click/unknown was reported, a late weaker receipt cannot erase it.
      if(j.pending.phase!=='dispatching')fail('monitor_delivery_unresolved');
      j.pending=null;j.state=j.paused?'paused':j.retry_count>=3?'exhausted':'watching';j.reason='not_sent';
    }else{
      if(j.pending.phase==='unknown'&&m.result==='clicked')return view(j,b);
      j.pending.phase=m.result;j.state=j.paused?'paused':m.result;j.reason=m.result==='clicked'?'click_reported_delivery_unconfirmed':'delivery_unknown';
    }
    await save(j,b.url_key);return view(j,b);
  }
  async function handleImpl(m,sender){
    validateMessage(m);
    if(['monitor-start','monitor-status','monitor-stop'].includes(m.type)){
      if(!sender||sender.tab||sender.url!==chrome.runtime.getURL('popup.html'))fail('monitor_explicit_popup_required');
      if(m.type==='monitor-start')return start(m);
      await exactTab(m);
      if(m.type==='monitor-stop')return disable(m.tabId,'explicit_stop');
      const b=await binding(m.tabId);
      if(b&&b.chatUrl!==m.chatUrl)fail('monitor_binding_mismatch');
      return view(await journal(await urlKey(m.chatUrl)),b);
    }
    const b=await contentBinding(m,sender),j=await journal(b.url_key);
    if(!j)fail('monitor_journal_missing');
    if(j.reload&&m.type==='monitor-observe')return observeReload(m,b,j,sender.documentId);
    if(m.type==='monitor-observe')return observe(m,b,j);
    if(m.type==='monitor-dispatch')return dispatch(m,b,j);
    if(m.type==='monitor-finish')return finish(m,b,j);
    pause(j,'manual_gesture');await save(j,b.url_key);return view(j,b);
  }
  globalThis.CLWPageMonitorWorker=Object.freeze({
    PROMPT,
    handle:(message,sender)=>forTab(sender?.tab?.id??message?.tabId??null,()=>handleImpl(message,sender)),
    isBound:id=>forTab(id,async()=>{if(!idValid(id))return false;return !!await binding(id);}),
    stopForTab:id=>forTab(id,async()=>{if(!idValid(id))fail('monitor_tab_invalid');return disable(id,'tab_removed');}),
    finishReload:(id,generation,result)=>forTab(id,()=>finishReloadImpl(id,generation,result)),
    resumeAfterReload:id=>forTab(id,()=>resumeAfterReloadImpl(id)),
    cancelReload:(id,generation,snapshot)=>forTab(id,async()=>{
      const b=await binding(id);if(!b)return null;const j=await journal(b.url_key);
      if(!j?.reload||j.reload.generation!==generation||b.generation!==generation)return null;
      const oldDocument=j.reload.old_document_id;
      validateMessage({type:'monitor-observe',generation,snapshot});
      // Only a pinned old document that explicitly returned before navigation
      // may cancel this reservation. Unknown native effects use finishReload.
      j.reload=null;j.reload_count=Math.max(0,j.reload_count-1);j.reload_wait_since=null;
      j.kind=snapshot.kind;j.observed_at=now();
      if(snapshot.stopped||snapshot.user_key!==j.expected_user)pause(j,'manual_takeover');
      else{j.state='watching';j.reason='watching_for_explicit_failure';}
      const next={...b,documentId:oldDocument,baseline_pending:false};trackProgress(snapshot,next,j);
      await save(j,b.url_key);await store('session','set',{[tabKey(id)]:next});return view(j,next);
    }),
    // Private service-worker entry used only after the local operator broker
    // authenticates and durably claims an exact-page command. No content wire.
    control:(action,id,chatUrl)=>forTab(id,async()=>{
      if(!idValid(id)||typeof chatUrl!=='string'||!CHAT.test(chatUrl))fail('monitor_exact_chat_required');
      await exactTab({tabId:id,chatUrl});
      if(action==='start')return start({tabId:id,chatUrl,confirm:true});
      if(action==='stop')return disable(id,'explicit_stop');
      if(action!=='status')fail('monitor_control_action_invalid');
      const b=await binding(id);if(b&&b.chatUrl!==chatUrl)fail('monitor_binding_mismatch');
      return view(await journal(await urlKey(chatUrl)),b);
    }),
  });
})();
