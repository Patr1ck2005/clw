'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {nativeMaintenanceTurns}=require('../native-turn-reads.cjs');
const source={traceId:'123456abcdef',threadId:'01a0dc7b-2a50-7140-a55b-eed50ff96b02',
  turnId:'01a0dc7b-2a50-7140-a55b-eed50ff96b03',model:'chatgpt-web/high',account:'A',workingDirectory:__dirname};
const ended={traceId:source.traceId,status:'completed',browserStatus:'completed',source,
  nativeState:{state:'completed',threadId:source.threadId,turnId:source.turnId,endedAt:'2026-10-04T10:00:00.000Z',
    source:'native_session_canonical',threadActive:false,activeTurnId:null,
    nativeProof:{version:1,kind:'canonical_full_session',threadId:source.threadId,turnId:source.turnId,
      terminal:'task_complete_with_matching_final',sessionSha256:'a'.repeat(64),eventSha256:'b'.repeat(64)}}};
test('maintenance uses the explicit canonical read and never consults a cached idle display',()=>{
  let reads=0;const row=ended;
  assert.deepEqual(nativeMaintenanceTurns({turns:()=>{reads++;return [row];},snapshot:()=>assert.fail('display is not an idle grant')}),[row]);
  assert.equal(reads,1);assert.deepEqual(nativeMaintenanceTurns(null),[]);
});

test('maintenance accepts a canonical failed turn that retains its prior final hash without accepting the task',()=>{
  const row={...ended,status:'failed',browserStatus:'failed',nativeState:{...ended.nativeState,state:'failed',
    taskAcceptance:'unverified',claimReleaseAuthorized:false,
    nativeProof:{...ended.nativeState.nativeProof,terminal:'task_complete_with_error',finalSha256:'c'.repeat(64)}}};
  assert.deepEqual(nativeMaintenanceTurns({turns:()=>[row]}),[row]);
  assert.equal(row.nativeState.state,'failed');assert.equal(row.nativeState.claimReleaseAuthorized,false);
});
test('missing, failed, invalid and unknown canonical reads cannot authorize maintenance',()=>{
  for(const bridge of [{snapshot:()=>({recent:[]})},{turns:()=>{throw Error('EPERM');}},
    {turns:()=>null},{turns:()=>Promise.resolve([])},{turns:()=>[null]},{turns:()=>[{}]},
    {turns:()=>[{status:'needs_reconciliation'}]},{turns:()=>[{status:'unknown'}]},
    {turns:()=>[{status:'completed'}]},
    {turns:()=>[{status:'failed',nativeState:{state:'failed'}}]},
    {turns:()=>[{status:'failed',browserStatus:'running'}]},
    {turns:()=>[{status:'completed',browserStatus:'preparing'}]}])
    assert.throws(()=>nativeMaintenanceTurns(bridge),/maintenance_exit_requires_original_receipt/);
});

test('an ended webpage cannot certify running, unavailable or foreign native work as idle',()=>{
  for(const row of [{...ended,nativeState:{...ended.nativeState,state:'running'}},
    {...ended,nativeState:{state:'unavailable'}},{...ended,nativeState:null},
    {...ended,nativeState:{...ended.nativeState,turnId:source.threadId}},
    {...ended,nativeState:{...ended.nativeState,source:'native_session_terminal'}},
    {...ended,nativeState:{...ended.nativeState,nativeProof:null}},
    {...ended,nativeState:{...ended.nativeState,nativeProof:{...ended.nativeState.nativeProof,sessionSha256:'bad'}}},
    {...ended,nativeState:{...ended.nativeState,threadActive:true,activeTurnId:source.turnId}},
    {...ended,source:{...source,traceId:'abcdef123456'}},
    {...ended,source:{...source,workingDirectory:undefined}},
    {...ended,source:null}])
    assert.throws(()=>nativeMaintenanceTurns({turns:()=>[row]}),/maintenance_exit_requires_original_receipt/);
});

test('unmapped historical records require real pre-Send failure evidence, never an absent source alone',()=>{
  const beforeSend={traceId:source.traceId,status:'failed',browserStatus:'failed',source:null,
    submission:'not-observed',failure:{kind:'page_navigation_timeout',beforeSend:true,submissionObserved:false}};
  assert.deepEqual(nativeMaintenanceTurns({turns:()=>[beforeSend]}),[beforeSend]);
  for(const row of [{...beforeSend,failure:null},{...beforeSend,submission:'unconfirmed'},
    {...beforeSend,submission:'confirmed'},
    {...beforeSend,failure:{...beforeSend.failure,beforeSend:false}},
    {...beforeSend,failure:{...beforeSend.failure,submissionObserved:true}},
    {...beforeSend,status:'completed',browserStatus:'completed'}])
    assert.throws(()=>nativeMaintenanceTurns({turns:()=>[row]}),/maintenance_exit_requires_original_receipt/);
});
