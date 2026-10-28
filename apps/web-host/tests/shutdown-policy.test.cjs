'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {exitRecord,pausesOnStartup,maintenanceIdle}=require('../shutdown-policy.cjs');
test('maintenance startup preserves intent; user and uncertain exits keep pause',()=>{
  assert.equal(pausesOnStartup(exitRecord({maintenance:true,pid:10})),false);
  for(const v of [exitRecord({pid:10}),{explicit:false},null,'bad'])assert.equal(pausesOnStartup(v),true);
});
test('maintenance requires fresh idle pages and no running native turn',()=>{
  const page={observation:{at:100,generating:false,draft:false,composing:false}};
  assert.equal(maintenanceIdle({pages:[page],nativeTurns:[{status:'completed'}],now:101}),true);
  for(const observation of [{at:0,generating:true},{at:0,generating:false,draft:true},{at:0,generating:false,composing:true},{at:0,generating:false}])
    assert.equal(maintenanceIdle({pages:[{observation}],now:40000}),false);
  assert.equal(maintenanceIdle({pages:[page],nativeTurns:[{status:'running'}],now:101}),false);
});
