'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {workflow,modelState,taskStatus}=require('../workflow-state.js');
const page={id:'task',bound:true,model:'GPT-5.6 · 最新',effort:'极高'};

test('a fresh accepted webpage keeps working while its future automation is paused',()=>{
  const latest={id:'accepted',phase:'processing',attempt_id:'original-attempt'};
  const p={...page,paused:true,latest_request:latest,observation:{at:100000,generating:true,attemptId:'original-attempt'}};
  const result=workflow(p,{request:latest},true,100001);
  assert.equal(result.key,'working_held');assert.equal(result.step,1);assert.equal(result.tone,'active');
  assert.match(result.title,/工作.*自动推进已暂停/);assert.match(result.detail,/仍会收集并保存/);
  assert.match(workflow({...p,observation:{...p.observation,generating:false}},{request:latest},true,100001).title,/自动推进已暂停/);
  assert.equal(workflow(p,{request:latest,maintenance:{state:'holding',pending:[{id:'accepted'}]}},true,100001).key,'working_held');
  assert.notEqual(workflow({...p,attention:'user stopped',issue_kind:'user_stopped'},{request:latest},true,100001).key,'working_held');
  assert.notEqual(workflow(p,{request:latest},true,140001).key,'working_held');
  assert.notEqual(workflow(p,{request:null,latest_request:{...latest,phase:'completed'}},true,100001).key,'working_held');
});

test('unselected task metadata retains the first-task workflow without carrying its full instructions',()=>{
 const full={...page,bound:false,enrolling:true,first_turn_mode:'task_v1',first_turn_instructions:'Read project and implement the complete package',
   bootstrap_state:'sent',bootstrap_model_selection:{model:'GPT-6',effort:'Pro'},observation:{generating:true,observed:Date.now()/1000}};
 const metadata={...full,first_turn_instructions:undefined,has_first_turn_instructions:true};
 assert.deepEqual(workflow(metadata),workflow(full));assert.equal(taskStatus(metadata).label,taskStatus(full).label);
 const stopped={...full,paused:true,bootstrap_state:'pending',attention:'旧任务缺少已确认的 Extra High'};
 assert.deepEqual(workflow({...stopped,first_turn_instructions:undefined,has_first_turn_instructions:true}),workflow(stopped));
});

test('ended-turn program recovery is waiting and an explicit pause takes precedence',()=>{
 const latest={id:'original',phase:'processing',attempt_id:'control_original'};
 const p={...page,paused:true,attention:'missing ending',latest_request:latest,
   ended_recovery:{attempt_id:'control_original',state:'waiting_jobs'},pause_origin:{source:'attention'}};
 assert.equal(workflow(p).key,'recovering');assert.equal(workflow(p).step,2);
 assert.notEqual(workflow({...p,pause_origin:{source:'operator'}}).key,'recovering');
 assert.notEqual(workflow({...p,latest_request:{...latest,attempt_id:'new_attempt'}}).key,'recovering');
});

test('resource queue and already delivered unadmitted task have distinct truthful labels',()=>{
 const waiting={...page,bound:false,enrolling:true,bootstrap_state:'pending',bootstrap_wait:{state:'waiting_local_slot'}};
 assert.equal(workflow(waiting).key,'resource_wait');
 assert.equal(taskStatus(waiting).key,'resource_wait');
 const stopped={...page,paused:true,preparation_result:{task_outcome:'not_started'},latest_request:{phase:'queued'}};
 assert.match(workflow(stopped,{request:stopped.latest_request}).title,/等待恢复/);
 assert.match(workflow(stopped,{request:stopped.latest_request}).detail,/首轮已送达/);
});

test('restoration is not unbound and retired recovery is not an unsent task',()=>{
 assert.equal(taskStatus({...page,bound:false,loading:true}).label,'正在恢复任务');
 const p={...page,observation:{failure:'无法思考'}};
 const view={latest_request:{phase:'completed'},attempt:{state:'not_sent'}};
 assert.equal(workflow(p,view).key,'completed');
 assert.equal(workflow(p,{...view,request:{phase:'queued'}}).key,'not_sent');
 assert.equal(workflow({...p,attention:'original refusal'},view).key,'attention');
});

test('observed thinking failure cannot remain labelled working while ledger reconciliation is pending',()=>{
 const p={...page,latest_request:{phase:'processing'},observation:{generating:false,failure:'无法思考'}};
 assert.equal(workflow(p,{request:p.latest_request}).key,'failure_reconciling');
 assert.equal(taskStatus(p).key,'failure_reconciling');
 assert.equal(workflow({...p,paused:true},{request:p.latest_request}).key,'paused');
 assert.equal(taskStatus({...p,latest_request:{phase:'completed'}}).key,'completed');
});

test('sidebar and worker chips use each task ledger and observation, not container idle',()=>{
 const p={...page,status:'idle',latest_request:{phase:'processing'},observation:{generating:true}};
 assert.equal(taskStatus(p).key,workflow(p,{request:p.latest_request}).key);
 assert.equal(taskStatus(p).label,'思考／工作');assert.equal(taskStatus(p).dot,'running');
 assert.equal(taskStatus({...p,latest_request:{phase:'suspended'}}).key,'waiting');
 assert.equal(taskStatus({...p,latest_request:{phase:'queued'}}).key,'queued');
 assert.equal(taskStatus({...p,paused:true}).key,'working_held');
 assert.equal(taskStatus({...p,attention:'original error'}).key,'attention');
 assert.equal(taskStatus({...p,observation:{approvalRequired:true,generating:true}}).key,'approval_required');
 assert.equal(taskStatus({...p,observation:{complete:true}}).label,'核对并保存结果');
 assert.equal(taskStatus({...p,latest_request:{phase:'completed'},observation:{}}).key,'completed');
 assert.equal(taskStatus({...p,latest_request:{phase:'completed'}}).key,'working');
 assert.equal(taskStatus(p,false).key,'offline');
});

test('old local Pro setup guard is not presented as an unavailable model or platform refusal',()=>{
 const result=workflow({bound:false,enrolling:true,paused:true,bootstrap_state:'pending',issue_kind:'model_unavailable',
   attention:'接入和简单准备不能使用 Pro。此旧任务缺少已确认的 Extra High 接入设置',first_turn_instructions:'Research plan'});
 assert.equal(result.key,'preparation_required');assert.match(result.title,/本地旧规则/);assert.match(result.detail,/尚未发送/);
 const real=workflow({bound:false,attention:'The model is unavailable',issue_kind:'model_unavailable'});
 assert.equal(real.key,'model_unavailable');
 const child={parent:'M',bound:false,paused:true,attention:'local rule',issue_kind:'preparation_required',bootstrap_state:'pending',bootstrap_model_selection:{effort:'Pro'}};
 assert.equal(workflow(child).key,'worker_setup');assert.equal(taskStatus(child).label,'首次发送需修复');
 assert.notEqual(workflow({...child,bootstrap_state:'sent'}).key,'worker_setup');
});
test('automatic thinking recovery and exhaustion are visible while explicit pause still wins',()=>{
 const view={request:{phase:'processing'},automatic_recovery:{state:'backoff',ordinal:1,limit:3,due:1000}};
 assert.equal(workflow(page,view).key,'auto_recovery');
 assert.equal(workflow({...page,paused:true},view).key,'paused');
 assert.equal(workflow(page,{...view,automatic_recovery:{state:'exhausted',limit:3}}).key,'recovery_exhausted');
});
test('persisted fault kinds distinguish login, model quota, and unknown receipts',()=>{
 for(const kind of ['login_required','usage_limit','model_unavailable','control_failed']){
  const result=workflow({...page,parent:'M',paused:true,attention:'original detail',issue_kind:kind});assert.equal(result.key,kind);assert.match(result.detail,/仅此分支/);
 }
 assert.equal(workflow({...page,observation:{error:'runtime_receipt_unknown_reconcile_original'}}).key,'runtime_receipt_unknown_reconcile_original');
});
test('historical viewport explains pending collection without masking pause or actual errors',()=>{
 const p={...page,observation:{historyAtLatest:false},latest_request:{phase:'processing'}};
 assert.equal(workflow(p).key,'history_position');
 assert.equal(workflow({...p,paused:true}).key,'paused');
 assert.equal(workflow({...p,attention:'original refusal'}).key,'attention');
 assert.notEqual(workflow({...p,latest_request:{phase:'completed'}}).key,'history_position');
});
test('pending public confirmation and account cooldown cannot be labelled thinking or complete',()=>{
 const awaiting={...page,observation:{approvalRequired:true}};
 assert.equal(workflow(awaiting,{request:{phase:'processing'},run:{state:'closed'}}).key,'approval_required');
 assert.equal(workflow({...awaiting,paused:true}).key,'approval_required');
 assert.equal(workflow({...awaiting,accountAccess:{blocked:true,message:'shared wait'}}).key,'account_cooldown');
});
test('inherited pause identifies the controller without masking an independent page error',()=>{
  const child={...page,parent:'main',paused:true,pause_origin:{inherited:true,page_id:'main',title:'M'},observation:{error:'managed_page_not_ready'}};
  const result=workflow(child,{latest_request:{phase:'completed'}});
  assert.equal(result.key,'parent_paused');assert.equal(result.actionPage,'main');assert.match(result.detail,/上一任务已完成/);
  assert.equal(workflow({...child,attention:'login expired'}).key,'attention');
  assert.equal(workflow({...child,observation:{error:'renderer_crashed'}}).key,'renderer_crashed');
});
test('missing receipt shows accepted work and drained run permits finalization only',()=>{
  const view={run:{state:'draining'},reconciliation:{missing_tool_outcome:true,assignments_in_ended_turn:[{request_id:'original'}],latest_checkpoint:{version:10}}};
  const result=workflow({...page,paused:true,attention:'Nothing executed'},view);
  assert.equal(result.key,'reconcile');assert.match(result.detail,/1 项派发/);assert.match(result.detail,/v10/);assert.match(result.detail,/仅用于收尾/);
  assert.equal(workflow(page,{run:{state:'draining',reason:'deadline'},request:{phase:'suspended'}}).key,'draining');
});
test('local queue and unknown Send never pretend the model is thinking',()=>{
  assert.equal(workflow(page,{request:{phase:'queued'}}).key,'queued');
  assert.equal(workflow(page,{request:{phase:'queued'},attempt:{dispatched:123,acknowledged:null}}).key,'confirming');
  assert.equal(workflow({...page,observation:{generating:true}},{request:{phase:'processing'},attempt:{acknowledged:123}}).key,'working');
  assert.equal(workflow({...page,observation:{generating:true}},{request:{phase:'suspended'}}).key,'waiting');
});
test('pause stays explicit with queued messages and model changes',()=>{
  const changed={...page,paused:true,observation:{effortLabel:'中'}};
  assert.equal(modelState(changed).mismatch,true);
  assert.equal(workflow(changed,{request:{phase:'queued'}}).key,'paused');
  assert.match(workflow(changed,{request:{phase:'queued'}}).detail,/尚未发送/);
  assert.equal(workflow({...changed,paused:false},{request:{phase:'queued'}}).key,'model_mismatch');
});
test('a new task gives setup guidance and completion needs a real terminal request',()=>{
  assert.equal(workflow({...page,bound:false},{}).key,'setup');
  assert.equal(workflow(page,{run:{state:'closed'}}).key,'ready');
  assert.equal(workflow(page,{latest_request:{phase:'completed'}}).key,'completed');
  assert.equal(workflow({...page,paused:true},{latest_request:{phase:'completed'}}).key,'completed');
  assert.equal(workflow(page,{},false).key,'offline');
});

test('retired blocked branches are distinct from paused or successful work',()=>{
  const latest={phase:'blocked',resolution:{author_markdown_saved:false}};
  const result=workflow({...page,paused:true},{latest_request:latest});
  assert.equal(result.key,'settled_blocked');assert.equal(result.tone,'neutral');assert.match(result.detail,/仅保留网页采集/);
  assert.equal(workflow({...page,paused:true,latest_request:latest}).key,'settled_blocked');
  assert.equal(workflow({...page,paused:true,latest_request:latest},{request:{phase:'queued'},latest_request:{phase:'queued'}}).key,'paused');
  assert.equal(workflow({...page,paused:true,attention:'new error'},{latest_request:latest}).key,'attention');
});

test('a saved blocked first task stays visible in the header and sidebar',()=>{
  const latest={id:'first-task',phase:'blocked',resolution:null};
  const p={...page,bootstrap_state:'sent',first_turn_mode:'task_v1',latest_request:latest,
    observation:{generating:false,historyAtLatest:false}};
  const result=workflow(p,{latest_request:latest,run:{state:'closed'}});
  assert.equal(result.key,'blocked');assert.equal(result.tone,'warning');
  assert.match(result.detail,/不会自动重试/);
  assert.equal(taskStatus(p).key,result.key);assert.equal(taskStatus(p).label,'受阻 · 需要处理');
  assert.equal(taskStatus(p).dot,'paused');
});

test('a historical block does not mask newer work, pauses, or a resolved branch',()=>{
  const latest={phase:'blocked',resolution:null};
  const p={...page,latest_request:latest};
  assert.equal(workflow(p,{request:{phase:'queued'},latest_request:latest}).key,'queued');
  assert.equal(workflow(p,{request:{phase:'processing'},latest_request:latest}).key,'collecting');
  assert.equal(workflow({...p,observation:{generating:true}},{latest_request:latest}).key,'working');
  assert.equal(workflow({...p,paused:true},{latest_request:latest}).key,'blocked');
  assert.equal(workflow({...p,attention:'original failure'},{latest_request:latest}).key,'attention');
  assert.equal(workflow(p,{latest_request:{...latest,resolution:{author_markdown_saved:true}}}).key,'settled_blocked');
});
test('partial public Send is a separate review state and retirement stays blocked',()=>{
  const partial={request_id:'old',attempt_id:'control_old',observation_hash:'a'.repeat(64)};
  const pending=workflow({...page,paused:true,attention:'partial_or_foreign_public_send'},
    {partial_public_send:partial,request:{phase:'queued'}});
  assert.equal(pending.key,'partial_public_send');assert.match(pending.detail,/不会.*重发/);
  const retired=workflow({...page,paused:false},
    {latest_request:{phase:'blocked',resolution:{partial_public_send:true,author_markdown_saved:false}}});
  assert.equal(retired.key,'settled_blocked');assert.match(retired.detail,/部分文字/);
  assert.doesNotMatch(retired.detail,/原始 Markdown 完整回传/);
});

test('maintenance distinguishes draining accepted turns from the saved pause',()=>{
  assert.equal(workflow(page,{maintenance:{state:'holding',pending:[{kind:'web_turn'}]}}).key,'team_pausing');
  assert.equal(workflow(page,{maintenance:{state:'settled',pending:[]}}).key,'team_paused');
  assert.equal(workflow({...page,parent:'controller'},{maintenance:{state:'settled',pending:[]},request:{phase:'processing'}}).key,'collecting');
  const held=workflow({...page,attention:'platform refusal'},{maintenance:{state:'settled',pending:[]}});
  assert.equal(held.key,'team_paused');assert.equal(held.tone,'warning');assert.match(held.title,/原问题/);assert.match(held.detail,/不会清除/);
});

test('a later platform refusal report is not hidden by an older scope failure',()=>{
  const f=workflow({...page,bound:false,paused:true,enrolling:true,attention:'first: team_write_paths_required',intake:{latest_public_reply:{public_text:'因 OpenAI 无法确定请求的安全状态，已拦截此工具调用。'}}});
  assert.match(f.title,/网页报告/);assert.match(f.detail,/不能替代平台原始判定/);assert.equal(f.step,null);assert.equal(f.key,'attention');
  const fixed=workflow({...page,bound:false,paused:true,attention:'first: team_write_paths_required',intake:{configuration_error:null}});
  assert.match(fixed.title,/配置已修正/);assert.match(fixed.detail,/没有重试/);
});

test('progress has four stages and exceptional exits never light up work or completion',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const steps=html.match(/<ol id="workflow-steps">(.*?)<\/ol>/)[1];
  assert.deepEqual([...steps.matchAll(/<li>(.*?)<\/li>/g)].map(m=>m[1]),['发送','思考／工作','等待／核对结果','结果已保存']);
  assert.equal(workflow(page,{request:{phase:'queued'}}).step,0);
  assert.equal(workflow({...page,observation:{generating:true}},{request:{phase:'processing'}}).step,1);
  assert.equal(workflow(page,{request:{phase:'processing'}}).step,2);
  assert.equal(workflow(page,{latest_request:{phase:'completed'}}).step,3);
  for(const p of [{...page,paused:true},{...page,attention:'Original failure'},
    {...page,latest_request:{phase:'blocked'}}])assert.equal(workflow(p).step,null);
});

test('an ended reply pending collection is waiting rather than claimed live work',()=>{
  const p={...page,latest_request:{phase:'processing'},observation:{at:Date.now(),generating:false,complete:true}};
  const result=taskStatus(p);assert.equal(result.key,'collecting');assert.equal(result.tone,'waiting');
  assert.equal(result.label,'核对并保存结果');assert.equal(result.dot,'waiting');
  assert.notEqual(taskStatus({...p,observation:{generating:false,complete:false}}).dot,'running');
});

test('expired observations cannot sustain a working label or falsely certify completion',()=>{
  const p={...page,latest_request:{phase:'processing'},observation:{generating:true,at:100000}};
  const stale=workflow(p,{request:p.latest_request},true,140000);
  assert.equal(stale.key,'observation_stale');assert.equal(stale.step,null);assert.equal(stale.tone,'warning');
  assert.equal(workflow(p,{request:p.latest_request},true,110000).key,'working');
});

test('terminal receipt for the observed attempt wins over a lingering busy flag while a different manual turn remains live',()=>{
  const latest={phase:'completed',attempt_id:'control_current',sent_user_hash:'original-user'};
  const o={at:Date.now(),generating:true,attemptId:'control_current',userTurnHash:'original-user'};
  const p={...page,latest_request:latest,observation:o};
  assert.equal(taskStatus(p).key,'completed');assert.notEqual(taskStatus(p).dot,'running');
  assert.equal(taskStatus({...p,latest_request:{...latest,phase:'blocked'}}).key,'blocked');
  assert.equal(taskStatus({...p,observation:{...o,attemptId:null,userTurnHash:'new-manual-user'}}).key,'working');
});

test('blocked first-task outcome cannot be labelled awaiting an unstarted task',()=>{
  const p={...page,paused:true,preparation_result:{task_outcome:'not_started'},latest_request:{phase:'blocked'},observation:{generating:false}};
  assert.equal(taskStatus(p).key,'blocked');assert.equal(taskStatus(p).step,null);
});

test('header falls back to its own current request while selection detail is loading',()=>{
  const p={...page,latest_request:{phase:'processing'},observation:{generating:false}};
  assert.equal(workflow(p).key,'collecting');assert.equal(workflow(p).step,2);
  assert.equal(workflow({...p,latest_request:{phase:'suspended'}}).key,'waiting');
  assert.equal(workflow({...p,latest_request:{phase:'completed'},paused:true}).key,'completed');
  assert.equal(workflow({...p,latest_request:{phase:'queued'}}).key,'queued');
});

test('saved goal packages await human review and require its exact original receipt before claiming goal acceptance',()=>{
  const p={...page,latest_request:{id:'original',phase:'completed'},observation:{generating:false}};
  const view={page_id:p.id,goal:{configured:true,mode:'manual',state:'paused',request_id:'original',can_review:true}};
  assert.equal(workflow(p,view).key,'goal_review');assert.match(workflow(p,view).title,/待你验收/);
  const ready={...view,goal:{...view.goal,can_start_next:true,review:{request_id:'original',decision:'continue'}}};
  assert.equal(workflow(p,ready).key,'goal_next');assert.match(workflow(p,ready).detail,/预算不会自动增加/);
  const complete={...view,goal:{...view.goal,state:'complete',review:{request_id:'original',decision:'complete'}}};
  assert.equal(workflow(p,complete).key,'goal_complete');
  assert.equal(workflow(p,{...complete,goal:{...complete.goal,review:{request_id:'foreign',decision:'complete'}}}).key,'goal_review');
  assert.equal(workflow(p,{...complete,goal:{...complete.goal,mode:'automatic'}}).key,'completed');
  assert.equal(workflow(p,{...complete,page_id:'other'}).key,'completed');
  assert.equal(workflow({...p,latest_request:{id:'running',phase:'processing'}},{...view,request:{id:'running',phase:'processing'}}).key,'collecting');
});

test('read-only snapshot timeout cannot replace a saved terminal result with task failure',()=>{
  const p={...page,paused:true,latest_request:{id:'finished',phase:'completed'},
    observation:{error:'page_snapshot_timeout',errorAt:100001,generating:false}};
  const before=JSON.stringify(p),result=workflow(p,{},true,100002);
  assert.equal(result.key,'completed');assert.equal(result.tone,'success');assert.equal(result.step,3);
  assert.equal(result.title,'本轮结果已保存');assert.match(result.detail,/是否达成全部目标/);
  assert.equal(result.observationNotice.code,'page_snapshot_timeout');
  assert.equal(result.observationNotice.title,'网页状态读取超时');
  assert.match(result.observationNotice.detail,/已保存的回复和送达记录仍可查看/);
  assert.equal(taskStatus(p).label,'本轮结果已保存');assert.equal(taskStatus(p).dot,'');
  assert.equal(JSON.stringify(p),before,'presentation must not clear the stored error or pause');
});

test('read failure marks current accepted webpage status unknown while preserving future pause',()=>{
  const latest={id:'accepted',phase:'processing',attempt_id:'current'};
  for(const paused of [false,true])for(const generating of [false,true]){
    const p={...page,paused,latest_request:latest,
      observation:{at:100000,generating,attemptId:'current',error:'page_snapshot_timeout'}};
    const result=workflow(p,{request:latest},true,100001);
    assert.equal(result.key,'observation_stale');assert.equal(result.step,null);assert.equal(result.tone,'warning');
    assert.match(result.detail,/无法确认当前回合仍在工作或已经结束/);
    assert.doesNotMatch(result.title,/失败|已暂停|已完成/);
    if(paused)assert.match(result.detail,/后续自动推进保持暂停/);
    assert.equal(result.observationNotice.code,'page_snapshot_timeout');
  }
});

test('read notice is independent of queued sends, unknown delivery, and registered-result waits',()=>{
  const p={...page,observation:{error:'page_snapshot_timeout',generating:true,at:100000}};
  const queued=workflow(p,{request:{phase:'queued'}},true,100001);
  assert.equal(queued.key,'queued');assert.match(queued.title,/尚未送达/);
  const unknown=workflow(p,{request:{phase:'queued'},attempt:{dispatched:100000,acknowledged:null}},true,100001);
  assert.equal(unknown.key,'confirming');assert.equal(unknown.title,'发送待核对');
  const waiting=workflow(p,{request:{phase:'suspended'}},true,100001);
  assert.equal(waiting.key,'waiting');assert.equal(waiting.title,'等待原任务结果');
  for(const result of [queued,unknown,waiting])assert.equal(result.observationNotice.code,'page_snapshot_timeout');
});

test('read-only notice never hides actual authorization, access, execution, or business faults',()=>{
  const p={...page,paused:true,latest_request:{phase:'completed'},observation:{error:'page_snapshot_timeout'}};
  for(const [patch,key] of [
    [{attention:'Original tool refusal'},'attention'],
    [{attention:'login expired',issue_kind:'login_required'},'login_required'],
    [{issue_kind:'runtime_receipt_unknown_reconcile_original'},'runtime_receipt_unknown_reconcile_original'],
    [{observation:{...p.observation,fault:'control_failed'}},'control_failed'],
    [{observation:{...p.observation,approvalRequired:true}},'approval_required'],
    [{observation:{...p.observation,loginRequired:true}},'login_required'],
    [{accountAccess:{blocked:true,message:'Current account unavailable'}},'account_cooldown']
  ]){
    const result=workflow({...p,...patch});assert.equal(result.key,key);assert.equal(result.tone,'warning');
    assert.equal(result.observationNotice.code,'page_snapshot_timeout');
  }
  for(const error of ['renderer_crashed','control_failed','runtime_receipt_unknown_reconcile_original','unknown_error']){
    const result=workflow({...p,observation:{error}});
    assert.equal(result.observationNotice,null);assert.notEqual(result.key,'completed');
  }
});

test('snapshot notice respects the original matching terminal receipt rather than an old busy flag',()=>{
  const latest={phase:'completed',attempt_id:'original',sent_user_hash:'original-user'};
  const p={...page,latest_request:latest,
    observation:{at:100000,error:'page_snapshot_timeout',generating:true,attemptId:'original',userTurnHash:'original-user'}};
  assert.equal(workflow(p,{},true,100001).key,'completed');
  assert.equal(workflow({...p,observation:{...p.observation,attemptId:null,userTurnHash:'manual-next'}},{},true,100001).key,'observation_stale');
});
