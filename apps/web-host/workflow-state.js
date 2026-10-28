'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CLWWorkflow=api;})(globalThis,()=>{
  const clean=s=>String(s||'').trim().toLowerCase();
  // Match the driver's known localized picker alias without erasing versions.
  const modelKey=s=>clean(s).split(/\s*·\s*/).map(part=>part==='最新'?'latest':part).join(' · ');
  const failures=typeof module==='object'&&module.exports?require('./failure-state.js'):globalThis.CLWFailure;
  function settledBranch(page={},view={}){
    const latest=view.latest_request||page.latest_request;
    return !view.request&&latest?.phase==='blocked'&&latest.resolution?latest.resolution:null;
  }
  function enrollmentState(page={},draft){
    const active=!!page.enrolling;
    const selection=active?(page.bootstrap_model_selection||{}):(draft||{model:page.model,effort:page.effort});
    return {active,selection,label:active?'本轮接入模型':page.bound?'工作模型':'首次发送模型',
      nav:active?'接入 · '+(selection.effort||'待核对'):(page.effort||''),
      next:active?'接入后工作：'+[page.model,page.effort].filter(Boolean).join(' · '):''};
  }
  function modelState(page={}){
    const observed=page.observation?.model;
    const pill=page.observation?.effortLabel||'';
    const expected=[page.model,page.effort].filter(Boolean).join(' · ');
    const actual=observed?.model&&observed?.effort?[observed.model,observed.effort].join(' · '):pill;
    const mismatch=!!(observed?.model&&observed?.effort&&page.model&&(modelKey(observed.model)!==modelKey(page.model)||clean(observed.effort)!==clean(page.effort)))||!!(pill&&page.effort&&clean(pill)!==clean(page.effort));
    return {expected,actual,mismatch,verified:!!observed?.model};
  }
  const observationFresh=(o,now)=>!Number.isFinite(o.at)||(o.at<=now+5000&&now-o.at<=30000);
  // Only this named error belongs exclusively to the read-only snapshot.
  // Unknown send/control errors remain business faults: a presentation change
  // must never turn an unconfirmed action or an access refusal into success.
  function observationNotice(page){
    if(page?.observation?.error!=='page_snapshot_timeout')return null;
    return {key:'page_snapshot_timeout',code:'page_snapshot_timeout',tone:'warning',
      title:'网页状态读取超时',
      detail:'暂时没有读到原网页的最新状态；已保存的回复和送达记录仍可查看。'};
  }
  function workflowState(page,view={},connected=true,now=Date.now()){
    if(!page)return {key:'welcome',tone:'neutral',step:0,title:'新建或选择一个对话',detail:'可以直接开始纯 Web 对话；按需选择项目。每个任务保留独立对话和工作记录。'};
    const o=page.observation||{},r=Object.hasOwn(view,'request')?view.request:
      ['queued','processing','suspended'].includes(page.latest_request?.phase)?page.latest_request:null,
      a=view.attempt,m=modelState(page);
    const latest=view.latest_request||page.latest_request;
    const sameTurn=!!latest?.attempt_id&&o.attemptId===latest.attempt_id||
      !!latest?.sent_user_hash&&o.userTurnHash===latest.sent_user_hash;
    const generating=!!o.generating&&observationFresh(o,now)&&!(sameTurn&&['completed','blocked','cancelled','failed'].includes(latest?.phase));
    if(page.kind==='account')return {key:'account',tone:'neutral',step:0,title:'账号登录页',detail:'登录后新建任务；这里不会派发项目工作。'};
    if(!connected)return {key:'offline',tone:'warning',step:0,title:'本机连接中断，正在恢复',detail:'原消息已保留；发送回执确认前不会重发。'};
    if(page.accountAccess?.blocked)return {key:'account_cooldown',tone:'warning',step:o.generating?2:1,title:o.generating?'账号访问受限 · 已送达回合保留':'账号访问受限 · 新发送已等待',detail:page.accountAccess.message};
    if(o.loginRequired)return {...failures.describe('login_required'),tone:'warning',step:0};
    if(o.approvalRequired)return {key:'approval_required',tone:'warning',step:2,title:'等待网页确认',detail:'原网页正在等待操作或附件确认，并非仍在思考。请查看原网页；原执行与回执保留，不会另发一轮或重做。'};
    if(page.successor)return {key:'successor',tone:'neutral',step:4,title:'已交接到后继任务',detail:'原对话与成果保留，打开接续任务继续。'};
    const maintenance=view.maintenance||page.maintenance;
    if(maintenance&&!page.parent)return maintenance.state==='settled'?{key:'team_paused',tone:page.attention?'warning':'neutral',step:3,title:page.attention?'自动推进已暂停 · 原问题仍需处理':'自动推进已暂停 · 本轮记录已保存',detail:page.attention?'运行窗口已冻结，原任务、成果和待处理原因保留。解除维护暂停不会清除原问题或自动重试被拒操作；补充只保存到本地。':'原任务、成果、队列和已读位置保留，维护时间不计运行窗口。明确恢复自动推进后接续，暂停不消耗模型发送。'}:{key:generating&&!page.attention?'working_held':'team_pausing',tone:generating&&!page.attention?'active':'waiting',step:3,title:generating&&!page.attention?'思考／工作 · 后续自动推进已暂停':'自动推进已暂停 · 等待本轮收尾',detail:'已停止新派发；已送达回合继续执行并保存结果。目前还有 '+(maintenance.pending?.length||0)+' 项回执或执行需要收尾，不会强行打断。'};
    const errors={model_control_not_found:'网页模型菜单尚未就绪，请查看原网页。消息未因此重发。',model_menu_did_not_settle:'模型菜单暂时无法读取，请在原网页关闭弹窗后重新核对。',managed_page_not_ready:'任务尚未就绪或已经暂停，消息保留在本地。',runtime_disconnected_reconcile_original:'本机连接中断，正在核对原回执，不重复派发。'};
    const origin=view.pause_origin||page.pause_origin,reconciliation=view.reconciliation;
    const endedRecovery=view.ended_recovery||page.ended_recovery;
    if(page.attention&&origin?.source==='attention'&&!origin.inherited&&endedRecovery&&endedRecovery.attempt_id===latest?.attempt_id&&['backoff','probing','waiting_jobs'].includes(endedRecovery.state))return {
      key:'recovering',tone:'waiting',step:3,title:'等待恢复 · 核对原执行',detail:'已保存原成果，程序正在核对原 Job 和网页终态。核对后继续同一目标；没有重做已受理的命令。'};
    if(view.partial_public_send)return {key:'partial_public_send',tone:'warning',step:1,
      title:'网页只收到部分消息 · 原任务已停住',
      detail:'已保留原网页回合、任务和本地记录。核对当前网页及本地执行后，可将这条旧任务记为受阻，让主控安排新的工作；不会把它当成成功，也不会重发旧消息。'};
    if(page.paused&&generating&&!page.attention&&!o.stopped&&!o.failure&&(!o.error||o.error==='managed_page_not_ready'))return {
      key:'working_held',tone:'active',step:2,title:'思考／工作 · 后续自动推进已暂停',
      detail:'当前网页回合继续完成，程序仍会收集并保存结果。'+(origin?.inherited?'后续自动推进跟随主控暂停。':'后续自动推进已暂停。')+'保存补充不会恢复派发；只有明确恢复才继续。'};
    if(page.paused&&origin?.inherited&&!page.attention&&(!o.error||o.error==='managed_page_not_ready'))return {
      key:'parent_paused',tone:'waiting',step:3,title:'主控已暂停 · 协作者等待恢复',
      detail:'暂停来自「'+origin.title+'」。'+((view.latest_request||page.latest_request)?.phase==='completed'?'本协作者上一任务已完成，成果保留。':'当前任务与原回执保留。')+'请到主控核对并恢复；这里没有重复发送。',actionPage:origin.page_id};
    if(reconciliation?.missing_tool_outcome){
      const count=reconciliation.assignments_in_ended_turn.length,cp=reconciliation.latest_checkpoint;
      return {key:'reconcile',tone:'warning',step:3,title:'本轮已结束 · 收尾回执缺失',
        detail:(count?'本轮已有 '+count+' 项派发记录。':'原任务与执行记录保留。')+(cp?'最新检查点 v'+cp.version+'。':'')+'恢复时会把本地执行事实交给主控核对，避免重做。'+(view.run?.state==='draining'?'运行预算已结束，恢复仅用于收尾。':'')};
    }
    if(page.attention||o.error){
      if(page.parent&&page.issue_kind==='preparation_required'&&page.bootstrap_state==='pending'&&clean(page.bootstrap_model_selection?.effort)==='pro')return {key:'worker_setup',tone:'warning',step:0,title:'子对话接入设置需修复',detail:'旧版继承了主控的 Pro 准备档位，但本子对话尚未发送接入消息。加载修复后恢复原子对话：极高接入，正式工作仍用原选定模型，保留原页面与任务。'};
      if(!page.bound&&page.bootstrap_state==='pending'&&/接入和简单准备不能使用 Pro|旧任务缺少已确认的 Extra High/.test(page.attention||''))return {key:'preparation_required',tone:'warning',step:0,title:'首次发送被本地旧规则拦住',detail:(page.first_turn_instructions||page.has_first_turn_instructions)?'原要求和 Pro 选择保留，消息尚未发送。首轮有研究或方案要求时可使用 Pro；更新后点击恢复将核对原任务并发送一次。':'仅接入没有工作内容，需要核对首次模型；不是平台安全拒绝或账号额度判断。'};
      const fault=failures.describe(page.issue_kind||o.fault||o.error);
      if(fault)return {...fault,tone:'warning',step:page.bound?2:0,detail:fault.detail+(page.parent?' 仅此分支停下；主控与其他分支按各自状态继续。':'')};
      const reason=page.attention||errors[o.error]||o.error;
      const latest=page.intake?.latest_public_reply?.public_text||'';
      if(!page.bound&&/平台安全检查.{0,12}拦截|OpenAI 无法确定请求的安全状态/.test(latest))return {key:'attention',tone:'warning',step:0,title:'接入未完成 · 网页报告工具被拦截',detail:'最新网页回复报告平台安全检查未放行。原调用未重放；本地配置与工具回执见下方接入记录。该回复不能替代平台原始判定。'};
      const missingScope=!page.bound&&reason.includes('team_write_paths_required');
      if(missingScope&&page.intake?.configuration_error===null)return {key:'attention',tone:'warning',step:0,title:'配置已修正 · 接入仍待核对',detail:'有效访问范围已保存，原对话和暂停保留。保存没有重试工具调用，尚未取得接入成功回执。'};
      return {key:'attention',tone:'warning',step:!page.bound?0:r?.phase==='queued'?1:2,title:!page.bound?'接入未完成':page.paused?'已暂停 · 需要处理':'需要处理',detail:missingScope?'可写访问没有填写可写的相对目录，接入未完成。空白不表示整个项目。原消息与失败记录保留，没有自动重发。':reason.slice(0,280)};
    }
    if(!r&&view.latest_request?.withdrawn)return {key:'withdrawn',tone:'neutral',step:1,title:'未发送消息已撤回',detail:'未发送内容已移出队列并放回输入框。修改后可重新发送。'};
    const settled=settledBranch(page,{...view,request:r});
    if(settled)return {key:'settled_blocked',tone:'neutral',step:4,title:page.paused?'本批已收尾 · 受阻留档':'可接新任务 · 上批受阻留档',detail:settled.partial_public_send?'只送达部分文字的网页回合已核对留档；旧任务没有重发，也没有记作协作者成功。主控可以安排新工作。':'主控已接收保存的成果并处理此分支，无需恢复这条旧任务。'+(settled.author_markdown_saved?'原始 Markdown 已保留。':'仅保留网页采集结果，不能视为原始 Markdown 完整回传。')+' 工具受阻记录保留，不计作 worker 成功完成。'};
    if(page.paused&&!r&&latest?.phase==='completed')return {key:'completed',tone:'success',step:4,title:'本轮结果已保存',detail:'本轮回复已收齐并保存，是否达成全部目标以回复中的成果和未完成项为准。后续自动推进保持暂停；重新打开应用不会自动发送。'};
    if(!r&&!generating&&latest?.phase==='blocked')return {key:'blocked',tone:'warning',step:4,title:'本轮受阻 · 需要处理',detail:'本轮已停下，原回复与工具回执保留。请查看工作记录中的具体原因；不会自动重试被拒操作。'};
    if(page.paused&&page.preparation_result?.task_outcome==='not_started')return {key:'paused',tone:'warning',step:1,title:'首任务等待恢复',detail:'首轮已送达，但任务尚未取得执行资格。原回复和任务保留；核对后点击恢复，继续尚未开始的工作。'};
    if(page.paused)return {key:'paused',tone:'waiting',step:r?.phase==='queued'?1:2,title:'后续自动推进已暂停',detail:r?.phase==='queued'?'消息仅保存在本地，尚未发送到网页。明确恢复自动推进后再发送。':'当前回合与已接受的执行继续核对和保存结果；不再自动派发新回合。保存补充不会恢复。'};
    // A saved blocked result is not an idle, ready-to-start conversation.
    // Keep newer work and live manual turns independent of the older result.
    // A retired, never-sent recovery attempt must not override the saved result.
    if(!r&&!generating&&latest?.phase==='completed')return {key:'completed',tone:'success',step:4,title:'本轮结果已保存',detail:'本轮回复已收齐并保存。是否达成全部目标以回复中的成果、验证和未完成项为准。'};
    if(o.historyAtLatest===false&&!o.generating&&['queued','processing','suspended'].includes((r||page.latest_request)?.phase))return {key:'history_position',tone:'waiting',step:3,title:'正在核对最新回复',detail:'网页目前显示较早的历史。后台会定位到最新回复；若正在查看原网页，请滚到最下方。此操作不发送消息，也不会重做任务。'};
    if(view.run?.state==='draining')return {key:'draining',tone:'waiting',step:3,title:view.run.reason==='deadline'?'运行窗口已结束 · 等待收尾':'发送预算已用完 · 等待收尾',detail:'不再派发新工作，保留已执行成果。主控在原预算内核销现有结果并保存交接。'};
    if(page.bootstrap_wait)return {key:'resource_wait',tone:'waiting',step:1,title:'等待工作目录空闲 · 尚未发送',detail:'主控或其他任务正在使用相交的目录或资源。程序等待其让出后再发送首任务，等待不消耗模型回合。'};
    if(page.enrolling&&(!o.editorReady||page.bootstrap_state==='pending'))return {key:'enrolling',tone:'waiting',step:0,title:o.editorReady?'准备接入项目':'等待网页加载',detail:o.editorReady?'正在核对网页控件和指定档位，接入消息尚未发送。':'网页输入区尚未就绪；程序继续检查，此等待不产生模型发送。'};
    if(page.enrolling&&(page.first_turn_instructions||page.has_first_turn_instructions)){const task=page.first_turn_mode==='task_v1';return {key:'enrolling',tone:'active',step:0,title:page.enrollment_phase==='receiver_enrolled'?(task?'工具已接入 · 首个任务进行中':'工具已接入 · 本轮正在准备'):(task?'正在接入并工作':'正在接入并准备'),detail:'本轮使用 '+(enrollmentState(page).selection.effort||'待核对档位')+' 完成接入和'+(task?'首个完整任务':'首次准备')+'。成果保存到工作记录，不重复派发本轮要求。'};}
    if(!page.bound)return {key:page.enrolling?'enrolling':'setup',tone:page.enrolling?'active':'neutral',step:0,title:page.enrolling?'正在接入项目':'尚未接入项目',detail:page.enrolling?'正在等待网页取得工具回执。接入完成会自动回到工作记录。':'先在网页登录并选择模型，再确认工作目录与访问范围。接入后直接在这里发送目标。'};
    if(page.work_model_pending)return {key:'enrolling',tone:'waiting',step:0,title:'已接入 · 正在核对工作模型',detail:'接入回合已结束；正在切到指定的工作模型，确认前不派发工作。此切换不发送模型消息。'};
    if(m.mismatch&&!o.generating)return {key:'model_mismatch',tone:'warning',step:1,title:'网页模型设置已变化',detail:'任务采用 '+m.expected+'；网页显示 '+m.actual+'。确认采用新设置后才会继续发送。'};
    if(a?.state==='not_sent')return {key:'not_sent',tone:'warning',step:1,title:'发送前检查未通过 · 尚未发送',detail:'程序确认没有点击发送。原目标保留，可撤回修正；没有自动重试。'};
    if(a?.dispatched&&!a?.acknowledged)return {key:'confirming',tone:'warning',step:1,title:'发送待核对',detail:'已尝试发送，尚未确认网页收到。程序核对同一次发送记录，不重复发送。'};
    if(r?.phase==='queued')return {key:o.draft?'draft':'queued',tone:o.draft?'warning':'active',step:1,title:o.draft?'网页有未发送草稿':'本地排队 · 尚未送达',detail:o.draft?'请在原网页处理草稿，工作区不会覆盖你的输入。':'正在等待网页就绪并核对模型。排队不会消耗一次模型发送。'};
    if(r?.phase==='suspended')return {key:'waiting',tone:'waiting',step:3,title:'等待原任务结果',detail:'原任务已进入等待，程序核对已登记的执行或协作者结果；有新结果时合并接续。等待本身不发送模型消息。'};
    if(o.generating&&!observationFresh(o,now))return {key:'observation_stale',tone:'warning',step:3,title:'状态待核对',detail:'最近的网页观察已经过期，无法确认仍在工作。程序核对原页面和执行回执，不把旧的工作标记当作当前状态，也不会重发消息。'};
    if(generating)return {key:'working',tone:'active',step:2,title:'思考／工作',detail:'消息已送达，当前网页仍在生成。'+(view.pending_notes?'有 '+view.pending_notes+' 条补充等待主控读取，不会打断当前网页回合。':'本轮结束后自动收集结果。')};
    if(view.automatic_recovery){
      const recovery=view.automatic_recovery;
      if(recovery.state==='exhausted')return {key:'recovery_exhausted',tone:'warning',step:2,title:'思考连续失败 · 需要处理',detail:'已用完本任务的 '+recovery.limit+' 次自动接续。原任务和成果保留，停止自动发送；请查看原网页与执行回执。'};
      return {key:'auto_recovery',tone:'waiting',step:2,title:'思考失败 · 将自动接续原任务',detail:recovery.state==='backoff'?'第 '+recovery.ordinal+' / '+recovery.limit+' 次恢复，最早于 '+new Date(recovery.due*1000).toLocaleTimeString()+' 发送。无需手动发“继续”；沿用原任务、模型和已有成果，恢复计入发送预算。':'程序正在等待原协作者或核对恢复条件；不会重做已有操作。'};
    }
    if(o.failure)return {key:'failure_reconciling',tone:'warning',step:2,title:'思考失败 · 正在核对原回合',detail:'网页已明确报告生成失败。核对原消息和工具回执后按原任务恢复；不会重新接入或重做已接受的操作。'};
    if(r?.phase==='processing')return {key:'collecting',tone:'waiting',step:3,title:'核对并保存结果',detail:o.complete?'网页已结束回答，正在核对工具结果与任务状态。':'尚未确认网页当前是否仍在生成；正在核对原执行与回执。「处理中」本身不代表模型仍在工作。'};
    if(view.latest_request?.phase==='completed')return {key:'completed',tone:'success',step:4,title:'本轮结果已保存',detail:'本轮回复已收齐并保存。可以追加要求；全部目标是否达成以实际成果为准。'};
    return {key:'ready',tone:'neutral',step:0,title:'可以发送目标',detail:'从这里开始或补充工作。原网页与本任务是同一段对话，无需导入工作记录。'};
  }
  function workflow(page,view={},connected=true,now=Date.now()){
    const notice=observationNotice(page);
    // Work from a presentation-only copy. Preserve the original observation
    // and durable request, including all real business attention and faults.
    const businessFault=notice&&(page.issue_kind||page.observation.fault);
    const projected=notice?{...page,observation:{...page.observation,
      error:failures.describe(businessFault)?businessFault:null}}:page;
    let f=workflowState(projected,view,connected,now);
    if(notice&&(['working','working_held','collecting'].includes(f.key)||
      f.key==='paused'&&['processing'].includes((view.request||page?.latest_request)?.phase)||
      f.key==='enrolling'&&page?.bootstrap_state==='sent')){
      f={key:'observation_stale',tone:'warning',step:null,title:'网页当前状态待核对',
        detail:'网页状态读取超时，暂时无法确认当前回合仍在工作或已经结束。原消息和回执保留，正在核对；不会因此重发。'+
          (page?.paused?'后续自动推进保持暂停，原网页回合没有因此被停止。':'')};
    }
    f.observationNotice=notice;
    const steps={queued:0,draft:0,confirming:0,resource_wait:0,working:1,working_held:1,collecting:2,waiting:2,
      history_position:2,draining:2,team_pausing:2,auto_recovery:2,recovering:2,failure_reconciling:2,completed:3};
    if(f.key==='enrolling'){
      const o=page?.observation||{};
      f.step=page?.bootstrap_state==='pending'?0:o.generating&&observationFresh(o,now)?1:2;
      f.title=f.step===0?'准备发送':f.step===1?'思考／工作 · 首次任务':'等待／回收 · 首轮结果';
      f.tone=f.step===1?'active':'waiting';
    }else f.step=steps[f.key]??null;
    if(f.key==='worker_setup')f.title='首次发送设置需修复';
    if(f.key==='setup')f.title='等待首次任务';
    if(f.key==='attention'&&!page?.bound)f.title=f.title.replaceAll('接入','首轮');
    const goal=view.page_id===page?.id?view.goal:null;
    if(goal?.configured&&goal.mode==='manual'&&goal.identity_valid!==false&&!view.state_read?.unavailable&&!view.request&&!page?.observation?.generating&&['completed','ready','paused'].includes(f.key)){
      const review=goal.review?.request_id===goal.request_id?goal.review:null;
      if(goal.state==='complete'&&review?.decision==='complete'){
        f.key='goal_complete';f.title='目标已由你确认完成';f.detail='你的验收决定已保存。再次工作需明确修改目标并发起，不会自动发送。';f.tone='success';f.step=3;
      }else if(goal.can_start_next){
        f.key='goal_next';f.title='验收已保存 · 下一包待开始';f.detail='沿用原目标与成果。只有明确点击“开始下一包”才发送，预算不会自动增加。';f.tone='waiting';f.step=3;
      }else if(goal.can_review&&!review){
        f.key='goal_review';f.title='本轮结果已保存 · 待你验收';f.detail='模型回合收尾后由你核对真实成果，决定目标是否达成以及是否发起下一包。';f.tone='waiting';f.step=3;
      }
    }
    // Stopped or exceptional work never lights up the work/completion step.
    // A step describes progress; success still requires a saved terminal result.
    return f;
  }
  function taskStatus(page,connected=true){
    if(page.loading)return {key:'loading',tone:'waiting',title:'正在恢复任务',label:'正在恢复任务',dot:'loading'};
    const latest=page.latest_request;
    // Project the same workflow using THIS page's ledger, never the selected
    // page's view or the browser container's generic idle/running flag.
    const f=workflow(page,{latest_request:latest,request:['queued','processing','suspended'].includes(latest?.phase)?latest:null},connected);
    const titles={account:'账号登录',working:'思考／工作',collecting:'核对并保存结果',waiting:'等待原任务结果',
      queued:'本地排队 · 尚未发送',ready:'可以发送',completed:'本轮结果已保存',blocked:'受阻 · 需要处理',setup:'等待首次任务',
      parent_paused:latest?.phase==='completed'?'本轮结果已保存 · 主控暂停':'跟随主控暂停',attention:'需要处理',worker_setup:'首次发送需修复'};
    return {...f,label:titles[f.key]||f.title,dot:f.tone==='warning'?'paused':['working','working_held'].includes(f.key)?'running':f.tone==='waiting'?'waiting':''};
  }
  const deliveries={queued:['本地已保存 · 尚未发送','waiting'],confirming:['发送待核对','warning'],delivered:['已送达网页','success'],queued_note:['补充已保存 · 等待合并处理','waiting'],delivered_note:['主控已收到补充','success']};
  return {modelState,enrollmentState,settledBranch,observationNotice,workflow,taskStatus,deliveries};
});
