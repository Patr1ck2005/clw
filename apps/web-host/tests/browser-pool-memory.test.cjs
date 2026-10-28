'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {BrowserPool}=require('../browser-pool.cjs');

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(options={}){
  const views=[],attached=new Set(),admissions=[],protectedContents=[],events=[];
  let visible=true,minimized=false;
  class View{
    constructor(config){
      this.options=config;views.push(this);const wc=new EventEmitter();
      Object.assign(wc,{session:{partition:config.webPreferences.partition},destroyed:false,url:'about:blank',loads:[],closes:0,
        isDestroyed:()=>wc.destroyed,getURL:()=>wc.url,setWindowOpenHandler:fn=>{wc.popup=fn;},
        loadURL:url=>{wc.loads.push(url);wc.url=url;return options.load?options.load(wc,url):Promise.resolve();},
        close:args=>{wc.closes++;wc.closeOptions=args;wc.destroyed=true;wc.emit('did-navigate',{},'https://chatgpt.com/c/late-destroyed');},
        reload:()=>{wc.reloads=(wc.reloads||0)+1;},
        debugger:{isAttached:()=>true,sendCommand:async()=>({})}});
      this.webContents=wc;
    }
    setBounds(bounds){this.bounds=bounds;}
    setVisible(value){this.visible=value;}
  }
  const pool=new BrowserPool({
    window:{getContentSize:()=>[1440,960],isVisible:()=>visible,isMinimized:()=>minimized,isFocused:()=>true,
      contentView:{addChildView:view=>attached.add(view),removeChildView:view=>{attached.delete(view);options.remove?.(view);}}},
    WebContentsView:View,partitionForAccount:account=>'persist:account-'+account,
    allowedUrl:url=>/^https:\/\/(chatgpt\.com|auth\.openai\.com)\//.test(url),
    accountAccessFor:account=>({assertCanStart(){admissions.push(['check',account]);},async admitNavigation(){admissions.push(['admit',account]);await options.admit?.(account);}}),
    networkGuard:{ready:options.networkReady!==false,async protect(session){await options.protect?.(session);},protectContents:wc=>protectedContents.push(wc)},
    powerSaveBlocker:{start:()=>13,stop:id=>events.push(['power-stop',id])},openExternal:options.openExternal
  });
  pool.on('navigation',value=>events.push(['navigation',value]));pool.on('crashed',value=>events.push(['crashed',value]));
  pool.on('load-failed',value=>events.push(['load-failed',value]));
  const idle=async page=>{await page.navigation;page.view.webContents.emit('dom-ready');await page.viewportReady;page.observation={at:1000,generating:false,draft:false,composing:false,approvalRequired:false};return page;};
  return {pool,views,attached,admissions,protectedContents,events,idle,setVisible:value=>{visible=value;},setMinimized:value=>{minimized=value;}};
}

test('register and selecting history keep all durable rows without creating renderers or admitting accounts',()=>{
  const f=fixture();
  for(let n=0;n<28;n++)f.pool.register('saved-'+n,'https://chatgpt.com/c/'+n,{account:n%2?'A':'B',root:'D:/project-'+n,title:'History '+n});
  f.pool.select('saved-27');f.pool.native=true;f.pool.layout();
  assert.equal(f.pool.pages.size,28);assert.equal(f.pool.inspect().length,28);assert.equal(f.views.length,0);assert.equal(f.admissions.length,0);
  assert.deepEqual(f.pool.inspect().find(p=>p.id==='saved-27'),{id:'saved-27',title:'History 27',status:'unloaded',url:'https://chatgpt.com/c/27',root:'D:/project-27',account:'A',kind:'task',closed:false,selected:true,resident:false,rendererState:'unloaded',residentRequired:false,manualControl:false,manualInteractionSequence:0,manualUrl:null});
});

test('release and demand restore retain the same page, account, URL and ledger metadata',async()=>{
  const f=fixture(),page=await f.pool.create('original','https://chatgpt.com/c/original',{account:'A',root:'D:/original',requestId:'original-request',taskId:'original-task'});
  await f.idle(page);const original=page.view;page.view.webContents.url='https://chatgpt.com/c/original#latest';
  page.view.webContents.emit('did-navigate-in-page',{},page.view.webContents.url);
  assert.deepEqual(f.pool.suspend(page.id,{now:1000}),{suspended:true,released:true,reason:'idle'});
  assert.equal(original.webContents.closes,1);assert.equal(original.webContents.destroyed,true);assert.equal(f.attached.size,0);
  assert.equal(page.view,null);assert.equal(f.pool.pages.get(page.id),page);assert.equal(f.pool.inspect()[0].url,'https://chatgpt.com/c/original#latest');
  assert.equal(f.pool.inspect()[0].resident,false);assert.equal(page.requestId,'original-request');assert.equal(page.taskId,'original-task');
  assert.equal(page.modelRestorePending,true);assert.equal(page.documentGeneration,1);
  const restored=await f.pool.ensure(page.id);
  assert.equal(restored,page);assert.notEqual(page.view,original);assert.equal(page.account,'A');assert.equal(page.root,'D:/original');
  assert.equal(page.view.options.webPreferences.partition,'persist:account-A');assert.deepEqual(page.view.webContents.loads,['https://chatgpt.com/c/original#latest']);
  assert.equal(page.view.options.webPreferences.backgroundThrottling,false);assert.ok(page.view.bounds.width>0&&page.view.bounds.height>0);assert.equal(page.observation,null);
  assert.equal(f.pool.inspect()[0].resident,true);assert.equal(f.attached.size,1);
});

test('overlapping ensures and reentrant changed listeners share one account admission and renderer',async()=>{
  const admission=deferred(),f=fixture({admit:()=>admission.promise});f.pool.register('original');
  let reentrant;f.pool.on('changed',()=>{if(f.pool.pages.get('original')?.rendererState==='hydrating')reentrant=f.pool.ensure('original');});
  const one=f.pool.ensure('original'),two=f.pool.ensure('original');assert.equal(one,two);
  await Promise.resolve();assert.equal(reentrant,one);assert.equal(f.views.length,0);
  assert.equal(f.pool.suspend('original',{now:1000}).reason,'hydrating');
  admission.resolve();assert.equal(await one,await two);assert.equal(f.views.length,1);assert.equal(f.admissions.filter(x=>x[0]==='admit').length,1);
});

test('hydration preserves a later selection rather than selecting the slower page',async()=>{
  const admission=deferred(),f=fixture({admit:account=>account==='A'?admission.promise:undefined});
  f.pool.register('slow','https://chatgpt.com/c/slow',{account:'A'});f.pool.register('fast','https://chatgpt.com/c/fast',{account:'B'});
  f.pool.select('slow');const slow=f.pool.ensure('slow');f.pool.select('fast');await f.pool.ensure('fast');admission.resolve();await slow;
  assert.equal(f.pool.selected,'fast');assert.equal(f.pool.inspect().find(p=>p.id==='slow').selected,false);
});

test('subframe navigation and loading preserve the original main DOM, model and running or idle status',async()=>{
  for(const status of ['idle','running']){
    const f=fixture(),page=await f.idle(await f.pool.create('original','https://chatgpt.com/c/original',{account:'A',requestId:'original-request'}));
    const wc=page.view.webContents;wc.isLoadingMainFrame=()=>false;page.status=status;page.modelRestorePending=false;
    page.modelSelection={model:'GPT-6',effort:'Pro'};const observation=page.observation,selection=page.modelSelection,generation=page.documentGeneration;
    f.pool.select(page.id);
    wc.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});wc.emit('did-start-loading');
    assert.equal(page.domReady,true);assert.equal(page.status,status);wc.emit('did-stop-loading');
    assert.equal(page.domReady,true);assert.equal(page.status,status);assert.equal(page.documentGeneration,generation);
    assert.equal(page.observation,observation);assert.equal(page.modelSelection,selection);assert.equal(page.modelRestorePending,false);
    assert.equal(page.requestId,'original-request');assert.equal(page.account,'A');assert.equal(f.pool.selected,page.id);assert.equal(wc.loads.length,1);
  }
});

test('same-document main navigation does not reset DOM readiness or restored model state',async()=>{
  const f=fixture(),page=await f.idle(await f.pool.create('original'));const wc=page.view.webContents;
  wc.isLoadingMainFrame=()=>false;page.modelRestorePending=false;page.modelSelection={model:'GPT-6',effort:'Pro'};
  const observation=page.observation,selection=page.modelSelection,generation=page.documentGeneration;
  wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});wc.emit('did-start-loading');wc.emit('did-stop-loading');
  assert.equal(page.domReady,true);assert.equal(page.status,'idle');assert.equal(page.documentGeneration,generation);
  assert.equal(page.observation,observation);assert.equal(page.modelSelection,selection);assert.equal(page.modelRestorePending,false);
});

test('new main-document navigation invalidates DOM before loading and requires the next top-level DOM-ready event',async()=>{
  const f=fixture(),page=await f.idle(await f.pool.create('original'));const wc=page.view.webContents;
  wc.isLoadingMainFrame=()=>true;page.modelRestorePending=false;page.modelSelection={model:'GPT-6',effort:'Pro'};
  const generation=page.documentGeneration;
  wc.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});
  assert.equal(page.domReady,false);assert.equal(page.documentGeneration,generation+1);assert.equal(page.modelRestorePending,true);
  assert.equal(page.observation,null);assert.equal(page.modelSelection,null);
  wc.emit('did-start-loading');assert.equal(page.status,'loading');assert.equal(page.domReady,false);
  wc.emit('did-stop-loading');assert.equal(page.status,'idle');assert.equal(page.domReady,false);
  wc.emit('dom-ready');await page.viewportReady;assert.equal(page.domReady,true);assert.equal(page.documentGeneration,generation+1);
});

test('without a native main-frame loading query spinner status remains compatible but cannot clear a ready main DOM',async()=>{
  const f=fixture(),page=await f.idle(await f.pool.create('original'));const wc=page.view.webContents;
  assert.equal(typeof wc.isLoadingMainFrame,'undefined');const generation=page.documentGeneration,observation=page.observation;
  wc.emit('did-start-loading');assert.equal(page.status,'loading');assert.equal(page.domReady,true);
  wc.emit('did-stop-loading');assert.equal(page.status,'idle');assert.equal(page.domReady,true);
  assert.equal(page.documentGeneration,generation);assert.equal(page.observation,observation);
});

test('running work, active local work, busy operations, pins, visible native selection and unknown sends refuse release',async()=>{
  for(const [label,protect,options,reason] of [
    ['running',(p,f)=>f.pool.running(p.id,true),{},'active_work'],
    ['local work',(p,f)=>f.pool.work(p.id,true),{},'active_work'],
    ['busy',()=>{},{busy:true},'busy'],
    ['pin',(p,f)=>f.pool.pin(p.id),{},'pinned'],
    ['explicit pin',()=>{},{pinned:true},'pinned'],
    ['visible native',(p,f)=>{f.pool.native=true;f.pool.select(p.id);},{},'selected_visible'],
    ['unknown send',p=>{p.modelSendUnknown=true;},{},'model_send_unknown'],
    ['explicit unknown send',()=>{},{modelSendUnknown:true},'model_send_unknown']
  ]){
    const f=fixture(),p=await f.idle(await f.pool.create(label));protect(p,f);
    assert.equal(f.pool.suspend(p.id,{now:1000,...options}).reason,reason,label);assert.equal(f.pool.isLoaded(p.id),true,label);assert.equal(p.view.webContents.closes,0,label);
  }
});

test('drafts, composition, generation and approvals from fields, explicit guards or latest observations refuse release',async()=>{
  for(const source of ['page','options','observation'])for(const flag of ['draft','composing','generating','approvalRequired']){
    const f=fixture(),p=await f.idle(await f.pool.create(source+'-'+flag));const options={now:1000};
    if(source==='page')p[flag]=true;else if(source==='options')options[flag]=true;else p.observation[flag]=true;
    assert.equal(f.pool.suspend(p.id,options).suspended,false,source+' '+flag);assert.equal(p.view.webContents.closes,0);
  }
});

test('unknown, stale, future, missing and errored observations cannot authorize release',async()=>{
  for(const observation of [null,{at:0,generating:false},{at:1001,generating:false},{at:1000},{at:1000,generating:false,error:'snapshot_failed'},{at:1000,generating:false,unknown:true},{at:1000,generating:false,known:false}]){
    const f=fixture(),p=await f.idle(await f.pool.create('original'));p.observation=observation;
    assert.equal(f.pool.suspend(p.id,{now:1000,maxObservationAgeMs:100}).suspended,false);assert.equal(f.pool.isLoaded(p.id),true);
  }
});

test('an older supplied safe snapshot cannot override newer dangerous page state',async()=>{
  const f=fixture(),p=await f.idle(await f.pool.create('original'));p.observation={at:1000,generating:false,draft:true};
  assert.equal(f.pool.suspend(p.id,{now:1000,observation:{at:999,generating:false}}).reason,'draft');
  assert.equal(f.pool.suspend(p.id,{now:1001,observation:{at:1001,generating:false,draft:false}}).suspended,true);
});

test('independent pins require each owner to release its own token',async()=>{
  const f=fixture(),p=await f.idle(await f.pool.create('original'));const one=f.pool.pin(p.id),two=f.pool.pin(p.id);assert.notEqual(one,two);
  f.pool.unpin(p.id,one);assert.equal(f.pool.suspend(p.id,{now:1000}).reason,'pinned');
  f.pool.unpin(p.id,two);assert.equal(f.pool.suspend(p.id,{now:1000}).suspended,true);
});

test('hidden or minimized native selection may release after fresh idle confirmation',async()=>{
  for(const change of [f=>f.setVisible(false),f=>f.setMinimized(true)]){
    const f=fixture(),p=await f.idle(await f.pool.create('original'));f.pool.native=true;f.pool.select(p.id);change(f);
    assert.equal(f.pool.suspend(p.id,{now:1000}).suspended,true);assert.equal(f.pool.selected,p.id);
  }
});

test('late navigation, crash, load and viewport callbacks from a released view cannot alter restored state',async()=>{
  const load=deferred(),viewport=deferred(),f=fixture({load:()=>load.promise});const p=await f.pool.create('original');const old=p.view;
  old.webContents.debugger.sendCommand=()=>viewport.promise;old.webContents.emit('dom-ready');p.status='idle';p.observation={at:1000,generating:false};
  p.observation.draft=false;const oldViewport=p.viewportReady;assert.equal(f.pool.suspend(p.id,{now:1000}).suspended,true);
  await f.pool.ensure(p.id);const current=p.view;current.webContents.emit('dom-ready');await p.viewportReady;
  p.status='running';p.observation={at:1001,generating:true};const generation=p.documentGeneration,ready=p.domReady;
  old.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});old.webContents.emit('dom-ready');old.webContents.emit('did-start-loading');old.webContents.emit('did-stop-loading');
  old.webContents.emit('did-navigate',{},'https://chatgpt.com/c/stale');old.webContents.emit('render-process-gone',{}, {reason:'crashed'});
  load.resolve();viewport.reject(Error('destroyed debugger'));await oldViewport;await Promise.resolve();
  assert.equal(p.view,current);assert.equal(p.status,'running');assert.equal(p.documentGeneration,generation);assert.equal(p.observation.generating,true);
  assert.equal(p.domReady,ready);
  assert.equal(p.url,'https://chatgpt.com/');assert.equal(f.events.filter(x=>x[0]==='crashed'||x[0]==='navigation'||x[0]==='load-failed').length,0);
});

test('one protection failure frees only its partial renderer and preserves identity for retry',async()=>{
  let fail=true;const f=fixture({protect:session=>{if(fail&&session.partition==='persist:account-A')throw Error('protect_failed');}});
  const original=f.pool.register('bad','https://chatgpt.com/c/original',{account:'A',requestId:'same-request'});f.pool.register('good','https://chatgpt.com/c/independent',{account:'B'});
  const results=await Promise.allSettled([f.pool.ensure('bad'),f.pool.ensure('good')]);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
  assert.equal(f.pool.pages.get('bad'),original);assert.equal(original.view,null);assert.equal(f.views[0].webContents.closes,1);assert.equal(f.attached.size,1);assert.equal(f.pool.isLoaded('good'),true);
  fail=false;await f.pool.ensure('bad');assert.equal(original.requestId,'same-request');assert.deepEqual(original.view.webContents.loads,['https://chatgpt.com/c/original']);assert.equal(f.attached.size,2);
});

test('closing during admission or protection cannot create or navigate a late renderer',async()=>{
  for(const stage of ['admit','protect']){
    const gate=deferred(),f=fixture({[stage]:()=>gate.promise});f.pool.register('original');const pending=f.pool.ensure('original');await Promise.resolve();await Promise.resolve();await Promise.resolve();
    f.pool.close('original');gate.resolve();await assert.rejects(pending,/browser_page_missing/);
    assert.equal(f.pool.pages.size,0);assert.equal(f.attached.size,0);assert.ok(f.views.every(v=>v.webContents.destroyed&&v.webContents.loads.length===0));assert.equal(f.protectedContents.length,0);
  }
});

test('a slow navigation still allows another demand restore and a permanent close',async()=>{
  const f=fixture({load:()=>new Promise(()=>{})});const p=await f.pool.create('slow');f.pool.register('other');await f.pool.ensure('other');
  assert.equal(f.views.length,2);assert.equal(f.pool.suspend(p.id,{now:1000}).reason,'loading');f.pool.close('slow');assert.equal(f.pool.pages.has('slow'),false);assert.equal(f.pool.isLoaded('other'),true);
});

test('reload of unloaded history hydrates its restored URL once and close removes metadata permanently',async()=>{
  const f=fixture(),p=f.pool.register('original','https://chatgpt.com/c/original',{account:'A'});
  await f.pool.reload(p.id,'https://chatgpt.com/c/restored');assert.equal(f.views.length,1);assert.deepEqual(p.view.webContents.loads,['https://chatgpt.com/c/restored']);
  await f.idle(p);assert.equal(f.pool.hibernate(p.id,{now:1000}).released,true);assert.equal(f.pool.suspend(p.id).released,false);
  f.pool.close(p.id);assert.equal(f.pool.pages.has(p.id),false);assert.equal(f.pool.inspect().length,0);await assert.rejects(f.pool.ensure(p.id),/browser_page_missing/);
});

test('inspect preserves persisted renderer protection until an actual resident observation replaces it',async()=>{
  const f=fixture(),p=f.pool.register('original','https://chatgpt.com/c/original',{residentRequired:true});
  assert.equal(f.pool.inspect()[0].residentRequired,true);await f.pool.ensure(p.id);assert.equal(f.pool.inspect()[0].residentRequired,true);
  await f.idle(p);assert.equal(f.pool.inspect()[0].residentRequired,false);
  for(const flag of ['draft','composing','approvalRequired','generating']){
    p.observation={at:1000,generating:false,draft:false,[flag]:true};assert.equal(f.pool.inspect()[0].residentRequired,true,flag);
  }
});

test('a detach failure still closes that renderer and leaves independent pages releasable',async()=>{
  let fail=true;const f=fixture({remove:()=>{if(fail){fail=false;throw Error('detach_failed');}}});
  const one=await f.idle(await f.pool.create('one')),two=await f.idle(await f.pool.create('two'));const original=one.view;
  assert.equal(f.pool.suspend(one.id,{now:1000}).reason,'release_failed');assert.equal(original.webContents.closes,1);
  assert.equal(f.pool.pages.get(one.id),one);assert.equal(f.pool.isLoaded(one.id),false);
  assert.equal(f.pool.suspend(two.id,{now:1000}).released,true);assert.equal(f.pool.pages.size,2);
});

test('native typing and clicks synchronously yield control while reading and programmatic keys do not',async()=>{
  const f=fixture(),p=await f.idle(await f.pool.create('original')),wc=p.view.webContents,seen=[];
  f.pool.on('manual-interaction',event=>seen.push({...event,observedSequence:p.manualInteractionSequence}));
  const pending=wc[Symbol.for('clw.programmatic-input')]=[{type:'keyDown',key:'Escape',code:'Escape'}];
  wc.emit('before-input-event',{}, {type:'keyDown',key:'a',code:'KeyA'});
  assert.equal(p.manualInteractionSequence,1);assert.equal(pending.length,1,'different real key is not hidden by programmatic input');
  wc.emit('before-input-event',{}, {type:'keyDown',key:'Escape',code:'Escape'});
  assert.equal(p.manualInteractionSequence,1);assert.equal(pending.length,0);
  wc.emit('before-input-event',{}, {type:'keyUp',key:'a'});
  for(const type of ['mouseMove','mouseWheel','mouseEnter','mouseUp'])wc.emit('before-mouse-event',{}, {type});
  assert.equal(p.manualInteractionSequence,1);
  wc.emit('before-mouse-event',{}, {type:'mouseDown'});
  wc.emit('before-input-event',{}, {type:'char',key:'中'});
  assert.deepEqual(seen.map(x=>[x.kind,x.sequence,x.observedSequence]),[['keyboard',1,1],['pointer',2,2],['keyboard',3,3]]);
  assert.ok(Number.isFinite(p.lastManualInteractionAt));assert.equal(p.manualControl,true);assert.equal(p.manualUrl,'https://chatgpt.com/');
  wc.emit('did-navigate-in-page',{},'https://chatgpt.com/c/bootstrap');
  assert.equal(p.manualInteractionSequence,3,'automatic conversation binding is not manual input');
  assert.equal(p.manualUrl,'https://chatgpt.com/c/bootstrap');
  assert.deepEqual({manualControl:f.pool.inspect()[0].manualControl,manualInteractionSequence:f.pool.inspect()[0].manualInteractionSequence,manualUrl:f.pool.inspect()[0].manualUrl},
    {manualControl:true,manualInteractionSequence:3,manualUrl:'https://chatgpt.com/c/bootstrap'});
  wc.emit('did-navigate',{},'https://auth.openai.com/login');assert.equal(p.manualUrl,'https://chatgpt.com/c/bootstrap','login cannot replace the manual conversation restore point');
});

test('typing during awaited reload admission cancels the late navigation without losing the current page',async()=>{
  const gate=deferred();let wait=false;
  const f=fixture({admit:()=>wait?gate.promise:undefined}),p=await f.idle(await f.pool.create('original','https://chatgpt.com/c/current')),wc=p.view.webContents;
  wait=true;const pending=f.pool.reload(p.id,'https://chatgpt.com/c/old');
  wc.emit('before-input-event',{}, {type:'keyDown',key:'b'});gate.resolve();
  await assert.rejects(pending,/manual_web_interaction/);
  assert.deepEqual(wc.loads,['https://chatgpt.com/c/current']);assert.equal(p.url,'https://chatgpt.com/c/current');assert.equal(wc.reloads,undefined);
});

test('native external links use the OS browser once while authentication stays in the isolated account partition',async()=>{
  const opened=[],f=fixture({openExternal:url=>opened.push(url)}),p=await f.idle(await f.pool.create('original','https://chatgpt.com/c/current',{account:'A'})),wc=p.view.webContents;
  f.pool.select(p.id);f.pool.native=true;
  assert.deepEqual(wc.popup({url:'https://example.org/no-gesture'}),{action:'deny'});assert.equal(opened.length,0);
  wc.emit('before-mouse-event',{}, {type:'mouseDown'});
  assert.deepEqual(wc.popup({url:'https://example.org/paper'}),{action:'deny'});
  assert.deepEqual(wc.popup({url:'https://example.org/second'}),{action:'deny'});
  assert.deepEqual(opened,['https://example.org/paper']);assert.equal(p.url,'https://chatgpt.com/c/current');
  const popup=wc.popup({url:'https://auth.openai.com/login'});
  assert.equal(popup.action,'allow');assert.equal(popup.overrideBrowserWindowOptions.webPreferences.partition,'persist:account-A');
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.nodeIntegration,false);
  wc.emit('before-input-event',{}, {type:'keyDown',key:'Enter'});let prevented=0;
  wc.emit('will-navigate',{preventDefault(){prevented++;}},'https://example.net/reference');
  assert.equal(prevented,1);assert.deepEqual(opened,['https://example.org/paper','https://example.net/reference']);
});

test('external navigation never opens non-HTTPS, expired, hidden or replaced-page targets',async()=>{
  const opened=[],f=fixture({openExternal:url=>opened.push(url)}),p=await f.idle(await f.pool.create('original')),old=p.view,wc=old.webContents;
  f.pool.select(p.id);f.pool.native=true;
  for(const url of ['http://example.org/','file:///C:/private','javascript:alert(1)','mailto:a@example.org','https://user:secret@example.org/']){
    wc.emit('before-mouse-event',{}, {type:'mouseDown'});assert.deepEqual(wc.popup({url}),{action:'deny'});
  }
  wc.emit('before-mouse-event',{}, {type:'mouseDown'});p.externalGesture.at-=1501;
  assert.deepEqual(wc.popup({url:'https://example.org/expired'}),{action:'deny'});
  wc.emit('before-mouse-event',{}, {type:'mouseDown'});f.setVisible(false);
  assert.deepEqual(wc.popup({url:'https://example.org/hidden'}),{action:'deny'});f.setVisible(true);
  p.view={webContents:{isDestroyed:()=>false}};
  wc.emit('before-mouse-event',{}, {type:'mouseDown'});assert.deepEqual(wc.popup({url:'https://example.org/stale'}),{action:'deny'});
  assert.deepEqual(opened,[]);assert.equal(p.manualInteractionSequence,7,'stale native events cannot acquire control');
});

test('external browser failures are reported without throwing into native navigation',async()=>{
  for(const fail of [()=>{throw Error('blocked');},()=>Promise.reject(Error('blocked'))]){
    const f=fixture({openExternal:fail}),p=await f.idle(await f.pool.create('original')),wc=p.view.webContents,failures=[];
    f.pool.select(p.id);f.pool.native=true;f.pool.on('external-open-failed',event=>failures.push(event));
    wc.emit('before-mouse-event',{}, {type:'mouseDown'});
    assert.deepEqual(wc.popup({url:'https://example.org/'}),{action:'deny'});await Promise.resolve();
    assert.deepEqual(failures,[{id:p.id,code:'external_link_open_failed'}]);
  }
});
