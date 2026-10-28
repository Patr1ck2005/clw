'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createHistoryVerification}=require('../chat-history-verification.cjs');
const SECRET='SECRET_response_html_token';
function fixture({protect,load,onFailure}={}){
  const created=[],events=[],failures=[],business={url:'https://chatgpt.com/c/original',draft:'original draft'};
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.destroyed=false;this.shows=0;this.focuses=0;this.loads=[];
      this.webContents=Object.assign(new EventEmitter(),{session:{partition:options.webPreferences.partition},
        setWindowOpenHandler:handler=>{this.openHandler=handler;},executeJavaScript:()=>assert.fail('verification must not read any page')});created.push(this);}
    isDestroyed(){return this.destroyed;}
    show(){assert.equal(this.destroyed,false);this.shows++;events.push('show');}
    focus(){this.focuses++;}
    loadURL(url){this.loads.push(url);events.push('load');return load?load(this,url):new Promise(()=>{});}
    destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('closed');}
  }
  const guard={ready:true,protect:async ses=>{events.push('protect');if(protect)await protect(ses);},protectContents:()=>events.push('protect-contents')};
  const verification=createHistoryVerification({BrowserWindow:Window,guard,partitionForAccount:account=>'persist:original-'+account,
    onFailure:failure=>{failures.push(failure);onFailure?.(failure);}});
  return {verification,guard,created,events,failures,business};
}
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}

test('creates a protected visible account window with the exact original partition and fixed non-auth target',async t=>{
  const f=fixture();t.after(()=>f.verification.dispose());
  assert.deepEqual(await f.verification.open('A','auth'),{account:'A',state:'verification_opened',model_sends:0});
  const w=f.created[0];assert.equal(w.options.show,false);assert.deepEqual(w.options.webPreferences,
    {partition:'persist:original-A',sandbox:true,nodeIntegration:false,contextIsolation:true});
  assert.deepEqual(w.loads,['https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated']);assert.equal(w.shows,1);assert.equal(w.focuses,1);
  assert.deepEqual(f.events,['protect','protect-contents','load','show']);
  assert.deepEqual(f.business,{url:'https://chatgpt.com/c/original',draft:'original draft'});
});

test('same-account requests reuse one original window, including simultaneous calls and a changed stage',async t=>{
  let allow;const f=fixture({protect:()=>new Promise(resolve=>{allow=resolve;})});t.after(()=>f.verification.dispose());
  const first=f.verification.open('A','auth'),second=f.verification.open('A','list');assert.equal(f.created.length,1);allow();
  await Promise.all([first,second]);await f.verification.open('A','detail');
  assert.equal(f.created.length,1);assert.equal(f.created[0].loads.length,1);assert.equal(f.created[0].shows,3);assert.equal(f.created[0].focuses,3);
});

test('A and B use separate partitions and windows; closed entries are removed and can be reopened',async t=>{
  const f=fixture();t.after(()=>f.verification.dispose());await f.verification.open('A','auth_recheck');await f.verification.open('B','detail');
  assert.equal(f.created.length,2);assert.notEqual(f.created[0].webContents.session.partition,f.created[1].webContents.session.partition);
  assert.deepEqual(f.created[1].loads,['https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated']);
  f.created[0].destroy();await f.verification.open('A','list');assert.equal(f.created.length,3);
  assert.deepEqual(f.created[2].loads,f.created[1].loads);
});

test('only fixed account/stage targets are accepted and every new popup is denied',async t=>{
  const f=fixture();t.after(()=>f.verification.dispose());
  for(const [account,stage] of [['C','auth'],['A','https://evil.example'],['A','javascript:alert(1)'],['A',''],[null,'auth']])
    await assert.rejects(f.verification.open(account,stage),e=>e.code==='history_verification_unavailable');
  assert.equal(f.created.length,0);await f.verification.open('A','auth');
  for(const url of ['https://chatgpt.com/','https://evil.example/','javascript:alert(1)'])assert.deepEqual(f.created[0].openHandler({url}),{action:'deny'});
});

test('every supported stage opens the same credential-free verification URL, never the auth session endpoint',async()=>{
  for(const stage of ['auth','auth_recheck','list','detail']){
    const f=fixture();await f.verification.open('A',stage);await f.verification.open('B',stage);
    for(const window of f.created){assert.deepEqual(window.loads,['https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated']);
      assert.ok(window.loads.every(url=>!url.includes('/api/auth/session')));}
    f.verification.dispose();
  }
});

test('normal same-origin verification navigation is allowed, foreign origins/protocols and redirects are blocked',async t=>{
  const f=fixture();t.after(()=>f.verification.dispose());await f.verification.open('A','list');const wc=f.created[0].webContents;
  for(const event of ['will-navigate','will-redirect'])for(const [url,blocked] of [
    ['https://chatgpt.com/cdn-cgi/challenge-platform/x',false],['https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated',false],
    ['http://chatgpt.com/',true],['https://other.example/',true],['https://chatgpt.com.evil.example/',true],
    ['https://name:pass@chatgpt.com/',true],['javascript:fetch("https://other.example")',true],['file:///C:/private',true]]){
    let prevented=false;wc.emit(event,{preventDefault(){prevented=true;}},url);assert.equal(prevented,blocked);
  }
  assert.equal(f.created[0].loads.length,1);
});

test('session protection failure leaves no visible/live window or sensitive error text',async()=>{
  const f=fixture({protect:()=>{throw Error(SECRET);}});
  await assert.rejects(f.verification.open('B','auth'),e=>e.message==='history_verification_unavailable');
  assert.equal(f.created.length,1);assert.equal(f.created[0].destroyed,true);assert.equal(f.created[0].shows,0);assert.equal(f.created[0].loads.length,0);
  f.verification.dispose();
});

test('load never blocks the command lane and async load failure only closes the verification window',async t=>{
  let failLoad;const f=fixture({load:()=>new Promise((_resolve,reject)=>{failLoad=reject;})});t.after(()=>f.verification.dispose());
  const receipt=await f.verification.open('A','auth');assert.deepEqual(receipt,{account:'A',state:'verification_opened',model_sends:0});
  assert.equal(f.created[0].destroyed,false);failLoad(Error(SECRET));await flush();assert.equal(f.created[0].destroyed,true);
  assert.deepEqual(f.failures,[{account:'A',code:'history_verification_load_failed'}]);
  assert.doesNotMatch(JSON.stringify(receipt),new RegExp(SECRET));await f.verification.open('A','list');assert.equal(f.created.length,2);
});

test('an immediately rejected load cannot return opened for an already destroyed window',async()=>{
  const f=fixture({load:()=>Promise.reject(Error(SECRET))});
  await assert.rejects(f.verification.open('A','auth'),e=>e.code==='history_verification_unavailable');await flush();
  assert.equal(f.created[0].destroyed,true);assert.deepEqual(f.failures,[{account:'A',code:'history_verification_load_failed'}]);
  assert.doesNotMatch(JSON.stringify(f.failures),new RegExp(SECRET));f.verification.dispose();
});

test('late rejection after disposal never notifies a stale verification failure',async()=>{
  let failLoad;const f=fixture({load:()=>new Promise((_resolve,reject)=>{failLoad=reject;})});
  await f.verification.open('B','detail');f.verification.dispose();failLoad(Error(SECRET));await flush();
  assert.deepEqual(f.failures,[]);assert.equal(f.created[0].destroyed,true);
});

test('an old closed window late failure cannot notify or close a newer same-account window',async t=>{
  const rejectLoads=[];const f=fixture({load:()=>new Promise((_resolve,reject)=>rejectLoads.push(reject))});t.after(()=>f.verification.dispose());
  await f.verification.open('A','auth');f.created[0].destroy();await f.verification.open('A','list');
  rejectLoads[0](Error(SECRET));await flush();assert.deepEqual(f.failures,[]);assert.equal(f.created[1].destroyed,false);
  rejectLoads[1](Error(SECRET));await flush();assert.deepEqual(f.failures,[{account:'A',code:'history_verification_load_failed'}]);
  assert.equal(f.created[1].destroyed,true);
});

test('a notification callback failure is scrubbed and cannot leave the failed window alive',async()=>{
  let failLoad;const f=fixture({load:()=>new Promise((_resolve,reject)=>{failLoad=reject;}),onFailure:()=>{throw Error(SECRET);}});
  await f.verification.open('A','auth');failLoad(Error(SECRET));await flush();assert.equal(f.created[0].destroyed,true);
  assert.deepEqual(f.failures,[{account:'A',code:'history_verification_load_failed'}]);f.verification.dispose();
});

test('synchronous load failure is scrubbed and cannot leave a blank orphan window',async()=>{
  const f=fixture({load:()=>{throw Error(SECRET);}});
  await assert.rejects(f.verification.open('A','detail'),e=>e.message==='history_verification_unavailable');
  assert.equal(f.created[0].destroyed,true);assert.equal(f.created[0].shows,0);f.verification.dispose();
});

test('VPN guard failure and app disposal prevent any later load or window recreation',async()=>{
  const offline=fixture();offline.guard.ready=false;await assert.rejects(offline.verification.open('A','auth'));assert.equal(offline.created.length,0);offline.verification.dispose();
  let allow;const f=fixture({protect:()=>new Promise(resolve=>{allow=resolve;})});const pending=f.verification.open('A','auth');
  f.verification.dispose();allow();await assert.rejects(pending,e=>e.code==='history_verification_unavailable');
  assert.equal(f.created[0].destroyed,true);assert.equal(f.created[0].loads.length,0);await assert.rejects(f.verification.open('B','list'));
  assert.equal(f.created.length,1);
});

test('normal disposal closes both temporary windows while keeping the original business state unchanged',async()=>{
  const f=fixture();await f.verification.open('A','auth');await f.verification.open('B','list');f.verification.dispose();f.verification.dispose();
  assert.ok(f.created.every(w=>w.destroyed));assert.deepEqual(f.business,{url:'https://chatgpt.com/c/original',draft:'original draft'});
});
