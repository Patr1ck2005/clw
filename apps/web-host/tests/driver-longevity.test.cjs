'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs');
const {BrowserPool}=require('../browser-pool.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function bounded(promise,ms=300){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture_deadline')),ms);})]);}finally{clearTimeout(timer);}}
async function until(predicate){const deadline=Date.now()+1000;while(!predicate()){if(Date.now()>deadline)throw Error('fixture_observation_deadline');await wait(4);}}
function row(id,extra={}){return {page_id:id,url:`https://chatgpt.com/c/${id}`,account:'A',phase:'bound',paused:true,latest_request:{id:`original-${id}`,phase:'processing'},...extra};}
function fixture({rows=[],read,ensure,dom,interval=8}={}){
  const runtime=new EventEmitter(),calls=[],notices=[],records=[];runtime.ready=true;runtime.closed=false;
  runtime.call=async(op,payload)=>{calls.push({op,payload});if(op==='list')return read?read():{pages:rows};if(op==='pause'||op==='pending-receipt')return {state:'idle'};assert.fail(`unexpected operation ${op}`);};
  const pool={pages:new Map(),selected:null,emit(){},running(){},work(){},register(id,url,metadata){const page={id,url,...metadata,documentGeneration:0,view:null};this.pages.set(id,page);return page;},
    ensure:ensure||(async id=>{const page=pool.pages.get(id);page.view={webContents:{isDestroyed:()=>false,getURL:()=>page.url}};return page;})};
  const driver=new WebDriver({runtime,pool,observeIntervalMs:interval,onNotice:message=>notices.push(message),onRecords:pages=>records.push(pages),
    dom:dom||(async wc=>({url:wc.getURL(),editor:true,controlKnown:true,generating:false,draft:false,composing:false,historyAtLatest:true,userId:'same-public-turn'}))});
  return {driver,runtime,pool,calls,notices,records};
}

test('concurrent restores share one read and one observer instead of orphan intervals',async t=>{
  const f=fixture();t.after(()=>f.driver.dispose());
  const restore=f.driver.restore();for(let n=0;n<80;n++)assert.equal(f.driver.restore(),restore);
  await restore;assert.equal(f.calls.length,1);await until(()=>f.calls.length>=3);
  assert.ok(f.calls.length<=5,`expected one observer, got ${f.calls.length} reads`);
  f.driver.stop();const count=f.calls.length;await wait(35);assert.equal(f.calls.length,count);assert.equal(f.driver.timer,null);
});

test('an initial original-list failure still has a live observer and later restores unchanged records',async t=>{
  let reads=0;const original=row('paused-original'),f=fixture({read:async()=>{if(++reads===1)throw Error('temporary_original_list_failure');return {pages:[original]};}});t.after(()=>f.driver.dispose());
  await assert.rejects(f.driver.restore(),/temporary_original_list_failure/);assert.equal(f.driver.recordsLoaded,false);
  await until(()=>f.driver.recordsLoaded);assert.equal(f.driver.records.get(original.page_id),original);
  assert.equal(original.paused,true);assert.ok(reads>=2);assert.ok(f.calls.every(call=>['list','pending-receipt'].includes(call.op)));
});

test('a never-settled renderer admission cannot hold readiness, another page, or later ledger reads',async t=>{
  const stuck=row('slow'),healthy=row('healthy'),held=deferred(),admissions=[];
  let f;f=fixture({rows:[stuck,healthy],ensure:async id=>{admissions.push(id);if(id==='slow')return held.promise;const page=f.pool.pages.get(id);page.view={webContents:{isDestroyed:()=>false,getURL:()=>page.url}};return page;}});t.after(()=>{held.resolve();f.driver.dispose();});
  await bounded(f.driver.restore());await turn();assert.equal(f.driver.recordsLoaded,true);assert.ok(f.pool.pages.get('healthy').view);assert.deepEqual(admissions,['slow','healthy']);
  await until(()=>f.calls.filter(call=>call.op==='list').length>=3);assert.equal(admissions.filter(id=>id==='slow').length,1);
  assert.equal(f.driver.pageReconciliations.size,1,'the original unresolved admission is retained, never duplicated');
  assert.equal(stuck.paused,true);assert.equal(stuck.latest_request.id,'original-slow');
});

test('an unrelated unresolved page never delays the acknowledgement of pausing one original task',async t=>{
  const stuck=row('slow'),selected=row('selected'),held=deferred();let f;
  f=fixture({rows:[stuck,selected],ensure:async id=>{if(id==='slow')return held.promise;const page=f.pool.pages.get(id);page.view={webContents:{isDestroyed:()=>false,getURL:()=>page.url}};return page;}});t.after(()=>{held.resolve();f.driver.dispose();});
  await bounded(f.driver.restore());const result=await bounded(f.driver.pause(f.pool.pages.get('selected'),'original-selected'));
  assert.match(result.message,/已暂停/);assert.equal(f.calls.filter(call=>call.op==='pause').length,1);
  assert.deepEqual(f.calls.find(call=>call.op==='pause').payload,{page_id:'selected',paused:true,expected_request_id:'original-selected'});
});

test('stop during a restore fences its late result and cannot recreate a timer after resume',async t=>{
  const held=deferred();let reads=0;const f=fixture({read:()=>++reads===1?held.promise:Promise.resolve({pages:[]})});t.after(()=>f.driver.dispose());
  const old=f.driver.restore();f.driver.stop();f.driver.stopped=false;await f.driver.restore();
  held.resolve({pages:[row('late-old-page')]});await old;await until(()=>reads>=3);
  assert.equal(f.driver.records.has('late-old-page'),false);assert.ok(reads>=3);
  f.driver.stop();const count=reads;await wait(25);assert.equal(reads,count);assert.equal(f.driver.timer,null);
});

test('a reconnect publishes the new ledger read while discarding the previous connection reply',async t=>{
  const old=deferred(),fresh=deferred();let reads=0;const f=fixture({read:()=>++reads===1?old.promise:fresh.promise});t.after(()=>f.driver.dispose());
  const previous=f.driver.reconcileAll({background:true});f.runtime.ready=false;f.runtime.emit('disconnected');f.runtime.ready=true;f.runtime.emit('ready');
  fresh.resolve({pages:[row('same-store-current')]});await turn();await turn();assert.equal(f.driver.recordsLoaded,true);
  old.resolve({pages:[row('stale-previous')]});await previous;assert.equal(f.driver.records.has('stale-previous'),false);
  assert.equal(f.driver.records.get('same-store-current').latest_request.id,'original-same-store-current');assert.equal(f.records.length,1);
});

test('repeated suspend and restore never accumulates runtime listeners or later observation loops',async()=>{
  const runtime=new EventEmitter();runtime.ready=true;runtime.call=async()=>({pages:[]});
  for(let n=0;n<120;n++){
    const d=new WebDriver({runtime,pool:{pages:new Map(),emit(){}},onNotice(){},observeIntervalMs:1000});
    assert.equal(runtime.listenerCount('ready'),1);assert.equal(runtime.listenerCount('disconnected'),1);
    for(let cycle=0;cycle<8;cycle++){await d.restore();d.stop();assert.equal(d.timer,null);d.stopped=false;}
    d.dispose();assert.equal(runtime.listenerCount('ready'),0);assert.equal(runtime.listenerCount('disconnected'),0);
    await assert.rejects(d.restore(),/web_driver_disposed/);
  }
});

test('a delayed original public observation cannot overwrite the page after stop and resume',async t=>{
  const held=deferred(),original=row('same-page'),f=fixture({rows:[original],dom:()=>held.promise});t.after(()=>f.driver.dispose());
  const page=f.pool.register(original.page_id,original.url,{account:'A'});await f.pool.ensure(page.id);
  const tick=f.driver.tick(original);f.driver.stop();f.driver.stopped=false;
  page.observation={at:123,generating:true,originalAfterResume:true};held.resolve({url:page.url,editor:true,controlKnown:true,generating:false,userId:'stale-turn'});await tick;
  assert.deepEqual(page.observation,{at:123,generating:true,originalAfterResume:true});assert.equal(f.calls.length,0);
});

test('local records become ready while an unverified network admits zero browser views or navigations',async t=>{
  let views=0,navigations=0;const original=row('vpn-wait'),runtime=new EventEmitter();runtime.ready=true;
  runtime.call=async op=>{assert.equal(op,'list');return {pages:[original]};};
  class View{constructor(){views++;this.webContents={loadURL(){navigations++;},isDestroyed:()=>false};}}
  const guard={ready:false},pool=new BrowserPool({networkGuard:guard,allowedUrl:()=>true,WebContentsView:View});
  const d=new WebDriver({runtime,pool,onNotice(){},observeIntervalMs:1000});t.after(()=>d.dispose());
  await bounded(d.restore());await turn();assert.equal(d.recordsLoaded,true);assert.equal(d.records.get(original.page_id),original);
  assert.equal(views,0);assert.equal(navigations,0);assert.equal(pool.pages.get(original.page_id).url,original.url);assert.equal(original.paused,true);
});

test('observation caches remain bounded by current turns while original accepted ownership is retained',async t=>{
  let current=row('long-running',{latest_request:{id:'request-0',phase:'processing',attempt_id:'attempt-0'}});
  const f=fixture({read:async()=>({pages:[current]})});t.after(()=>f.driver.dispose());
  f.driver.pending.set('unknown-page',{attempt:'unknown-original-attempt'});f.driver.completed.add('unknown-original-attempt');
  for(let n=0;n<1200;n++){
    current={...current,latest_request:{id:`request-${n}`,phase:'completed',attempt_id:`attempt-${n}`}};
    f.driver.completed.add(current.latest_request.attempt_id);await f.driver.reconcileAll({background:true});
    assert.equal(f.driver.completed.size,2);assert.ok(f.driver.completed.has('unknown-original-attempt'));
  }
  assert.equal(f.driver.pending.get('unknown-page').attempt,'unknown-original-attempt');
});

test('budget continuation carries an existing durable API reference while UI and unknown originals keep their original paths',async t=>{
  const f=fixture(),calls=[],key='fedcba98-7654-4321-8abc-0123456789ab';t.after(()=>f.driver.dispose());
  f.driver.goalOperation=async()=>({goal:{configured:false}});f.driver.resume=async()=>{};f.driver.reconcileAll=async()=>{};
  f.runtime.call=async(op,payload)=>{assert.equal(op,'budget-continuation');assert.deepEqual(payload,{page_id:'original-page',expected_run_id:'same-run'});return {objective:'original package'};};
  const submissions={start:async(...args)=>{calls.push(args);return {state:'queued_for_web_host',request_id:key};}},workspace={pendingStarts:{}};
  await f.driver.continueBudget({id:'original-page'},{expected_run_id:'same-run',instructions:'next constraints'},{workspace,submissions,executionReference:key});
  assert.deepEqual(calls[0],['original-page','original package\n\n本次用户要求：\nnext constraints',null,{operation_id:key}]);
  await f.driver.continueBudget({id:'original-page'},{expected_run_id:'same-run'},{workspace,submissions});assert.deepEqual(calls[1],['original-page','original package']);
  workspace.pendingStarts['original-page']={objective:'original unknown submission'};
  await f.driver.continueBudget({id:'original-page'},{expected_run_id:'same-run'},{workspace,submissions,executionReference:key});
  assert.deepEqual(calls[2],['original-page','original unknown submission'],'an unknown existing submission never acquires a replacement operation key');
});
