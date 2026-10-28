'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requiresRenderer,loaded}=require('../page-residency.cjs');
const row={phase:'bound',paused:true,latest_request:{phase:'completed'}};
test('history remains a record without loading a renderer, including paused unsent work',()=>{
  assert.equal(requiresRenderer(row),false);
  assert.equal(requiresRenderer({...row,latest_request:{phase:'queued'}}),false);
  assert.equal(requiresRenderer({phase:'reserved',paused:true,bootstrap_state:'pending'}),false);
  assert.equal(requiresRenderer(null),false);
});
test('accepted results and uncertain sends remain loaded under pause and cancellation',()=>{
  for(const phase of ['processing','suspended'])assert.equal(requiresRenderer({...row,latest_request:{phase,cancel_requested:true}}),true);
  for(const bootstrap_state of ['sending','sent','unknown'])assert.equal(requiresRenderer({phase:'reserved',paused:true,bootstrap_state}),true);
  assert.equal(requiresRenderer({...row,latest_request:{phase:'queued',attempt_id:'original'}}),true);
  assert.equal(requiresRenderer({...row,latest_request:{phase:'queued',sent_user_hash:'original'}}),true);
});
test('resume starts the original pending page and protected local operations prevent release',()=>{
  assert.equal(requiresRenderer({...row,paused:false,latest_request:{phase:'queued'}}),true);
  assert.equal(requiresRenderer({phase:'reserved',paused:false,bootstrap_state:'pending'}),true);
  for(const flag of ['viewing','pending','resultPending','approvalBusy','safetyPin'])assert.equal(requiresRenderer(row,{[flag]:true}),true);
  assert.equal(requiresRenderer({...row,paused:false,work_model_pending:true}),true);
});
test('descriptor existence does not imply a resident renderer',()=>{
  assert.equal(loaded({id:'saved',view:null}),false);
  assert.equal(loaded({view:{webContents:{isDestroyed:()=>true}}}),false);
  assert.equal(loaded({view:{webContents:{isDestroyed:()=>false}}}),true);
});
