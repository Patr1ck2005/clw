'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mayObserve}=require('../observer-schedule.cjs');
test('paused idle history is sampled slowly, selection and resume trigger a fresh read',()=>{
 const cache=new Map(),r={page_id:'p',paused:true,pause_origin:{source:'operator'}},p={documentGeneration:1,observation:{generating:false}};
 assert.equal(mayObserve(r,p,cache,{now:0}),true);assert.equal(mayObserve(r,p,cache,{now:1500}),false);
 assert.equal(mayObserve(r,p,cache,{now:1500,selected:true}),true);
 assert.equal(mayObserve({...r,paused:false},p,cache,{now:1501}),true);
});
test('accepted generation is still sampled fast while paused and new request or navigation forces read',()=>{
 const cache=new Map(),r={page_id:'p',paused:true,latest_request:{id:'one',phase:'processing'}},p={documentGeneration:1,observation:{generating:true}};
 assert.equal(mayObserve(r,p,cache,{now:0}),true);assert.equal(mayObserve(r,p,cache,{now:1500}),true);
 assert.equal(mayObserve({...r,latest_request:{id:'two',phase:'processing'}},p,cache,{now:1501}),true);
 assert.equal(mayObserve(r,{...p,documentGeneration:2},cache,{now:1502}),true);
});
test('recoverable attention stays fresh and terminal changes are observed immediately',()=>{
 const cache=new Map(),r={page_id:'p',paused:true,attention:'saved ending',pause_origin:{source:'attention'},latest_request:{id:'one',phase:'processing'}},p={observation:{generating:false}};
 assert.equal(mayObserve(r,p,cache,{now:0}),true);assert.equal(mayObserve(r,p,cache,{now:3000}),true);
 assert.equal(mayObserve({...r,latest_request:{id:'one',phase:'blocked'}},p,cache,{now:3001}),true);
});
