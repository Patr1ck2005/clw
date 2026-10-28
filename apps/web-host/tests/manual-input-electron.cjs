'use strict';
// Private, hidden Chromium regression. No account, remote site or OS input.
const {app,BrowserWindow,WebContentsView,session}=require('electron');
const {BrowserPool}=require('../browser-pool.cjs');
const input=require('../page-input.cjs');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const dest=path.resolve(process.argv[2]);
app.setPath('userData',path.join(dest,'profile'));
app.whenReady().then(async()=>{
  const partition='manual-input-isolated',ses=session.fromPartition(partition);
  ses.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('data:')}));
  const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,nodeIntegration:false}});
  const pool=new BrowserPool({window:win,WebContentsView,partition,allowedUrl:url=>url.startsWith('data:')});
  const page=await pool.create('fixture','data:text/html,'+encodeURIComponent('<div contenteditable id="prompt-textarea">fixture</div>'));
  await page.navigation;await page.viewportReady;
  const wc=page.view.webContents,native=[];
  wc.on('before-input-event',(_event,event)=>native.push({type:event.type,key:event.key}));
  await input.evaluate(wc,'document.querySelector("[contenteditable]").focus()');
  await input.key(wc,'ArrowLeft');await input.key(wc,'Escape');await input.insert(wc,'programmatic');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(page.manualInteractionSequence,0,'programmatic keys must not take manual control, including delayed native events');
  assert.equal(page.manualControl,undefined);
  assert.equal(wc[Symbol.for('clw.programmatic-input')]?.length,0);
  wc.sendInputEvent({type:'keyDown',keyCode:'X'});wc.sendInputEvent({type:'keyUp',keyCode:'X'});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(page.manualControl,true,'native input must take control');
  assert.ok(page.manualInteractionSequence>0);
  const keyboardSequence=page.manualInteractionSequence;
  wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:10,y:10});
  wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:10,y:10});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.ok(page.manualInteractionSequence>keyboardSequence,'native pointer must also take control');
  assert.equal(win.isVisible(),false);assert.equal(win.isFocused(),false);
  const result={passed:true,nativeEvents:native,manualSequence:page.manualInteractionSequence,
    syntheticKeysKeptAutomatic:true,nativeKeyTookControl:true,nativePointerTookControl:true,
    visible:false,focused:false,remoteRequests:0,realAccount:false,modelSends:0};
  fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'result.json'),JSON.stringify(result,null,2));
  pool.close(page.id);win.destroy();console.log(JSON.stringify(result));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
