'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {verifyWithRecovery,retryable}=require('../connector-verification.cjs');
test('known local UI timeout retries the same verification with bounded backoff',async()=>{
 let calls=0;const delays=[],events=[];
 const value=await verifyWithRecovery(async()=>{if(++calls<3)throw Error('locator.press: Timeout 5000ms exceeded.');return 'same-connector';},{delay:async ms=>delays.push(ms),onRetry:e=>events.push(e)});
 assert.equal(value,'same-connector');assert.equal(calls,3);assert.deepEqual(delays,[1500,4000]);assert.deepEqual(events.map(e=>e.attempt),[2,3]);
});
test('repeated UI failure exhausts three tries while access and identity failures stop',async()=>{
 let calls=0;await assert.rejects(verifyWithRecovery(async()=>{calls++;throw Error('bridge_connector_surface_not_ready');},{delay:async()=>{}}));assert.equal(calls,3);
 for(const message of ['account_access_cooldown','bridge_login_required','ChatGPT connector menu opened but exposed no row named Local-MCP','duplicate connector selections','permission denied','Unknown failure']){
  calls=0;await assert.rejects(verifyWithRecovery(async()=>{calls++;throw Error(message);},{delay:async()=>{}}));assert.equal(calls,1);assert.equal(retryable(Error(message)),false);
 }
});
test('shutdown during backoff fences the next verification',async()=>{
 let closed=false,calls=0;
 await assert.rejects(verifyWithRecovery(async()=>{calls++;throw Error('locator.press: Timeout 5000ms exceeded.');},{stopped:()=>closed,delay:async()=>{closed=true;}}),/bridge_not_available/);
 assert.equal(calls,1);
});
