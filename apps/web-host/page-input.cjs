'use strict';
// Chromium's in-process input channel works for an owned, unfocused renderer.
// No listening debugging port, OS mouse/keyboard input, or account APIs.
async function command(wc,method,params){
  if(!wc.debugger.isAttached())wc.debugger.attach('1.3');
  // Match only this synthetic key. A real key pressed while CDP awaits must
  // still take control; a blanket "automation running" flag would swallow it.
  const symbol=Symbol.for('clw.programmatic-input');
  const expected=method==='Input.dispatchKeyEvent'&&params.type==='rawKeyDown'
    ?{type:'keyDown',key:params.key,code:params.code}:null;
  if(expected)(wc[symbol]??=[]).push(expected);
  try{return await wc.debugger.sendCommand(method,params);}
  finally{if(expected){const queue=wc[symbol],index=queue?.indexOf(expected);if(index>=0)queue.splice(index,1);}}
}
async function key(wc,key){
  const sequence=wc[Symbol.for('clw.manual-input-sequence')]||0;
  const codes={Escape:27,ArrowLeft:37,ArrowRight:39};
  if(!codes[key])throw Error('unsupported_page_key');
  // A newly created/background renderer has no native focus. Chromium can
  // otherwise discard keyboard input even after its public element.focus().
  // Emulate focus only inside this owned renderer; never focus the OS window.
  await command(wc,'Emulation.setFocusEmulationEnabled',{enabled:true});
  if((wc[Symbol.for('clw.manual-input-sequence')]||0)!==sequence)throw Object.assign(Error('原网页正在被手动操作，自动按键已让位。'),{code:'manual_control'});
  await command(wc,'Input.dispatchKeyEvent',{type:'rawKeyDown',key,code:key,windowsVirtualKeyCode:codes[key]});
  await command(wc,'Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:codes[key]});
}
async function insert(wc,text){
  const sequence=wc[Symbol.for('clw.manual-input-sequence')]||0;
  await command(wc,'Emulation.setFocusEmulationEnabled',{enabled:true});
  if((wc[Symbol.for('clw.manual-input-sequence')]||0)!==sequence)throw Object.assign(Error('原网页正在被手动操作，自动输入已让位。'),{code:'manual_control'});
  await command(wc,'Input.insertText',{text});
}
async function evaluate(wc,expression,{assertCurrent=()=>{}}={}){
  // Electron's executeJavaScript waits for the full page load even when its
  // public DOM is ready. A stalled font/resource must not hold the task loop.
  assertCurrent();const {frameTree}=await command(wc,'Page.getFrameTree',{});assertCurrent();
  const {executionContextId}=await command(wc,'Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'clw-managed-dom'});
  assertCurrent();
  const response=await command(wc,'Runtime.evaluate',{expression,contextId:executionContextId,returnByValue:true,awaitPromise:true});
  if(response.exceptionDetails)throw Error((response.exceptionDetails.exception?.description||response.exceptionDetails.text||'page_dom_failed').split('\n')[0].replace(/^Error: /,''));
  return response.result.value;
}
async function viewport(wc,width,height){
  await command(wc,'Emulation.setDeviceMetricsOverride',{width:Math.max(1,Math.round(width)),height:Math.max(1,Math.round(height)),deviceScaleFactor:0,mobile:false});
}
function domClick(e){
  // Uses an element selected from the public page, like upstream's locator
  // pointerdown fallback. This also works before a hidden view has a viewport.
  if(!e?.isConnected)throw Error('page_target_missing');
  const p={bubbles:true,cancelable:true,composed:true,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true};
  const down=e.dispatchEvent(new PointerEvent('pointerdown',p));
  if(down&&e.dispatchEvent(new MouseEvent('mousedown',p)))e.focus?.();
  e.dispatchEvent(new PointerEvent('pointerup',{...p,buttons:0}));
  e.dispatchEvent(new MouseEvent('mouseup',{...p,buttons:0}));
  e.dispatchEvent(new MouseEvent('click',{...p,buttons:0,detail:1}));
}
module.exports={key,insert,evaluate,domClick,viewport};
