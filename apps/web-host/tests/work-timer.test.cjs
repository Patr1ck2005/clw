'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {timestamp,duration,web,codex,display,Clock}=require('../work-timer.js');
const start=1791356542811,created=start-100000;
const iso=at=>new Date(at).toISOString();
function context(extra={}){return {mode:'web',page:{id:'camp',thread_id:'original-thread',paused:false,
  latest_request:{id:'original-request'},observation:{historyAtLatest:true,generating:true}},
  view:{page_id:'camp',thread_id:'original-thread',latest_request:{id:'original-request',phase:'processing',created_at:iso(created),attempt_id:'control_original'},
    request:{id:'original-request',phase:'processing'},attempt:{id:'control_original',acknowledged:start/1000},events:[]},...extra};}
const finish=(kind='host_turn_yielded',at=start+3600000)=>({kind,at:iso(at),data:{request_id:'original-request',attempt_id:'control_original'}});
test('accepted-round duration excludes queue and goal elapsed explicitly includes it',()=>{
  const value=display(web(context()),start+3661000);
  assert.equal(value.round,'本轮用时 01:01:01');assert.equal(value.goal,'需求历时 01:02:41');assert.equal(value.state,'running');
  assert.match(value.goalNote,/不是.*累计工作时长/);assert.equal(timestamp(start/1000),start);
  assert.equal(duration(24*3600000+5000),'24:00:05');assert.equal(duration(-3),'00:00:00');
  for(const value of [null,undefined,'','broken',Infinity,0,-5])assert.equal(timestamp(value),null);
});
test('queue has a separate goal clock, and a future-dispatch pause does not stop confirmed work',()=>{
  const c=context();c.view.attempt.acknowledged=null;
  let value=display(web(c),start);assert.equal(value.round,'尚未确认送达');assert.equal(value.state,'queued');
  c.view.attempt.acknowledged=start/1000;c.page.paused=true;c.workflowKey='working_held';
  value=display(web(c),start+2000);assert.equal(value.round,'本轮用时 00:00:02');assert.equal(value.running,true);
  c.workflowKey='team_pausing';assert.equal(display(web(c),start+3000).round,'本轮用时 00:00:03');
});
test('only original request and attempt end events freeze the selected round',()=>{
  for(const kind of ['host_turn_yielded','host_turn_attention','control_browser_result_failed']){
    const c=context();c.view.events=[finish(kind)];const value=display(web(c),start+7200000);
    assert.equal(value.round,'本轮用时 01:00:00');assert.equal(value.state,'ended');
  }
  for(const wrong of [
    {...finish(),data:{request_id:'other-request',attempt_id:'control_original'}},
    {...finish(),data:{request_id:'original-request',attempt_id:'control_previous'}},
    finish('host_parent_resumed'),finish('host_turn_yielded',start-1),
  ]){const c=context();c.view.events=[wrong];assert.equal(display(web(c),start+7200000).state,'running');}
  const c=context();c.view.events=[{kind:'assistant_message',at:iso(start+4000),
    data:{request_id:'original-request',source:'bound_browser_public_reply',item_id:'clw-browser-reply-original'}}];
  assert.equal(display(web(c),start+9999).round,'本轮用时 00:00:04');
  c.view.events[0].data.source='unknown';assert.equal(display(web(c),start+9999).state,'running');
});
test('terminal timestamps survive history rotation and reload, but never apply to a new round',()=>{
  let saved=null,writes=0;const storage={getItem:()=>saved,setItem:(_,value)=>{writes++;saved=value;}};
  let now=start+7200000;const clock=new Clock({storage,now:()=>now,hidden:()=>true});
  const c=context();c.view.events=[finish()];clock.update(c);assert.equal(writes,1);
  clock.update(c);assert.equal(writes,1,'Unchanged host states do not rewrite local storage');
  c.view.events=[];clock.update(c);assert.equal(clock.snapshot().round,'本轮用时 01:00:00');
  const restored=new Clock({storage,now:()=>now,hidden:()=>true});restored.update(c);
  assert.equal(restored.snapshot().round,'本轮用时 01:00:00');
  c.view.attempt={id:'control_next',acknowledged:(start+7100000)/1000};c.view.latest_request.attempt_id='control_next';
  restored.update(c);assert.equal(restored.snapshot().round,'本轮用时 00:01:40');assert.equal(restored.snapshot().state,'running');
});
test('identity changes and conflicting ledgers never borrow elapsed time',()=>{
  for(const mutate of [c=>c.view.page_id='other',c=>c.view.thread_id='other',c=>c.view.request.id='other',c=>c.page.latest_request.id='other']){
    const c=context();mutate(c);assert.equal(web(c),null);
  }
  const c=context();c.view.latest_request.attempt_id='control_other';
  assert.equal(display(web(c),start+3000).state,'queued');assert.equal(display(web(c),start+3000).round,'尚未确认送达');
});
test('unknown end is labelled rather than running forever or using the pause click time',()=>{
  const c=context();c.page.observation.failure='explicit failure';c.page.observation.generating=false;
  c.page.observation.attemptId='control_original';c.page.observation.at=start+3000;
  assert.equal(display(web(c,undefined,start+3000),start+3000).round,'本轮用时 · 结束时间待确认');
  c.page.observation.historyAtLatest=false;
  assert.equal(display(web(c,undefined,start+3000),start+3000).round,'本轮用时 00:00:03','An old history view is not proof that the current round failed');
  c.view.latest_request.phase='failed';
  assert.equal(display(web(c),start+3000).goal,'需求历时 · 结束时间待确认');
  c.view.latest_request.finished_at=iso(start+123000);
  const value=display(web(c),start+7200000);assert.equal(value.round,'本轮用时 00:02:03');assert.equal(value.running,false);
});
test('Codex clocks use saved end evidence; an interrupted connection is not an end',()=>{
  const row={traceId:'original',source:{threadId:'native-thread'},startedAt:iso(start),status:'running'};
  assert.equal(display(codex({row}),start+7200000).round,'本轮用时 02:00:00');
  row.status='completed';row.endedAt=iso(start+3000);
  assert.equal(display(codex({row}),start+7200000).round,'本轮用时 00:00:03');
  delete row.endedAt;row.status='needs_reconciliation';row.interruptedAt=iso(start+2000);
  assert.equal(display(codex({row}),start+7200000).state,'end_pending');
  row.nativeState={state:'failed',endedAt:iso(start+5000)};
  assert.equal(display(codex({row}),start+7200000).round,'本轮用时 00:00:05');
  delete row.nativeState;row.status='completed';row.endedAt=iso(start-5000);
  assert.equal(display(codex({row}),start+7200000).state,'end_pending');
});
test('residual failure observations cannot mark a new confirmed round as ended',()=>{
  for(const patch of [{attemptId:'control_old',at:start+3000},{attemptId:'control_original',at:start-1},
    {attemptId:'control_original',at:start+3000,generating:true},{attemptId:'control_original',at:start+40000}]){
    const c=context();c.page.observation={historyAtLatest:true,generating:false,failure:'old failure',...patch};
    assert.equal(display(web(c,undefined,start+3000),start+3000).round,'本轮用时 00:00:03');
  }
});
test('clock ticks repaint only its callback, sleep when hidden, catch up on visibility, and never persist active time',()=>{
  let now=start,hidden=false,pending=null,paints=0,writes=0;
  const clock=new Clock({now:()=>now,hidden:()=>hidden,onChange:()=>paints++,storage:{getItem:()=>null,setItem:()=>writes++},
    setTimer:fn=>{pending=fn;return 1;},clearTimer:()=>{pending=null;}});
  clock.update(context());assert.equal(paints,1);assert.equal(typeof pending,'function');
  now+=5000;pending();assert.equal(clock.snapshot().round,'本轮用时 00:00:05');assert.equal(paints,2);assert.equal(writes,0);
  hidden=true;clock.visibility();assert.equal(pending,null);
  now+=3600000;hidden=false;clock.visibility();assert.equal(clock.snapshot().round,'本轮用时 01:00:05');
  clock.update(null);assert.equal(clock.snapshot().visible,false);assert.equal(pending,null);
  clock.dispose();assert.equal(pending,null);
});
