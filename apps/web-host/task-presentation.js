'use strict';
(function(scope){
  // A selection can arrive before its ledger. Never borrow another task's
  // request, stop state, or accepted-send identity during that transition.
  function selectedView(page,view){return page&&view?.page_id===page.id&&
    !(page.thread_id&&view.thread_id&&page.thread_id!==view.thread_id)?view:{};}
  function goalPresentation(page,view={}){
    view=selectedView(page,view);
    const detail=view.goal,summary=page?.goal;
    const goal=detail||summary;
    const eligible=!!page?.bound&&!page.parent&&!page.successor&&page.kind!=='account'&&view.page_id===page.id&&!view.state_read?.unavailable;
    const identity=!!goal&&(goal.configured===false||(goal.owner_identity_valid??goal.identity_valid)!==false)&&(!goal.page_id||goal.page_id===page?.id)&&(!goal.thread_id||!view.thread_id||goal.thread_id===view.thread_id);
    const requestMatches=goal?.configured===false||goal?.identity_valid!==false&&goal?.request_matches!==false;
    const states={running:'目标推进中',delivered:'已交付',waiting:'等待结果',active:'目标推进中',paused:'目标已暂停',stopped:'目标已关闭',needs_attention:'目标需要处理',
      ready_for_review:'本轮结果待你验收',complete:'目标已确认完成',draft:'目标已保存 · 尚未开始'};
    const modern=goal?.mode==='automatic'||goal?.result_contract>=2;
    const effectiveState=modern?(goal.display_state||(goal.state==='complete'?'delivered':goal.state)):goal?.state;
    const unavailable=!identity||!!goal?.unavailable||(goal.configured!==false&&!Object.hasOwn(states,effectiveState));
    const state=unavailable?'unavailable':goal.configured===false?'unset':effectiveState;
    const pending=!!goal?.pending_id||!!goal?.pending;
    const reviewed=!!goal?.review&&goal.review.request_id===goal.request_id;
    let title=state==='unset'?'尚未设置目标':states[state]||'目标状态待核对';
    if(modern&&goal?.mode==='automatic'&&!unavailable&&page?.paused&&['running','active'].includes(state))
      title=view.request?.phase==='processing'?'本轮待收尾 · 后续发送已暂停':view.request?.phase==='suspended'?'等待结果 · 后续发送已暂停':'目标已暂停';
    if(!modern&&state==='complete'&&goal.mode==='manual'&&!(reviewed&&goal.review.decision==='complete'))title='目标已标记完成 · 待你确认';
    if(!modern&&!unavailable&&goal.can_review&&!reviewed)title='本轮结果待你验收';
    else if(!modern&&!unavailable&&reviewed&&goal.review.decision==='continue')title='验收已保存 · 等待你开始下一包';
    else if(!modern&&!unavailable&&reviewed&&goal.review.decision==='revise')title='验收已保存 · 需要修正';
    return {goal:identity?goal:null,state,title,reviewed,
      editable:eligible&&!unavailable&&!pending&&(requestMatches||state==='stopped'),
      canReview:!modern&&eligible&&!unavailable&&requestMatches&&!pending&&goal.can_review===true&&!view.request&&!page.observation?.generating,
      canStartNext:!modern&&eligible&&!unavailable&&requestMatches&&!pending&&goal.can_start_next===true&&!view.request&&!page.observation?.generating,
      cycles:Number.isInteger(goal?.cycles)&&goal.cycles>=0?goal.cycles:null,
      mode:goal?.mode||null,pending};
  }
  function composer(page,view={},options={}){
    view=selectedView(page,view);
    const active=!!view.request,held=!!(view.maintenance||page?.maintenance);
    const requestId=active&&typeof view.request.id==='string'&&view.request.id.trim()&&
      ['queued','processing','suspended'].includes(view.request.phase)?view.request.id:null;
    const requestConflict=active&&(!requestId||[view.latest_request,page?.latest_request].some(latest=>latest?.id&&latest.id!==requestId)||
      !!(view.thread_id&&page?.thread_id&&view.thread_id!==page.thread_id));
    const text=String(options.draft||'').trim(),length=[...text].length,limit=active?16000:24000;
    const inherited=!!(page?.pause_origin?.inherited||view.pause_origin?.inherited),partial=!!view.partial_public_send;
    // An append is an exact original-request Host note, independent of the
    // webpage's current model. New sends still require the chosen model.
    const blocked=!page?.bound||view.page_id!==page.id||!!view.state_read?.unavailable||!!page.successor||inherited||partial||
      requestConflict||options.connected===false||!!options.modelMismatch&&(!active||!!options.pending);
    let label=active?'保存补充':'发送消息',kind=active?'append':'send';
    let resume=false;
    if(options.pending){label='核对提交';kind='reconcile';}
    else if(page?.paused&&!held&&!active){label='保存草稿';kind='save-draft';}
    if(held){label='保存补充';kind='append';resume=false;}
    const goal=goalPresentation(page,view);
    if(!active&&!held&&!options.pending&&goal.goal?.configured===true&&goal.mode==='manual'&&!(goal.goal.result_contract>=2)&&!text){
      label=goal.canStartNext?'开始下一包':goal.canReview?'验收本轮':'目标与验收';kind='goal';resume=false;
      return {label,kind,resume,active,held,limit,length,disabled:blocked};
    }
    return {label,kind,resume,active,held,limit,length,requestId,
      disabled:blocked||length>limit||(held&&!active)||(!text&&!(resume&&active)&&!options.pending)};
  }
  function goalControls(page,view={},options={}){
    view=selectedView(page,view);
    const p=goalPresentation(page,view),g=p.goal;
    const visible=!!page?.bound&&!page.parent&&!page.successor&&page.kind!=='account'&&g?.configured===true&&p.state!=='stopped';
    const ready=visible&&view.page_id===page.id&&!view.state_read?.unavailable&&(g.owner_identity_valid??g.identity_valid)!==false&&
      typeof g.etag==='string'&&!!g.etag&&options.connected!==false;
    const automatic=g?.mode==='automatic',terminal=['delivered','complete'].includes(p.state);
    const held=!!(view.maintenance||page?.maintenance||page?.pause_origin?.inherited||view.pause_origin?.inherited);
    return {visible,stopEnabled:ready,toggleVisible:visible&&automatic&&!terminal,
      toggleEnabled:ready&&g.identity_valid!==false&&g.request_matches!==false&&!held&&(!page.paused||resumeRelevant(page,view)),
      toggleAction:page?.paused?'resume':'pause',toggleLabel:page?.paused?'继续目标':'暂停目标',
      title:page?.paused&&automatic&&!terminal?'目标已暂停':p.title};
  }
  // Routine progress has no second action button. A visible action only
  // resolves an exceptional state that the composer cannot address.
  function unsentResumeRequest(page,view,flow={},model={}){
    view=selectedView(page,view);
    const request=view.request,latest=view.latest_request,attempt=view.attempt,o=page?.observation||{};
    // This exposes an explicit recovery action, never retry authority. The
    // original request CAS and accepted-history check remain in the backend.
    if(!page?.bound||!page.paused||page.kind==='account'||view.page_id!==page.id||
      view.state_read?.unavailable||page.successor||page.pause_origin?.inherited||view.pause_origin?.inherited||
      view.maintenance||page.maintenance||view.partial_public_send||model?.mismatch||
      o.generating||o.approvalRequired||o.loginRequired||page.accountAccess?.blocked)return null;
    if(!['paused','control_failed','not_sent'].includes(flow.key)||
      page.issue_kind&&page.issue_kind!=='control_failed')return null;
    if(!request?.id||request.phase!=='queued'||![0,false].includes(request.cancel_requested)||
      latest?.id!==request.id||latest.phase!=='queued'||latest.withdrawn||latest.resolution||latest.sent_user_hash!==null||
      page.latest_request?.id&&(page.latest_request.id!==request.id||page.latest_request.phase!=='queued')||
      !attempt?.id||latest.attempt_id!==attempt.id||attempt.state!=='not_sent'||attempt.acknowledged!==null)return null;
    return request.id;
  }
  // Pause is an automation setting, not evidence of unfinished work. Present
  // a resume only when it has something specific to release. This helper does
  // not authorize a send or retry; the original backend receipt checks remain.
  function resumeRelevant(page,view,options={}){
    view=selectedView(page,view);
    if(!page?.bound||!page.paused||page.kind==='account'||view.page_id!==page.id||
      view.state_read?.unavailable||page.successor||page.pause_origin?.inherited||view.pause_origin?.inherited||
      view.maintenance||page.maintenance||view.partial_public_send)return false;
    const request=view.request,latest=view.latest_request||page.latest_request,attempt=view.attempt;
    if(view.latest_request?.id&&page.latest_request?.id&&
      (view.latest_request.id!==page.latest_request.id||view.latest_request.phase!==page.latest_request.phase))return false;
    if(request){
      if(unsentResumeRequest(page,view,options.flow||{key:'paused'},options.model||{}))return true;
      // Unknown delivery and contradictory ledgers require original-receipt
      // reconciliation, even if the user has typed a new draft.
      return !!request.id&&['processing','suspended'].includes(request.phase)&&latest?.id===request.id&&
        latest.phase===request.phase&&!!attempt?.id&&latest.attempt_id===attempt.id&&
        attempt.acknowledged!=null&&attempt.state!=='unknown';
    }
    if(['queued','processing','suspended'].includes(latest?.phase)||attempt?.state==='unknown'||
      ['delivery_unknown','sending'].includes(view.next_round?.state))return false;
    if(String(options.draft||'').trim()||options.hasDraft===true)return true;
    if(Number(view.pending_notes)>0||Number(view.next_round?.count)>0)return true;
    const goal=goalPresentation(page,view);
    return goal.goal?.configured===true&&goal.mode==='automatic'&&!goal.pending&&
      ['running','active','paused','needs_attention'].includes(goal.state);
  }
  function needsWorkflowAction(page,view,flow,model,hasDraft=false){
    view=selectedView(page,view);
    if(!page||page.kind==='account')return false;
    if(view.state_read?.unavailable)return false;
    if(!page.bound&&page.enrolling&&page.paused&&page.bootstrap_state==='pending')return true;
    if(page.bound&&view.page_id!==page.id)return false;
    if(flow.key==='partial_public_send'||flow.actionPage||flow.key==='successor')return true;
    if(model?.mismatch)return true;
    if(unsentResumeRequest(page,view,flow,model))return true;
    if(page.bound&&page.paused&&!view.request&&resumeRelevant(page,view,{flow,model,hasDraft}))return true;
    if(!view.request&&goalPresentation(page,view).goal?.configured===true)return false;
    return ['attention','worker_setup','approval_required','account_cooldown','not_sent','recovery_exhausted','blocked'].includes(flow.key);
  }
  const api={selectedView,goalPresentation,goalControls,composer,unsentResumeRequest,resumeRelevant,needsWorkflowAction};
  if(typeof module!=='undefined')module.exports=api;else scope.CLWTaskPresentation=api;
})(globalThis);
