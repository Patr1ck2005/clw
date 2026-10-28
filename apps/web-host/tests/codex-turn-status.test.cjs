'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {turnView}=require('../codex-turns.js');
const source={traceId:'123456abcdef',threadId:'saved-thread',turnId:'saved-turn',workingDirectory:'D:/fixture',model:'chatgpt-web/high'};
const row={traceId:source.traceId,source,status:'failed',submission:'unconfirmed',nativeState:{state:'unavailable'}};

test('web observation failure never claims the original native execution stopped',()=>{
  for(const evidence of [
    {observationUnavailable:true},
    ...['page_snapshot_timeout','observation_timeout','page_observation_timeout'].map(kind=>({failure:{kind}})),
  ]){
    const view=turnView({...row,...evidence});
    assert.match(view.status,/网页状态读取异常.*原执行待核对/);
    assert.equal(view.failureType,'web_observation');assert.equal(view.needsAttention,true);
    assert.match(view.note,/原 Codex/);assert.match(view.note,/不表示原生执行已停止/);
    assert.doesNotMatch(view.note,/本轮执行已停止|原生 Codex.*失败退出/);
    assert.equal(view.sent,'送达待核对');assert.equal(view.canResume,false);
  }
});
test('a failed browser turn with no native failure remains a browser error, including a positive native completion',()=>{
  const unknown=turnView(row);assert.equal(unknown.failureType,'web_turn');
  assert.match(unknown.status,/网页回合异常/);assert.match(unknown.note,/核对执行状态/);
  assert.doesNotMatch(unknown.note,/执行已停止|工具授权已结束/);
  const completed=turnView({...row,submission:'confirmed',observationUnavailable:true,nativeState:{state:'completed'}});
  assert.match(completed.status,/本轮执行已完成.*网页异常/);
  assert.equal(completed.sent,'已确认送达');assert.equal(completed.needsAttention,true);
});
test('actual native failure and abort take precedence over web errors and assistant-reported blockers',()=>{
  const reported={reportedBlockers:[{note:'最终回复中的早期工具错误'}]};
  const failed=turnView({...row,status:'completed',observationUnavailable:true,review:reported,nativeState:{state:'failed',reason:'compaction_failed'}});
  assert.equal(failed.failureType,'native_execution');assert.match(failed.status,/执行失败/);
  assert.match(failed.note,/压缩失败退出/);assert.equal(failed.step,null);
  const aborted=turnView({...row,status:'completed',review:reported,nativeState:{state:'aborted'}});
  assert.equal(aborted.failureType,'native_stopped');assert.match(aborted.status,/原生本轮已停止/);
  assert.match(aborted.note,/原生 Codex 本轮已停止/);assert.equal(aborted.step,null);
  const browserOnly=turnView({...row,status:'aborted'});
  assert.match(browserOnly.status,/网页回合已停止.*原执行待核对/);
  assert.doesNotMatch(browserOnly.note,/原生 Codex 本轮已停止/);
});
test('only explicit pre-send navigation evidence can display not sent; unknown and confirmed sends retain original delivery',()=>{
  const failure={kind:'page_navigation_timeout',beforeSend:true,submissionObserved:false};
  const before=turnView({...row,submission:'not-observed',failure});
  assert.equal(before.failureType,'before_send');assert.equal(before.sent,'尚未发送');
  assert.match(before.note,/没有自动重发/);
  for(const submission of ['unconfirmed','confirmed']){
    const contradictory=turnView({...row,submission,failure});
    assert.equal(contradictory.failureType,'web_navigation');
    assert.equal(contradictory.sent,submission==='confirmed'?'已确认送达':'送达待核对');
    assert.doesNotMatch(contradictory.note,/尚未发送/);assert.match(contradictory.note,/不会重复发送/);
  }
  assert.equal(turnView({...row,submission:'not-observed',failure:{...failure,submissionObserved:true}}).sent,'未观察到送达');
});
test('saved turn completion describes a round, without revoking old authorization or claiming the entire goal delivered',()=>{
  const completed=turnView({...row,status:'completed',submission:'confirmed',nativeState:{state:'completed'}});
  assert.match(completed.status,/本轮完成/);assert.match(completed.note,/整体目标是否完成以成果和未完成项为准/);
  assert.match(completed.note,/按原执行记录核对/);assert.doesNotMatch(completed.note,/工具授权已结束|目标已完成|全部交付/);
  assert.equal(completed.canResume,true);
  const unknown=turnView({...row,status:'needs_reconciliation'});
  assert.match(unknown.note,/原执行状态未知/);assert.equal(unknown.canResume,false);
});
test('historical resume affordance never substitutes a foreign or missing saved task identity',()=>{
  const completed={...row,status:'completed',nativeState:{state:'completed'}};
  const missing=turnView({...completed,source:null});
  assert.equal(missing.known,false);assert.equal(missing.canResume,false);assert.match(missing.note,/核对原任务/);
  const foreign=turnView({...completed,source:{...source,traceId:'aaaaaaaaaaaa'}});
  assert.equal(foreign.known,false);assert.equal(foreign.canResume,false);
  for(const nativeState of [{state:'completed',threadId:'foreign-thread'},{state:'completed',turnId:'foreign-turn'}])
    assert.equal(turnView({...completed,nativeState}).canResume,false);
});
