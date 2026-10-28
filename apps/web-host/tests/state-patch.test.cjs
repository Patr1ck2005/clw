'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {apply}=require('../state-patch.js');
test('a full snapshot starts a versioned baseline and retains backward compatibility',()=>{
  const old={pages:[{id:'legacy'}]};assert.equal(apply({},old).state,old);
  const fresh={stateRevision:5,pages:[],view:null};assert.equal(apply({},fresh).state,fresh);assert.equal(apply({},fresh).snapshot,true);
});
test('incremental page observations preserve the selected transcript object and immutable previous state',()=>{
  const view={page_id:'camp',events:[{seq:1,data:{text:'saved transcript'}}]},old={stateRevision:5,view,pages:[{id:'camp'}]};
  const update=apply(old,{statePatch:true,baseRevision:5,stateRevision:6,pages:[{id:'camp',paused:true}]});
  assert.equal(update.state.view,view);assert.equal(update.state.pages[0].paused,true);assert.equal(old.pages[0].paused,undefined);
  assert.equal(update.state.statePatch,false);assert.equal('baseRevision' in update.state,false);
});
test('explicit null and empty lists clear a field instead of inheriting a stale task detail',()=>{
  const old={stateRevision:5,selected:'camp',view:{page_id:'camp'},closed:[{id:'old'}]};
  const update=apply(old,{statePatch:true,baseRevision:5,stateRevision:6,selected:'spire',view:null,closed:[]});
  assert.equal(update.state.view,null);assert.deepEqual(update.state.closed,[]);assert.equal(update.state.selected,'spire');
});
test('missing baseline, skipped revision and out-of-order future patches request a full snapshot',()=>{
  const patch={statePatch:true,baseRevision:5,stateRevision:6,pages:[]};
  assert.equal(apply({},patch).needsSnapshot,true);
  assert.equal(apply({stateRevision:4},patch).needsSnapshot,true);
  assert.equal(apply({stateRevision:5},{...patch,stateRevision:8}).needsSnapshot,true);
});
test('duplicates and delayed old patches cannot roll back task selection or state',()=>{
  const old={stateRevision:6,selected:'spire'};
  for(const revision of [5,6])assert.equal(apply(old,{statePatch:true,baseRevision:4,stateRevision:revision,selected:'camp'}).ignored,true);
});
test('invalid input is rejected without discarding the last usable workspace',()=>{
  for(const value of [null,undefined,[],{statePatch:true,baseRevision:0,stateRevision:NaN}])assert.equal(apply({stateRevision:0},value).needsSnapshot,true);
});
