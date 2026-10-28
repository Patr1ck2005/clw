'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectedView,goalPresentation,composer,goalControls,unsentResumeRequest,resumeRelevant,needsWorkflowAction}=require('../task-presentation.js');
const page={id:'camp',kind:'task',bound:true},view={page_id:'camp',request:{id:'accepted-original',phase:'processing'}};

function unsentFixture(){
  return {page:{...page,paused:true,attention:'原发送前检查失败',issue_kind:'control_failed'},
    view:{page_id:page.id,request:{id:'original',phase:'queued',cancel_requested:0},
      latest_request:{id:'original',phase:'queued',attempt_id:'attempt-original',sent_user_hash:null},
      attempt:{id:'attempt-original',state:'not_sent',dispatched:100,acknowledged:null}}};
}
test('the original confirmed-unsent queue has one visible explicit resume, including control_failed',()=>{
  const {workflow}=require('../workflow-state.js'),f=unsentFixture(),flow=workflow(f.page,f.view,true);
  assert.equal(flow.key,'control_failed');
  assert.equal(unsentResumeRequest(f.page,f.view,flow,{}),'original');
  assert.equal(needsWorkflowAction(f.page,f.view,flow,{}),true);
  const clear={...f.page,attention:null,issue_kind:null},paused=workflow(clear,f.view,true);
  assert.equal(paused.key,'paused');
  assert.equal(unsentResumeRequest(clear,f.view,paused,{}),'original');
  assert.equal(needsWorkflowAction(clear,f.view,paused,{}),true);
  assert.equal(composer(f.page,f.view,{draft:'保存补充'}).resume,false);
});
test('unsent recovery presentation cannot borrow receipts or expose a retry for unknown or accepted work',()=>{
  const {workflow}=require('../workflow-state.js');
  const cases=[
    f=>{f.view.page_id='foreign';},f=>{f.view.state_read={unavailable:true};},
    f=>{f.page.latest_request={id:'newer-request',phase:'queued'};},f=>{f.page.latest_request={id:'original',phase:'processing'};},
    f=>{f.view.latest_request.id='foreign';},f=>{f.view.latest_request.phase='processing';},f=>{f.view.latest_request.attempt_id='other';},
    f=>{f.view.latest_request.sent_user_hash='accepted-hash';},f=>{delete f.view.latest_request.sent_user_hash;},
    f=>{f.view.attempt.acknowledged=100;},f=>{delete f.view.attempt.acknowledged;},
    ...['unknown','sent','dispatching','acknowledged'].map(state=>f=>{f.view.attempt.state=state;}),
    ...['processing','suspended','cancelled'].map(phase=>f=>{f.view.request.phase=phase;}),
    f=>{f.view.request.cancel_requested=1;},f=>{delete f.view.request.cancel_requested;},f=>{f.view.latest_request.withdrawn=true;},
    f=>{f.view.latest_request.resolution={reason:'already_settled'};},
    f=>{f.view.maintenance={state:'settled'};},f=>{f.page.pause_origin={inherited:true};},f=>{f.view.pause_origin={inherited:true};},
    f=>{f.view.partial_public_send={attempt_id:'attempt-original'};},f=>{f.page.successor='next';},
    f=>{f.page.observation={generating:true};},f=>{f.page.observation={approvalRequired:true};},
    f=>{f.page.observation={loginRequired:true};},f=>{f.page.accountAccess={blocked:true};},
    ...['tool_forbidden','usage_limit','login_required','model_mismatch','receipt_unknown'].map(issue=>f=>{f.page.issue_kind=issue;}),
  ];
  for(const change of cases){const f=unsentFixture();change(f);
    assert.equal(unsentResumeRequest(f.page,f.view,workflow(f.page,f.view,true),{}),null,String(change));}
  const f=unsentFixture();
  assert.equal(unsentResumeRequest(f.page,f.view,workflow(f.page,f.view,false),{}),null);
  assert.equal(unsentResumeRequest(f.page,f.view,{key:'control_failed'},{mismatch:true}),null);
});

test('selection never borrows a different task request or maintenance checkpoint',()=>{
  const foreign={page_id:'other',request:{id:'other-request'},maintenance:{state:'settled'}};
  assert.deepEqual(selectedView(page,foreign),{});
  const action=composer(page,foreign,{draft:'New goal'});
  assert.equal(action.active,false);assert.equal(action.held,false);assert.equal(action.label,'发送消息');
  assert.equal(action.disabled,true); // The selected ledger has not arrived yet.
});
test('running work has one supplement action and empty drafts cannot send',()=>{
  assert.equal(composer(page,view).disabled,true);
  const action=composer(page,view,{draft:'Check the final Player'});
  assert.equal(action.label,'保存补充');assert.equal(action.resume,false);assert.equal(action.disabled,false);
  assert.equal(needsWorkflowAction(page,view,{key:'working'},{}),false);
});
test('paused active work saves supplementary text without resuming automation',()=>{
  const stopped={...page,paused:true};
  const empty=composer(stopped,view),note=composer(stopped,view,{draft:'Use Unity'});
  assert.equal(empty.label,'保存补充');assert.equal(empty.disabled,true);assert.equal(empty.resume,false);
  assert.equal(note.label,'保存补充');assert.equal(note.disabled,false);assert.equal(note.resume,false);
  assert.equal(needsWorkflowAction(stopped,view,{key:'paused'},{}),false);
});
test('idle pause does not demand recovery until there is a new draft, and new work remains a separate submission',()=>{
  const stopped={...page,paused:true},idle={page_id:page.id};
  assert.equal(composer(stopped,idle).disabled,true);
  assert.equal(needsWorkflowAction(stopped,idle,{key:'paused'},{}),false);
  assert.equal(needsWorkflowAction(stopped,idle,{key:'paused'},{},true),true);
  const saved=composer(stopped,idle,{draft:'Next complete package'});
  assert.equal(saved.label,'保存草稿');assert.equal(saved.kind,'save-draft');assert.equal(saved.resume,false);assert.equal(saved.disabled,false);
});
test('completed QA and a delivered Goal do not expose meaningless automation recovery',()=>{
  const stopped={...page,paused:true},done={page_id:page.id,request:null,
    latest_request:{id:'done',phase:'completed'},pending_notes:0,next_round:{count:0,state:'pending'},
    goal:{configured:false,state:'not_set'}};
  assert.equal(resumeRelevant(stopped,done),false);
  assert.equal(needsWorkflowAction(stopped,done,{key:'completed'},{}),false);
  assert.equal(resumeRelevant(stopped,{...done,goal:{configured:true,mode:'automatic',state:'complete',display_state:'delivered'}}),false);
  // Typing a new instruction must provide an explicit way out of the pause.
  assert.equal(resumeRelevant(stopped,done,{draft:'下一条新消息'}),true);
  assert.equal(needsWorkflowAction(stopped,done,{key:'completed'},{},true),true);
  assert.equal(composer(stopped,done,{draft:'下一条新消息'}).kind,'save-draft');
});
test('pending next-round supplements and paused automatic Goals keep a real recovery path',()=>{
  const stopped={...page,paused:true},done={page_id:page.id,request:null,latest_request:{id:'done',phase:'completed'}};
  for(const pending of [{...done,pending_notes:2},{...done,next_round:{count:2,state:'pending'}},
    ...['running','active','paused','needs_attention'].map(state=>({...done,goal:{configured:true,mode:'automatic',state}}))]){
    assert.equal(resumeRelevant(stopped,pending),true);
    assert.equal(needsWorkflowAction(stopped,pending,{key:'paused'},{}),true);
  }
  assert.equal(resumeRelevant(stopped,{...done,goal:{configured:true,mode:'automatic',state:'waiting'}}),false,'independent result waiting is not a new send');
  assert.equal(resumeRelevant(stopped,{...done,goal:{configured:true,mode:'manual',state:'paused',can_review:true}}),false,'legacy review retains its separate action');
});
test('resume relevance requires the current request receipt, even when new text has been typed',()=>{
  const stopped={...page,paused:true},original={id:'original',phase:'processing',attempt_id:'attempt-original'},
    running={page_id:page.id,request:original,latest_request:original,attempt:{id:'attempt-original',state:'acknowledged',acknowledged:100}};
  assert.equal(resumeRelevant(stopped,running),true);
  for(const invalid of [
    {...running,page_id:'other'}, {...running,state_read:{unavailable:true}},
    {...running,latest_request:{...original,id:'other'}}, {...running,latest_request:{...original,phase:'queued'}},
    {...running,attempt:{...running.attempt,id:'other'}}, {...running,attempt:{...running.attempt,state:'unknown'}},
    {...running,attempt:{...running.attempt,acknowledged:null}}, {...running,request:{...original,phase:'queued'}},
    {...running,partial_public_send:{request_id:original.id}}, {...running,pause_origin:{inherited:true}},
    {...running,maintenance:{state:'holding'}},
  ])assert.equal(resumeRelevant(stopped,invalid,{draft:'新消息'}),false,JSON.stringify(invalid));
  const ended={page_id:page.id,request:null,latest_request:{id:'done',phase:'completed'},pending_notes:2};
  for(const state of ['delivery_unknown','sending'])assert.equal(resumeRelevant(stopped,{...ended,next_round:{count:2,state}},{draft:'新消息'}),false);
  assert.equal(resumeRelevant(stopped,{...ended,attempt:{state:'unknown'}},{draft:'新消息'}),false);
  assert.equal(resumeRelevant({...stopped,latest_request:{id:'newer',phase:'processing'}},ended,{draft:'新消息'}),false);
  assert.equal(resumeRelevant({...stopped,latest_request:{id:'done',phase:'processing'}},ended,{draft:'新消息'}),false);
});
test('matching page IDs cannot lend actions across different original thread identities',()=>{
  const stopped={...page,paused:true,thread_id:'original-thread'},foreign={page_id:page.id,thread_id:'other-thread',pending_notes:2};
  assert.deepEqual(selectedView(stopped,foreign),{});
  assert.equal(resumeRelevant(stopped,foreign,{draft:'新消息'}),false);
  assert.equal(needsWorkflowAction(stopped,foreign,{key:'successor',actionPage:'other'},{}),false);
  assert.equal(composer(stopped,foreign,{draft:'新消息'}).disabled,true);
});
test('maintenance saves supplementary text without clearing the team pause',()=>{
  const action=composer({...page,paused:true},{...view,maintenance:{state:'settled'}},{draft:'Refine artwork'});
  assert.equal(action.label,'保存补充');assert.equal(action.resume,false);assert.equal(action.disabled,false);
  assert.equal(composer({...page,paused:true},{page_id:page.id,maintenance:{state:'holding'}},{draft:'New'}).disabled,true);
});
test('inherited stops, partial sends and disconnected service block notes; new sends require the chosen model',()=>{
  for(const [p,v,options]of [
    [{...page,pause_origin:{inherited:true}},view,{}],
    [page,{...view,partial_public_send:{attempt_id:'original'}},{}],
    [page,view,{connected:false}],[page,{page_id:page.id,request:null},{modelMismatch:true}],
    [page,{...view,state_read:{unavailable:true,code:'read_unavailable'}},{}],
  ])assert.equal(composer(p,v,{draft:'Work',...options}).disabled,true);
  assert.equal(needsWorkflowAction(page,view,{key:'working',actionPage:'parent'},{}),true);
  assert.equal(needsWorkflowAction({...page,paused:true},{...view,state_read:{unavailable:true}},{key:'paused'},{}),false);
});
test('pending-submit reconciliation retains its single original action',()=>{
  const action=composer(page,view,{pending:'Original saved input'});
  assert.equal(action.label,'核对提交');assert.equal(action.kind,'reconcile');assert.equal(action.disabled,false);
});
test('supplement capacity counts Unicode characters and rejects overflow without truncating',()=>{
  const text='𠮷'.repeat(16000),action=composer(page,view,{draft:text});
  assert.equal(action.length,16000);assert.equal(action.disabled,false);
  assert.equal(composer(page,view,{draft:text+'一'}).disabled,true);
  assert.equal(composer(page,{page_id:page.id},{draft:'一'.repeat(24000)}).disabled,false);
});

test('goal metadata never borrows another selected task or labels a saved round as user acceptance',()=>{
  const saved={...page,goal:{state:'active',mode:'manual',cycles:2}},local={page_id:page.id,thread_id:'thread',goal:{state:'ready_for_review',mode:'manual',can_review:true}};
  assert.equal(goalPresentation(saved,local).title,'本轮结果待你验收');
  assert.equal(goalPresentation(saved,local).canReview,true);
  assert.equal(goalPresentation(saved,{page_id:'other',goal:{state:'complete'}}).state,'active');
  assert.equal(goalPresentation(saved,{page_id:'other',goal:{state:'complete'}}).editable,false);
  assert.equal(goalPresentation(saved,{...local,goal:{state:'complete',mode:'manual',request_id:'original',review:{request_id:'original',decision:'complete'}}}).title,'目标已确认完成');
  assert.equal(goalPresentation(saved,{...local,goal:{state:'complete',mode:'automatic'}}).title,'已交付');
  assert.equal(goalPresentation(saved,{...local,goal:{state:'unknown'}}).state,'unavailable');
  assert.equal(goalPresentation(saved,{...local,goal:{state:'unknown'}}).editable,false);
});

test('a new manual goal keeps ordinary sending without a legacy review gate',()=>{
  const idle={page_id:page.id,goal:{configured:true,state:'complete',display_state:'delivered',mode:'manual',result_contract:2,can_review:true,can_start_next:true}};
  const presentation=goalPresentation(page,idle);
  assert.equal(presentation.title,'已交付');assert.equal(presentation.canReview,false);assert.equal(presentation.canStartNext,false);
  assert.equal(composer(page,idle,{draft:'补充新的完整要求'}).kind,'send');
  assert.equal(composer(page,idle,{draft:'补充新的完整要求'}).disabled,false);
  assert.equal(composer(page,idle).disabled,true);
});

test('goal editing and human review require the actual controller, current read and an idle original round',()=>{
  const detail={page_id:page.id,goal:{state:'ready_for_review',can_review:true}};
  for(const p of [{...page,parent:'controller'},{...page,successor:'next'},{...page,bound:false}]){
    assert.equal(goalPresentation(p,detail).editable,false);assert.equal(goalPresentation(p,detail).canReview,false);
  }
  assert.equal(goalPresentation(page,{...detail,state_read:{unavailable:true}}).editable,false);
  assert.equal(goalPresentation(page,{...detail,request:{id:'still-accepted',phase:'processing'}}).canReview,false);
  assert.equal(goalPresentation({...page,observation:{generating:true}},detail).canReview,false);
  assert.equal(goalPresentation(page,{...detail,goal:{state:'ready_for_review',can_review:true,pending_id:'original-operation'}}).editable,false);
  assert.equal(goalPresentation(page,{...detail,goal:{state:'ready_for_review',can_review:true,page_id:'foreign'}}).canReview,false);
  assert.equal(goalPresentation(page,{...detail,goal:{state:'paused',can_review:true,identity_valid:false}}).editable,false);
});

test('manual goal packages aggregate review and next-package decisions into one idle composer action',()=>{
  const idle={page_id:page.id,goal:{configured:true,mode:'manual',state:'paused',can_review:true,can_start_next:false,request_id:'original'}};
  assert.equal(composer(page,idle).kind,'goal');assert.equal(composer(page,idle).label,'验收本轮');assert.equal(composer(page,idle).disabled,false);
  assert.equal(composer(page,idle,{draft:'追加的新要求'}).kind,'send');
  const ready={...idle,goal:{...idle.goal,can_start_next:true,review:{request_id:'original',decision:'continue'}}};
  assert.equal(composer({...page,paused:true},ready).label,'开始下一包');assert.equal(composer({...page,paused:true},ready).resume,false);
  assert.equal(needsWorkflowAction({...page,paused:true},ready,{key:'paused'},{}),false);
  assert.equal(goalPresentation(page,ready).title,'验收已保存 · 等待你开始下一包');
  assert.equal(composer(page,{...idle,request:{id:'in-flight',phase:'processing'}},{draft:'补充'}).kind,'append');
  assert.equal(composer(page,{...idle,goal:{configured:false,state:'not_set'}},{draft:'未配置目标的正常工作'}).kind,'send');
  assert.equal(composer(page,{...idle,state_read:{unavailable:true}}).disabled,true);
  assert.equal(composer(page,idle,{connected:false}).disabled,true);
});


test('automatic Goal labels separate saved state from future-dispatch pause without changing it',()=>{
  const p={...page,paused:true},v={page_id:p.id,goal:{configured:true,mode:'automatic',state:'active'}};
  assert.equal(goalPresentation(p,v).title,'目标已暂停');
  assert.equal(goalPresentation(p,v).state,'active');
  assert.equal(goalPresentation(p,{...v,request:{id:'running',phase:'processing'}}).title,'本轮待收尾 · 后续发送已暂停');
  assert.equal(goalPresentation(p,{...v,request:{id:'waiting',phase:'suspended'}}).title,'等待结果 · 后续发送已暂停');
  assert.equal(goalPresentation(p,{...v,goal:{...v.goal,state:'delivered'}}).title,'已交付');
  assert.equal(goalPresentation(p,{...v,goal:{...v.goal,state:'waiting'}}).title,'等待结果');
  assert.equal(v.goal.state,'active');
});


test('goal strip controls remain local and distinguish pause, stop and saved history',()=>{
  const p={...page,paused:false},v={page_id:p.id,goal:{configured:true,mode:'automatic',state:'active',etag:'etag-original',request_id:'r'}};
  let c=goalControls(p,v);assert.equal(c.toggleAction,'pause');assert.equal(c.toggleEnabled,true);assert.equal(c.stopEnabled,true);
  p.paused=true;c=goalControls(p,v);assert.equal(c.title,'目标已暂停');assert.equal(c.toggleAction,'resume');assert.equal(c.stopEnabled,true);
  assert.equal(goalControls(p,{...v,goal:{...v.goal,pending_id:'unknown-original'}}).stopEnabled,true,'Stopping future pursuit never requires replaying an unknown pending send');
  assert.equal(goalControls(p,{...v,goal:{...v.goal,state:'stopped'}}).visible,false);
  assert.equal(goalPresentation(p,{...v,goal:{...v.goal,state:'stopped'}}).title,'目标已关闭');
  for(const patch of [{page_id:'foreign'},{state_read:{unavailable:true}},{goal:{...v.goal,identity_valid:false}}])
    assert.equal(goalControls(p,{...v,...patch}).stopEnabled,false);
  assert.equal(goalControls({...p,parent:'owner'},v).visible,false);
  assert.equal(goalControls(p,v,{connected:false}).stopEnabled,false);
  assert.equal(goalControls({...p,maintenance:{state:'holding'}},v).toggleEnabled,false);
  assert.equal(goalControls({...p,maintenance:{state:'holding'}},v).stopEnabled,true);
});

test('closing and resetting the original Goal use its stable owner while continuation requires its current request',()=>{
  const p={...page,paused:true},goal={configured:true,mode:'automatic',state:'stopped',etag:'original-etag',request_id:'old-request',
    owner_identity_valid:true,request_matches:false,identity_valid:false},v={page_id:p.id,goal};
  const closed=goalPresentation(p,v);
  assert.equal(closed.state,'stopped');assert.equal(closed.goal,goal);assert.equal(closed.editable,true);
  assert.equal(goalPresentation(p,{...v,goal:{...goal,pending_id:'original-unknown'}}).editable,false);
  const active={...v,goal:{...goal,state:'active',can_review:true,can_start_next:true}};
  assert.equal(goalControls(p,active).stopEnabled,true);
  assert.equal(goalControls(p,active).toggleEnabled,false);
  assert.equal(goalPresentation(p,active).editable,false);
  const manual={...active,goal:{...active.goal,mode:'manual'}};
  assert.equal(goalPresentation(p,manual).canReview,false);assert.equal(goalPresentation(p,manual).canStartNext,false);
  const foreign={...v,goal:{...goal,owner_identity_valid:false}};
  assert.equal(goalPresentation(p,foreign).goal,null);assert.equal(goalPresentation(p,foreign).editable,false);
  assert.equal(goalControls(p,foreign).stopEnabled,false);
});

test('a trusted current empty Goal remains available to configure without borrowing a foreign owner',()=>{
  const v={page_id:page.id,goal:{configured:false,state:'not_set',owner_identity_valid:false,request_matches:false,identity_valid:false}};
  assert.equal(goalPresentation(page,v).state,'unset');assert.equal(goalPresentation(page,v).editable,true);
  assert.equal(goalPresentation(page,{...v,page_id:'foreign'}).editable,false);
  assert.equal(goalPresentation(page,{...v,state_read:{unavailable:true}}).editable,false);
  assert.equal(goalControls(page,v).visible,false);
});
