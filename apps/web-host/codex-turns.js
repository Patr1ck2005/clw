'use strict';
(function(scope){
  const record=typeof module==='object'&&module.exports?require('./work-record.js'):scope.CLWWorkRecord;
  const failures=typeof module==='object'&&module.exports?require('./failure-state.js'):scope.CLWFailure;
  function displayIndexNotice(index){
    if(index?.unavailable)return '工作记录暂不可用，已保留上次读取的条目。';
    if(index?.stale)return '工作记录待更新，正在保留上次读取的条目。';
    if(index?.loading)return '正在读取工作记录…';
    return '';
  }
  function turnView(row){
    const s=row.source,known=!!s?.threadId&&!(s.traceId&&row.traceId&&s.traceId!==row.traceId);
    const blocker=row.review?.reportedBlockers?.[0];
    const nativeFailed=row.nativeState?.state==='failed';
    const nativeAborted=row.nativeState?.state==='aborted';
    const nativeCompleted=row.nativeState?.state==='completed';
    const needsAttention=nativeFailed||['failed','needs_reconciliation'].includes(row.status)||!!blocker;
    const navigationFailed=row.status==='failed'&&row.failure?.kind==='page_navigation_timeout';
    const navigationBeforeSend=navigationFailed&&row.failure.beforeSend===true&&row.submission==='not-observed'&&row.failure.submissionObserved!==true;
    const observationFailed=row.status==='failed'&&(row.observationUnavailable===true||
      ['page_snapshot_timeout','observation_timeout','page_observation_timeout'].includes(row.failure?.kind));
    const failureType=nativeFailed?'native_execution':nativeAborted?'native_stopped':
      navigationFailed?(navigationBeforeSend?'before_send':'web_navigation'):observationFailed?'web_observation':
      row.status==='failed'?'web_turn':row.status==='aborted'?'web_stopped':row.status==='needs_reconciliation'?'reconciliation':null;
    const status=nativeFailed?'! 执行失败 · 需要处理':nativeAborted?'Ⅱ 原生本轮已停止':blocker&&row.status==='completed'?'! 本轮结束 · 报告待核对':
      row.status==='running'?(row.submission==='confirmed'?'● 思考／工作':'发送 · 核对回执'):
      row.status==='completed'?(nativeCompleted?'■ 本轮完成 · 结果待验收':'等待／回收 · 网页已结束'):
      row.status==='failed'?(nativeCompleted?'! 本轮执行已完成 · 网页异常':observationFailed?'! 网页状态读取异常 · 原执行待核对':'! 网页回合异常 · 原执行待核对'):
      ({aborted:'Ⅱ 网页回合已停止 · 原执行待核对',needs_reconciliation:'! 状态待核对'})[row.status]||'状态待核对';
    const step=needsAttention||nativeAborted||['aborted','needs_reconciliation'].includes(row.status)?null:
      row.status==='running'?(row.submission==='confirmed'?1:0):row.status==='completed'?(nativeCompleted?3:2):null;
    const sent=navigationBeforeSend?'尚未发送':({confirmed:'已确认送达',unconfirmed:'送达待核对','not-observed':row.status==='running'?'等待送达回执':'未观察到送达'})[row.submission]||'送达未知';
    const alerts=(row.publicState?.alerts||[]).join(' ');
    const knownFault=failures.describe(row.failure?.kind);
    const failure=knownFault?knownFault.title+'：'+knownFault.detail:navigationFailed?(navigationBeforeSend?'打开网页超时，任务尚未发送；没有自动重发。':'网页导航超时，原发送状态仍需核对；不会重复发送。'):/Failed to fetch|network|网络/i.test(alerts)?'网页连接失败。先核对原执行，再从 Codex 接续；不要在旧网页重复发送。':
      observationFailed?'网页状态读取失败，当前显示可能未更新。请在原 Codex 核对执行记录和已保存结果；读取异常不表示原生执行已停止。':
      row.status==='failed'?'网页回合出现异常。请在原 Codex 核对执行状态、错误和已完成工作；没有重新发送原消息。':null;
    const nativeIdentityMatches=!(row.nativeState?.threadId&&s?.threadId&&row.nativeState.threadId!==s.threadId);
    const nativeTurnMatches=!(row.nativeState?.turnId&&s?.turnId&&row.nativeState.turnId!==s.turnId);
    const handoffNote=known?'接续请从原 Codex 任务发起；按原执行记录核对已完成工作与待处理事项。':'请先从 Codex 任务列表核对原任务，再查看执行记录；不按时间猜测来源。';
    return {status,step,sent,known,needsAttention,failureType,noteNeedsAttention:needsAttention||!!failure,canResume:known&&!!s.workingDirectory&&nativeIdentityMatches&&nativeTurnMatches&&['completed','aborted','failed'].includes(row.status)&&['completed','aborted','failed'].includes(row.nativeState?.state),
      title:known?(s.workingDirectory||'Codex 任务').replace(/[\\/]+$/,'').split(/[\\/]/).at(-1):'来源待核对',
      detail:known?'Codex '+s.threadId:'旧记录缺少来源映射；请从 Codex 任务列表选择，不按时间猜测。',
      model:s?.model?.replace('chatgpt-web/','')||'原模型未记录',
      note:nativeFailed?(row.nativeState.reason==='compaction_failed'?'原生 Codex 已因上下文压缩失败退出。':'原生 Codex 本轮已失败退出。')+'网页结束不代表执行完成；原任务和已完成工作保留，请核对后接续。':
        nativeAborted?'原生 Codex 本轮已停止，原任务和已有成果保留。'+handoffNote:
        blocker?(row.status==='completed'?'网页回合已结束，拒绝可能发生在本轮早期；核对后续工具回执和实际成果。':'')+blocker.note+' 此提示来自最终回复，尚未经独立核验。'+(failure?' '+failure:''):
        failure||(row.status==='running'?'补充要求请回到原 Codex 任务；在途工作不会因切换界面而停止。':
          row.status==='needs_reconciliation'?'原执行状态未知，先核对已有命令和文件；不会自动重发。':
          row.status==='aborted'?'网页回合已停止；原生执行状态请查看原 Codex 记录。':
          row.status==='completed'?'本轮已结束，整体目标是否完成以成果和未完成项为准。'+handoffNote:handoffNote)};
  }
  const taskKey=row=>row.source?.threadId||'unmapped:'+row.traceId;
  function webpage(row){
    const account=row.account||row.source?.account||(row.source?.threadId?'B':null);
    return {account,available:['A','B'].includes(account)&&(/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(row.url||'')||row.status==='running')};
  }
  const nativePhases=new Set(['queued','delivered','result','error','retired']);
  const nativeTools=new Set(['exec_command','shell_command','write_stdin','apply_patch','view_image','exec_gateway','other']);
  function nativeCalls(activity,traceId){
    if(activity?.source!=='native_broker_metadata'||!Array.isArray(activity.events)||!(/^[a-f0-9]{12}$/).test(traceId||''))return [];
    const byCall=new Map();
    for(const event of activity.events){
      if(event.traceId!==traceId||!Number.isSafeInteger(event.eventId)||event.eventId<1||
        !Number.isSafeInteger(event.atMs)||event.atMs<1||
        !(/^call_[A-Za-z0-9_-]{16,128}$/).test(event.callId||'')||
        !nativePhases.has(event.phase)||!nativeTools.has(event.tool))continue;
      const previous=byCall.get(event.callId);
      if(!previous||event.eventId>previous.eventId)byCall.set(event.callId,event);
    }
    return [...byCall.values()].sort((a,b)=>b.eventId-a.eventId).slice(0,160);
  }
  function nativeStatus(phase){
    return ({queued:'请求已到达桥接 · 尚未交付',delivered:'已交给原生执行 · 回包待核对',
      result:'原生工具已回包 · 成果待核验',error:'工具回包报告错误 · 原执行待核对',
      retired:'调用已清退 · 实际结果待核对'})[phase]||'状态待核对';
  }
  function renderNativeActivity(card,row,activity){
    // A real broker trace is insufficient to claim a Codex task until its saved source also
    // resolves to that exact trace. Never attach shared MCP metadata by time or directory.
    if(row.source?.traceId!==row.traceId||!row.source?.threadId)return;
    const calls=nativeCalls(activity,row.traceId);
    const details=document.createElement('details');details.className='native-tool-activity';
    const summary=document.createElement('summary');summary.textContent='工具活动 · '+calls.length+' 次近期调用';details.append(summary);
    const note=document.createElement('p');note.className='scope-hint';
    note.textContent='按原回合标识关联。这里只显示工具名和桥接阶段；工具回包、文件成果及业务验收须分别核对。';details.append(note);
    const list=document.createElement('div');
    record.tools(list,calls.map(event=>({tool:event.tool==='exec_gateway'?'原生执行入口 · 内部步骤未展示':event.tool,
      status:nativeStatus(event.phase),phase:event.phase,detail:'Codex 原生工具 · '+new Date(event.atMs).toLocaleTimeString()})));
    details.append(list);
    if(activity?.windowTruncated||activity?.readFailed||activity?.unavailable){
      const gap=document.createElement('p');gap.className='scope-hint';
      gap.textContent=activity.readFailed||activity.unavailable?'活动记录暂不可用；缺失的阶段与结果仍待核对。':'仅保留近期窗口；更早的工具活动可能未显示。';details.append(gap);
    }
    card.append(details);
  }
  function groupRows(rows){const groups=new Map();for(const row of [...rows].sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||''))||String(b.traceId).localeCompare(String(a.traceId)))){const key=taskKey(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}return [...groups].map(([key,turns])=>({key,turns,latest:turns[0]}));}
  function filterRows(rows,key,query=''){query=query.trim().toLowerCase();return rows.filter(r=>(!key||taskKey(r)===key)&&(!query||[turnView(r).title,r.source?.workingDirectory,r.source?.threadId,r.traceId].filter(Boolean).join(' ').toLowerCase().includes(query)));}
  const canArchive=group=>group.turns.every(row=>['completed','aborted','failed'].includes(row.status));
  function taskList(rows,{query='',archived=[],archiveView=false}={}){
    const keys=new Set(archived);
    return groupRows(rows).filter(group=>{
      const isArchived=keys.has(group.key)&&canArchive(group);
      return isArchived===archiveView&&filterRows(group.turns,null,query).length>0;
    });
  }
  function renderOverview(container,groups,{onSelect=()=>{},onArchive=()=>{},archiveView=false}={}){
    invalidateTask(container);
    container.replaceChildren();
    if(!groups.length){const p=document.createElement('p');p.className='scope-hint';p.textContent=archiveView?'没有匹配的归档任务。':'没有匹配的任务。可新建任务，或调整搜索条件。';container.append(p);return;}
    for(const group of groups){
      const row=group.latest,v=turnView(row),card=document.createElement('article');card.className='codex-turn task-overview';card.dataset.state=v.needsAttention?'needs_reconciliation':row.status;
      const title=document.createElement('h3');title.textContent=v.title;
      const meta=document.createElement('p');meta.className='scope-hint';meta.textContent='账号 '+(webpage(row).account||'待核对')+' · '+v.model+' · '+group.turns.length+' 个回合';
      const status=document.createElement('p');status.className='codex-turn-state';status.textContent=v.status+' · '+v.sent;
      const identity=document.createElement('p');identity.className='scope-hint';identity.textContent=v.known?'任务 '+row.source.threadId.slice(-8):'旧回合 · 来源待核对';
      const open=document.createElement('button');open.type='button';open.className='secondary wide';open.textContent='查看任务 →';open.onclick=()=>onSelect(group.key);
      const archive=document.createElement('button');archive.type='button';archive.className='quiet';archive.textContent=archiveView?'移回任务总览':'归档';archive.disabled=!canArchive(group);archive.title=archive.disabled?'运行中或原执行待核对，暂不能归档。':'仅整理列表，不删除对话、不恢复或停止执行。';archive.onclick=()=>onArchive(group.key,!archiveView);
      card.append(title,meta,status,identity,open,archive);container.append(card);
    }
  }
  const taskViews=new WeakMap(),readingViews=new WeakMap();
  const foldStates=new WeakMap();
  const foldKey=(kind,trace)=>'native:'+kind+(trace?':'+trace:'');
  const savedFold=(options,key)=>Object.prototype.hasOwnProperty.call(options.folds||{},key)&&typeof options.folds[key]==='boolean'?options.folds[key]:null;
  const bodySourceIdentity=source=>JSON.stringify([source?.traceId,source?.threadId,source?.turnId,source?.model,source?.account]);
  const inlinePreviews=new WeakMap(),nativePreviewLimit=1900;
  function compactTaskRow(row){
    const text=row.review?.finalText;if(typeof text!=='string'||text.length<=nativePreviewLimit)return row;
    const {finalText,...review}=row.review,compact={...row,review};
    inlinePreviews.set(compact,{text:record.preview(text),length:text.length});return compact;
  }
  const setText=(element,text)=>{if(element.textContent!==String(text))element.textContent=text;};
  function setOpen(element,open){const state=foldStates.get(element);if(state)state.open=!!open;if(open)element.setAttribute('open','');else element.removeAttribute('open');}
  function isOpen(element){return element.hasAttribute('open');}
  function bindFold(element,key,owner,options,onToggle=()=>{},onChange=()=>{}){
    element.dataset.recordKey=key;const state={open:isOpen(element),key};foldStates.set(element,state);
    element.addEventListener('toggle',()=>{
      if(!owner.valid)return;const open=isOpen(element),changed=state.open!==open;state.open=open;
      // Restoring defaults/saved folds can queue browser toggle events. Only an external
      // change is a new reader choice; automatic latest-turn expansion is not persisted.
      if(changed){onChange(open);options().onFold?.(key,open);}
      onToggle(open);
    });
  }
  function applySavedFold(element,options,key){
    const open=savedFold(options,key);if(open===null)return false;
    const changed=isOpen(element)!==open;setOpen(element,open);return changed;
  }
  function persistFold(element,options,open){setOpen(element,open);const key=foldStates.get(element)?.key;if(key)options.onFold?.(key,open);}
  function reconcileChildren(container,nodes){
    const keep=new Set(nodes);
    for(const child of Array.from(container.childNodes))if(!keep.has(child))container.removeChild(child);
    let current=container.firstChild;
    for(const node of nodes){if(node===current)current=current.nextSibling;else container.insertBefore(node,current);}
  }
  function releaseEntryBody(entry){
    entry.token++;entry.loading=false;entry.loaded=false;entry.loadedRevision=undefined;
    disposeEntryMessage(entry);entry.message=null;entry.bodyText=null;entry.bodyLength=null;entry.loadFailed=false;entry.bodyContent.replaceChildren();
  }
  function disposeEntryMessage(entry){for(const body of Array.from(entry.bodyContent.querySelectorAll('.record-body')))body.dispose?.();}
  function releaseEntryActivity(entry){
    if(entry.activity)reconcileChildren(entry.activity,[entry.activitySummary]);
    entry.activityList=null;entry.activityGap=null;entry.activitySignature=null;
  }
  function activityForEntry(entry){
    if(entry.options.inlineActivity===false){entry.activity?.remove();entry.activity=null;return;}
    const {row,options}=entry;
    if(row.source?.traceId!==row.traceId||!row.source?.threadId){if(entry.activity?.parentNode)entry.activity.parentNode.removeChild(entry.activity);entry.activity=null;entry.activityList=null;entry.activitySignature=null;return;}
    if(!entry.activity){
      const details=document.createElement('details'),summary=document.createElement('summary');details.className='native-tool-activity';details.append(summary);
      entry.activity=details;entry.activitySummary=summary;
      applySavedFold(details,options,foldKey('activity',row.traceId));
      bindFold(details,foldKey('activity',row.traceId),entry,()=>entry.options,open=>{if(open)activityForEntry(entry);else releaseEntryActivity(entry);});
      entry.card.insertBefore(details,entry.body);
    }
    applySavedFold(entry.activity,options,foldKey('activity',row.traceId));
    const calls=nativeCalls(options.nativeActivity,row.traceId),activity=options.nativeActivity;
    setText(entry.activitySummary,'工具活动 · '+calls.length+' 次近期调用');
    if(!isOpen(entry.activity)||entry.inHistory&&!isOpen(entry.history)){releaseEntryActivity(entry);return;}
    if(!entry.activityList){
      const note=document.createElement('p');note.className='scope-hint';note.textContent='按原回合标识关联。这里只显示工具名和桥接阶段；工具回包、文件成果及业务验收须分别核对。';
      entry.activityList=document.createElement('div');entry.activityGap=document.createElement('p');entry.activityGap.className='scope-hint';
      entry.activity.append(note,entry.activityList,entry.activityGap);
    }
    const signature=JSON.stringify(calls);
    if(entry.activitySignature!==signature){
      record.tools(entry.activityList,calls.map(event=>({tool:event.tool==='exec_gateway'?'原生执行入口 · 内部步骤未展示':event.tool,
        status:nativeStatus(event.phase),phase:event.phase,detail:'Codex 原生工具 · '+new Date(event.atMs).toLocaleTimeString()})));
      entry.activitySignature=signature;
    }
    setText(entry.activityGap,activity?.readFailed||activity?.unavailable?'活动记录暂不可用；缺失的阶段与结果仍待核对。':
      activity?.windowTruncated?'仅保留近期窗口；更早的工具活动可能未显示。':'');
  }
  function validBodyResponse(loaded,traceId,identity,revision,requiresTurn){
    const savedRevision=loaded?.bodyRevision!==undefined?loaded.bodyRevision:loaded?.review?.finalSha256;
    return !!loaded&&loaded.traceId===traceId&&bodySourceIdentity(loaded.source)===identity&&
      (!requiresTurn||!!loaded.source?.threadId&&!!loaded.source?.turnId)&&
      (savedRevision===undefined||savedRevision===revision);
  }
  function nativeBodyOptions(entry,length,remote){
    // Capture saved identity only. The initial loaded reply is never retained by
    // this loader; Records owns the separately bounded full-body cache.
    const traceId=entry.row.traceId,identity=bodySourceIdentity(entry.row.source),revision=entry.row.bodyRevision||entry.row.review?.finalSha256||null,
      token=entry.token,requiresTurn=!!entry.row.source,ownerCurrent=entry.options.isCurrent;
    const current=()=>entry.valid&&entry.view?.valid&&entry.view.container.contains(entry.card)&&entry.token===token&&isOpen(entry.body)&&(!entry.inHistory||isOpen(entry.history))&&
      (typeof ownerCurrent!=='function'||ownerCurrent())&&
      bodySourceIdentity(entry.row.source)===identity&&(entry.row.bodyRevision||entry.row.review?.finalSha256||null)===revision;
    return {length,isCurrent:current,load:remote?async()=>{
      if(!current()||typeof entry.options.loadBody!=='function')throw Error('正文读取已取消或暂不可用。');
      const value=await entry.options.loadBody(traceId),loaded=value?.row||value;
      if(!current()||!validBodyResponse(loaded,traceId,identity,revision,requiresTurn)||typeof loaded.review?.finalText!=='string')throw Error('正文与原回合不匹配或已更新，请重新展开。');
      return loaded.review.finalText;
    }:null};
  }
  function showEntryText(entry,text,length=text.length){
    const remote=length>nativePreviewLimit,display=remote?record.preview(text):text;
    if(entry.bodyText===display&&entry.bodyLength===length&&entry.message?.parentNode===entry.bodyContent)return;
    const presenter=scope.CLWWorkRecord||record;
    disposeEntryMessage(entry);
    entry.message=presenter.message('网页 · 回复',display,nativeBodyOptions(entry,length,remote));
    entry.bodyContent.replaceChildren(entry.message);entry.bodyText=display;entry.bodyLength=length;
    // Once a reply has been displayed, it belongs to the continuous transcript.
    // A new latest turn must not put that reply behind an unrelated history fold.
    entry.exposed=true;
    if(entry.view?.valid&&!entry.view.rendering)reconcileTaskView(entry.view);
  }
  function entryBody(entry){
    if(!entry.valid||!isOpen(entry.body)||entry.inHistory&&!isOpen(entry.history))return;
    const {row,options}=entry,revision=row.bodyRevision||row.review?.finalSha256||null;
    if(typeof options.isCurrent==='function'&&!options.isCurrent())return;
    const inline=inlinePreviews.get(row);
    if(inline){showEntryText(entry,inline.text,inline.length);entry.loadedRevision=revision;return;}
    if(typeof row.review?.finalText==='string'){showEntryText(entry,row.review.finalText);entry.loadedRevision=revision;return;}
    if(entry.loadedRevision===revision&&entry.loaded)return;
    if(entry.loading)return;
    if(row.bodyAvailable===false||typeof options.loadBody!=='function'){
      if(!entry.message)setText(entry.bodyContent,row.status==='running'?'网页正在工作，最终回复会保存在这里。':'本轮最终回复尚未收录，请查看原网页或原 Codex 记录。');
      return;
    }
    const token=++entry.token,identity=bodySourceIdentity(row.source);entry.loading=true;setText(entry.bodyContent,'正在读取本轮保存的回复…');
    let pending;
    try{pending=options.loadBody(row.traceId);}catch(error){pending=Promise.reject(error);}
    Promise.resolve(pending).then(value=>{
      if(!entry.valid||entry.token!==token||typeof options.isCurrent==='function'&&!options.isCurrent()||!isOpen(entry.body)||entry.inHistory&&!isOpen(entry.history)||bodySourceIdentity(entry.row.source)!==identity||
        (entry.row.bodyRevision||entry.row.review?.finalSha256||null)!==revision)return;
      const loaded=value?.row||value;
      if(!validBodyResponse(loaded,row.traceId,identity,revision,!!row.source))
        throw Error('native_record_body_identity_mismatch');
      entry.loaded=true;entry.loadedRevision=revision;
      if(typeof loaded.review?.finalText==='string')showEntryText(entry,loaded.review.finalText);
      else setText(entry.bodyContent,'本轮最终回复尚未收录，请查看原网页或原 Codex 记录。');
    }).catch(()=>{if(entry.valid&&entry.token===token&&(typeof options.isCurrent!=='function'||options.isCurrent())){entry.loaded=true;entry.loadedRevision=revision;setText(entry.bodyContent,'本轮保存的回复暂不可用，请稍后展开重试。');entry.loadFailed=true;}})
      .finally(()=>{if(entry.valid&&entry.token===token)entry.loading=false;});
  }
  function createTaskEntry(row,options,latest){
    const savedBody=savedFold(options,foldKey('body',row.traceId));
    const entry={row,options,task:taskKey(row),valid:true,token:0,loaded:false,loading:false,loadedRevision:undefined,explicit:savedBody!==null,autoOpened:savedBody===null&&latest,exposed:latest};
    const create=(tag,cls)=>{const element=document.createElement(tag);if(cls)element.className=cls;return element;};
    entry.card=create('article','codex-turn work-record-turn');entry.card.dataset.trace=row.traceId;entry.card.setAttribute('tabindex','-1');
    entry.title=create('strong');entry.state=create('p','codex-turn-state');entry.meta=create('p','scope-hint');
    entry.info=create('details');entry.infoSummary=create('summary');entry.infoSummary.textContent='来源与回合';entry.identity=create('p','scope-hint');entry.info.append(entry.infoSummary,entry.identity);
    applySavedFold(entry.info,options,foldKey('source',row.traceId));bindFold(entry.info,foldKey('source',row.traceId),entry,()=>entry.options);
    entry.body=create('details','native-turn-body');entry.bodySummary=create('summary');entry.bodySummary.textContent='本轮回复';entry.bodyContent=create('div','native-turn-body-content');entry.body.append(entry.bodySummary,entry.bodyContent);setOpen(entry.body,savedBody===null?latest:savedBody);
    entry.bodySummary.addEventListener('click',()=>{entry.explicit=true;});
    bindFold(entry.body,foldKey('body',row.traceId),entry,()=>entry.options,open=>{if(!open){releaseEntryBody(entry);return;}if(entry.loadFailed){entry.loaded=false;entry.loadFailed=false;}entryBody(entry);},()=>{entry.explicit=true;});
    entry.notice=create('p','scope-hint');entry.note=create('p','scope-hint');entry.open=create('button','secondary wide');entry.open.type='button';entry.open.onclick=()=>entry.options.onView?.(entry.row.traceId);
    entry.resume=create('button','secondary wide');entry.resume.type='button';entry.resume.onclick=()=>entry.options.onResume?.(entry.row.traceId);
    entry.card.append(entry.title,entry.state,entry.meta,entry.info,entry.body);
    return entry;
  }
  function updateTaskEntry(entry,row,options){
    const previousRevision=entry.row.bodyRevision||entry.row.review?.finalSha256||null;
    const nextRevision=row.bodyRevision||row.review?.finalSha256||null;
    const sourceChanged=bodySourceIdentity(entry.row.source)!==bodySourceIdentity(row.source);
    entry.row=row;entry.options=options;
    entry.task=taskKey(row);
    if(previousRevision!==nextRevision||sourceChanged)releaseEntryBody(entry);
    applySavedFold(entry.info,options,foldKey('source',row.traceId));
    if(savedFold(options,foldKey('body',row.traceId))!==null)entry.explicit=true;
    if(applySavedFold(entry.body,options,foldKey('body',row.traceId))&&!isOpen(entry.body))releaseEntryBody(entry);
    const v=turnView(row),page=webpage(row);
    entry.card.dataset.state=v.needsAttention?'needs_reconciliation':row.status;
    setText(entry.title,v.title);setText(entry.state,v.status+' · '+v.sent);
    setText(entry.meta,v.model+' · '+(row.startedAt?new Date(row.startedAt).toLocaleString():'时间未记录'));
    const notice=displayIndexNotice(row.display_read);
    setText(entry.identity,v.detail+' · '+row.traceId);setText(entry.note,v.note);setText(entry.notice,notice);
    setText(entry.open,'◉ 查看对话网页'+(page.account?' · 账号 '+page.account:''));entry.open.disabled=!page.available;
    entry.open.title=page.available?'显示原对话；查看不会发送消息或恢复任务。':'原对话链接或账号归属尚未记录，不会猜测或重建任务。';
    if(v.canResume){setText(entry.resume,'▶ 在 Codex 接续 · '+v.model);entry.resume.disabled=!options.ready||!!options.resuming;entry.resume.title='打开同一个 Codex 任务，保留原模型；不会自动发送消息。';}
    const primaryResume=entry.latest&&v.canResume;
    entry.resume.className=primaryResume?'primary':'secondary wide';
    // Older per-turn actions retain their exact trace but do not compete with the
    // current task action. Opening source details is only a reading choice.
    activityForEntry(entry);
    reconcileChildren(entry.info,[entry.infoSummary,entry.identity,...(!v.noteNeedsAttention?[entry.note]:[]),entry.open,
      ...(v.canResume&&!primaryResume?[entry.resume]:[])]);
    reconcileChildren(entry.card,[entry.title,entry.state,entry.meta,entry.info,...(entry.activity?[entry.activity]:[]),entry.body,
      ...(notice?[entry.notice]:[]),...(v.noteNeedsAttention?[entry.note]:[]),...(primaryResume?[entry.resume]:[])]);
    entryBody(entry);
  }
  function reconcileTaskView(view){
    const ordered=view.ordered||[],historical=[],transcript=[];
    for(const [index,row] of ordered.entries()){
      const entry=view.entries.get(row.traceId);if(!entry)continue;
      entry.inHistory=index>0&&!entry.exposed;entry.history=view.history;
      (entry.inHistory?historical:transcript).push(entry.card);
    }
    if(!ordered.length){
      if(!view.empty){view.empty=document.createElement('p');view.empty.className='scope-hint';view.empty.textContent='开始工作后，这里显示各个网页回合与来源 Codex 任务。';}
      reconcileChildren(view.container,[view.empty]);return;
    }
    setText(view.summary,'历史回合 · '+historical.length);
    reconcileChildren(view.cards,historical.reverse());
    reconcileChildren(view.container,[...(historical.length?[view.history]:[]),...transcript.reverse()]);
  }
  function invalidateTask(container){
    const view=taskViews.get(container);if(!view)return false;
    let reading=readingViews.get(container);if(!reading){reading=new Map();readingViews.set(container,reading);}
    reading.delete(view.key);reading.set(view.key,{history:isOpen(view.history),
      traces:(view.ordered||[]).filter(row=>view.entries.get(row.traceId)?.exposed).slice(0,120).map(row=>row.traceId)});
    while(reading.size>8)reading.delete(reading.keys().next().value);
    view.valid=false;for(const entry of view.entries.values()){entry.valid=false;releaseEntryBody(entry);releaseEntryActivity(entry);}
    taskViews.delete(container);return true;
  }
  function renderTask(container,rows,options={}){
    const ordered=groupRows(rows).flatMap(g=>g.turns).map(compactTaskRow),key=options.taskKey||ordered[0]&&taskKey(ordered[0])||'';
    let reading=readingViews.get(container);if(!reading){reading=new Map();readingViews.set(container,reading);}
    let view=taskViews.get(container);
    if(!view||view.key!==key){
      if(view)invalidateTask(container);
      const restored=reading.get(key);
      container.replaceChildren();view={key,entries:new Map(),valid:true,options,container};taskViews.set(container,view);
      view.restoredReading=new Set(restored?.traces||[]);
      view.history=document.createElement('details');view.history.className='task-turn-history';view.summary=document.createElement('summary');view.cards=document.createElement('div');view.history.append(view.summary,view.cards);
      const ownedView=view;
      applySavedFold(view.history,options,foldKey('history'));
      if(savedFold(options,foldKey('history'))===null&&restored)setOpen(view.history,restored.history);
      bindFold(view.history,foldKey('history'),ownedView,()=>ownedView.options,open=>{for(const entry of ownedView.entries.values())if(entry.inHistory){
        if(open){entryBody(entry);activityForEntry(entry);}
        else{releaseEntryBody(entry);releaseEntryActivity(entry);}
      }});
    }
    view.options=options;
    if(applySavedFold(view.history,options,foldKey('history'))&&!isOpen(view.history))for(const entry of view.entries.values())if(entry.inHistory){releaseEntryBody(entry);releaseEntryActivity(entry);}
    view.ordered=ordered;view.rendering=true;
    const traces=new Set(ordered.map(row=>row.traceId));
    for(const [trace,entry] of view.entries)if(!traces.has(trace)){entry.valid=false;releaseEntryBody(entry);releaseEntryActivity(entry);view.entries.delete(trace);}
    try{for(const [index,row] of ordered.entries()){
      let entry=view.entries.get(row.traceId);
      const latest=options.latestTrace?row.traceId===options.latestTrace:index===0;
      if(!entry){entry=createTaskEntry(row,options,latest);view.entries.set(row.traceId,entry);
        if(view.restoredReading.has(row.traceId)){entry.exposed=true;
          if(savedFold(options,foldKey('body',row.traceId))===null){setOpen(entry.body,true);entry.autoOpened=true;}}}
      else if(savedFold(options,foldKey('body',row.traceId))!==null)entry.explicit=true;
      else if(!entry.explicit){
        if(latest&&!entry.autoOpened)setOpen(entry.body,true);
        if(latest)entry.autoOpened=true;
      }
      if(latest)entry.exposed=true;
      entry.latest=latest;entry.view=view;entry.inHistory=index>0&&!entry.exposed;entry.history=view.history;
      updateTaskEntry(entry,row,options);
    }}finally{view.rendering=false;}
    reconcileTaskView(view);
  }
  function focusTrace(container,traceId){
    const view=taskViews.get(container),entry=view?.entries.get(traceId);if(!entry)return false;
    entry.explicit=true;
    if(entry.card.parentNode===view.cards)persistFold(view.history,view.options,true);
    persistFold(entry.body,entry.options,true);entryBody(entry);entry.card.focus?.();entry.card.scrollIntoView?.({block:'nearest'});return true;
  }
  function renderNavigation(container,rows,{selected,query='',archived=[],archiveView=false,onSelect}={}){
    container.replaceChildren();
    for(const group of taskList(rows,{query,archived,archiveView})){
      const row=group.latest,v=turnView(row),b=document.createElement('button');b.type='button';b.className='codex-task-nav'+(selected===group.key?' selected':'');b.setAttribute('aria-current',selected===group.key?'page':'false');
      const title=document.createElement('strong');title.textContent=v.title;b.append(title);
      const state=document.createElement('span');state.textContent=v.status+' · '+v.model;b.append(state);
      const id=document.createElement('small');id.textContent=v.known?'任务 '+row.source.threadId.slice(-8)+' · '+group.turns.length+' 个已记录回合':'旧回合 · 来源未记录';b.append(id);
      b.onclick=()=>onSelect(group.key);container.append(b);
    }
    if(!container.childElementCount){const p=document.createElement('p');p.className='scope-hint';p.textContent='还没有匹配的 Codex 任务';container.append(p);}
  }
  function renderSummary(container,rows){
    const groups=groupRows(rows),active=groups.filter(g=>g.turns.some(r=>r.status==='running')).length,attention=groups.filter(g=>turnView(g.latest).needsAttention).length;
    container.replaceChildren();
    for(const [count,label,tone] of [[active,'正在工作','active'],[attention,'需要核对','attention'],[groups.length,'已记录任务','quiet']]){
      const box=document.createElement('div');box.className='summary-cell '+tone;const n=document.createElement('strong');n.textContent=count;const t=document.createElement('span');t.textContent=label;box.append(n,t);container.append(box);
    }
  }
  function render(container,rows,{ready=false,resuming=false,nativeActivity=null,onResume=()=>{},onView=()=>{}}={}){
    invalidateTask(container);
    container.replaceChildren();
    if(!rows.length){const p=document.createElement('p');p.className='scope-hint';p.textContent='开始工作后，这里显示各个网页回合与来源 Codex 任务。';container.append(p);return;}
    for(const row of rows){
      const v=turnView(row),card=document.createElement('article');card.className='codex-turn work-record-turn';card.dataset.state=v.needsAttention?'needs_reconciliation':row.status;card.dataset.trace=row.traceId;
      const line=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;card.append(e);return e;};
      line('strong',v.title);line('p',v.status+' · '+v.sent,'codex-turn-state');
      line('p',v.model+' · '+(row.startedAt?new Date(row.startedAt).toLocaleString():'时间未记录'),'scope-hint');
      const info=document.createElement('details'),summary=document.createElement('summary');summary.textContent='来源与回合';info.append(summary);
      const detail=document.createElement('p');detail.className='scope-hint';detail.textContent=v.detail+' · '+row.traceId;info.append(detail);card.append(info);
      renderNativeActivity(card,row,nativeActivity);
      if(typeof row.review?.finalText==='string')card.append(record.message('网页 · 回复',row.review.finalText));
      else line('p',row.status==='running'?'网页正在工作，最终回复会保存在这里。':'本轮最终回复尚未收录，请查看原网页或原 Codex 记录。','scope-hint');
      line('p',v.note,'scope-hint');
      const page=webpage(row),open=line('button','◉ 查看对话网页'+(page.account?' · 账号 '+page.account:''),'secondary wide');
      open.type='button';open.disabled=!page.available;open.onclick=()=>onView(row.traceId);
      open.title=page.available?'显示原对话；查看不会发送消息或恢复任务。':'原对话链接或账号归属尚未记录，不会猜测或重建任务。';
      if(v.canResume){const b=line('button','▶ 在 Codex 接续 · '+v.model,'secondary wide');b.type='button';b.disabled=!ready||resuming;b.onclick=()=>onResume(row.traceId);b.title='打开同一个 Codex 任务，保留原模型；不会自动发送消息。';}
      container.append(card);
    }
  }
  const api={turnView,render,taskKey,webpage,groupRows,filterRows,renderNavigation,renderSummary,nativeCalls,nativeStatus,canArchive,taskList,renderOverview,renderTask,invalidateTask,focusTrace,displayIndexNotice};if(typeof module!=='undefined')module.exports=api;else scope.CLWCodexTurns=api;
})(globalThis);
