'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const input=require('../page-input.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const manualSequence=Symbol.for('clw.manual-input-sequence'),synthetic=Symbol.for('clw.programmatic-input');
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
function fixture(){
  const calls=[],hooks={},wc=new EventEmitter();
  Object.assign(wc,{isDestroyed:()=>false,getURL:()=>'https://chatgpt.com/c/original',setWindowOpenHandler(){},
    debugger:{isAttached:()=>true,sendCommand:async(method,params)=>{
      calls.push([method,params]);await hooks[method]?.(params);
      if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'original-main'}}};
      if(method==='Page.createIsolatedWorld')return {executionContextId:42};
      if(method==='Runtime.evaluate')return {result:{value:'observed'}};
      return {};
    }}});
  const pool=new BrowserPool({allowedUrl:()=>true}),page={id:'original',url:wc.getURL(),documentGeneration:1,manualInteractionSequence:0,view:{webContents:wc}};
  pool.pages.set(page.id,page);pool.bindView(page,page.view,'persist:fixture');
  const native=key=>wc.emit('before-input-event',{}, {type:'keyDown',key,code:key.length===1?'Key'+key.toUpperCase():key});
  return {wc,pool,page,calls,hooks,native};
}
function currentGuard(wc){const sequence=wc[manualSequence]||0;return ()=>{if((wc[manualSequence]||0)!==sequence)throw Object.assign(Error('manual owner changed'),{code:'manual_control'});};}

for(const stage of ['Page.getFrameTree','Page.createIsolatedWorld'])test('manual input while '+stage+' awaits prevents the automatic Runtime.evaluate write',async()=>{
  const f=fixture(),gate=deferred(),entered=deferred();f.hooks[stage]=async()=>{entered.resolve();await gate.promise;};
  const evaluating=input.evaluate(f.wc,'performAutomaticClick()',{assertCurrent:currentGuard(f.wc)});
  await entered.promise;f.native('a');gate.resolve();
  await assert.rejects(evaluating,error=>error.code==='manual_control');
  assert.equal(f.page.manualControl,true);assert.equal(f.wc[manualSequence],1);
  assert.equal(f.calls.some(x=>x[0]==='Runtime.evaluate'),false);
  if(stage==='Page.getFrameTree')assert.equal(f.calls.some(x=>x[0]==='Page.createIsolatedWorld'),false);
});

test('an already invalid operation does not attach or send any CDP command',async()=>{
  const f=fixture(),check=currentGuard(f.wc);f.native('b');
  await assert.rejects(input.evaluate(f.wc,'performAutomaticClick()',{assertCurrent:check}),error=>error.code==='manual_control');
  assert.deepEqual(f.calls,[]);
});

test('default read evaluation stays available without imposing a manual-control write guard',async()=>{
  const f=fixture(),gate=deferred(),entered=deferred();f.hooks['Page.createIsolatedWorld']=async()=>{entered.resolve();await gate.promise;};
  const reading=input.evaluate(f.wc,'readOnlyPublicState()');await entered.promise;f.native('c');gate.resolve();
  assert.equal(await reading,'observed');assert.deepEqual(f.calls.map(x=>x[0]),['Page.getFrameTree','Page.createIsolatedWorld','Runtime.evaluate']);
  assert.equal(f.calls[2][1].contextId,42);assert.equal(f.calls[2][1].expression,'readOnlyPublicState()');
});

test('one pending synthetic key only matches itself while unrelated real input still acquires control',async()=>{
  const f=fixture(),gate=deferred(),entered=deferred();
  f.hooks['Input.dispatchKeyEvent']=async params=>{if(params.type==='rawKeyDown'){
    assert.deepEqual(f.wc[synthetic],[{type:'keyDown',key:'Escape',code:'Escape'}]);entered.resolve();await gate.promise;
  }};
  const pressing=input.key(f.wc,'Escape');await entered.promise;
  f.native('a');assert.equal(f.page.manualInteractionSequence,1);assert.equal(f.wc[synthetic].length,1);
  f.native('Escape');assert.equal(f.page.manualInteractionSequence,1);assert.equal(f.wc[synthetic].length,0);
  f.native('Escape');assert.equal(f.page.manualInteractionSequence,2,'consumed synthetic identity cannot hide a second real key');
  gate.resolve();await pressing;assert.equal(f.wc[synthetic].length,0);
  assert.deepEqual(f.calls.map(x=>[x[0],x[1].type]),[['Emulation.setFocusEmulationEnabled',undefined],['Input.dispatchKeyEvent','rawKeyDown'],['Input.dispatchKeyEvent','keyUp']]);
});

test('successful key dispatch clears its unconsumed expectation before a subsequent native key',async()=>{
  const f=fixture();let checked=false;
  f.hooks['Input.dispatchKeyEvent']=async params=>{
    if(params.type==='rawKeyDown'){assert.equal(f.wc[synthetic].length,1);checked=true;}
    else assert.equal(f.wc[synthetic].length,0,'keyup has no broad synthetic-input exemption');
  };
  await input.key(f.wc,'ArrowLeft');assert.equal(checked,true);assert.equal(f.wc[synthetic].length,0);
  f.native('ArrowLeft');assert.equal(f.page.manualInteractionSequence,1);
});

test('failed key dispatch removes its exact expectation and preserves the original failure',async()=>{
  const f=fixture(),failure=Error('original CDP failure');
  f.hooks['Input.dispatchKeyEvent']=async params=>{if(params.type==='rawKeyDown'){assert.equal(f.wc[synthetic].length,1);throw failure;}};
  await assert.rejects(input.key(f.wc,'ArrowRight'),error=>error===failure);
  assert.equal(f.wc[synthetic].length,0);assert.equal(f.calls.filter(x=>x[1].type==='keyUp').length,0);
  f.native('ArrowRight');assert.equal(f.page.manualInteractionSequence,1);
});

test('text insertion does not blanket-mask a native key while its CDP request waits',async()=>{
  const f=fixture(),gate=deferred(),entered=deferred();f.hooks['Input.insertText']=async()=>{entered.resolve();await gate.promise;};
  const inserting=input.insert(f.wc,'programmatic body');await entered.promise;
  assert.equal(f.wc[synthetic]?.length||0,0);f.native('d');assert.equal(f.page.manualInteractionSequence,1);
  gate.resolve();await inserting;
});

for(const operation of ['key','insert'])test('manual input during focus preparation prevents late '+operation,async()=>{
  const f=fixture(),gate=deferred(),entered=deferred();
  f.hooks['Emulation.setFocusEmulationEnabled']=async()=>{entered.resolve();await gate.promise;};
  const writing=operation==='key'?input.key(f.wc,'Escape'):input.insert(f.wc,'automatic body');
  await entered.promise;f.native('x');gate.resolve();
  await assert.rejects(writing,error=>error.code==='manual_control');
  assert.deepEqual(f.calls.map(x=>x[0]),['Emulation.setFocusEmulationEnabled']);
});
