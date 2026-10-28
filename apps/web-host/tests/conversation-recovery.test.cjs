'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {WorkspaceState,restoreConversationUrl}=require('../workspace-state.cjs'),{WebDriver}=require('../web-driver.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const id='web-11111111-1111-4111-8111-111111111111',url='https://chatgpt.com/c/original';

test('direct bound homepage restores only an accepted original attempt as a same-page/account reading position',()=>{
 const home='https://chatgpt.com/',attempt='control_'+'a'.repeat(32),saved={id,account:'A',url};
 const record={page_id:id,account:'A',phase:'bound',conversation_mode:'direct',url:home,paused:true,
  latest_request:{id:'original-request',phase:'queued',attempt_id:attempt,sent_user_hash:null},
  attempt:{id:attempt,state:'dispatching',dispatched:123,acknowledged:null}};
 for(const state of ['dispatching','sent','unknown','acknowledged'])for(const phase of ['queued','processing','suspended','unknown']){
  const original={...record,latest_request:{...record.latest_request,phase},attempt:{...record.attempt,state}},before=JSON.stringify(original);
  assert.equal(restoreConversationUrl(original,saved),url);assert.equal(JSON.stringify(original),before);
 }
 const canonical='https://chatgpt.com/c/canonical';
 assert.equal(restoreConversationUrl({...record,url:canonical},saved),canonical);
 assert.equal(restoreConversationUrl(record,{...saved,url:home},saved),url);
 for(const wrong of [{...saved,id:'web-foreign'},{...saved,account:'B'},{...saved,url:url+'#foreign'},
  {...saved,url:url+'?foreign'},{...saved,url:'https://other.invalid/c/original'},{...saved,url:home}])
  assert.equal(restoreConversationUrl(record,wrong),home);
 for(const wrong of [
  {...record,conversation_mode:'managed'}, {...record,latest_request:null},
  {...record,latest_request:{...record.latest_request,id:null}},
  {...record,latest_request:{...record.latest_request,phase:'completed'}},
  {...record,latest_request:{...record.latest_request,attempt_id:'foreign'}},
  {...record,attempt:null}, {...record,attempt:{...record.attempt,id:'foreign'}},
  {...record,attempt:{...record.attempt,state:'offered'}}, {...record,attempt:{...record.attempt,state:'not_sent'}},
  {...record,attempt:{...record.attempt,dispatched:null}}, {...record,attempt:{...record.attempt,dispatched:undefined}},
  {...record,attempt:{...record.attempt,dispatched:0}}, {...record,attempt:{...record.attempt,dispatched:NaN}}
 ])assert.equal(restoreConversationUrl(wrong,saved),home);
});
test('accepted unbound restore is a same-page/account reading position; durable bound URLs retain authority',()=>{
 const home='https://chatgpt.com/',saved={id,account:'A',url},record={page_id:id,account:'A',phase:'reserved',bootstrap_state:'sent',url:home};
 for(const bootstrap_state of ['sending','sent','unknown'])assert.equal(restoreConversationUrl({...record,bootstrap_state},saved),url);
 assert.equal(restoreConversationUrl({...record,phase:'receiver_enrolled',bootstrap_state:'pending'},saved),url);
 assert.equal(restoreConversationUrl({...record,bootstrap_state:'pending'},saved),home);
 for(const wrong of [{...saved,id:'web-other'},{...saved,account:'B'},
  {...saved,url:'https://auth.openai.com/login'},{...saved,url:'https://other.invalid/c/original'},
  {...saved,url:url+'#foreign'},{...saved,url:'https://chatgpt.com/'}])assert.equal(restoreConversationUrl(record,wrong),home);
 assert.equal(restoreConversationUrl(record,{...saved,url:home},saved),url,'saved metadata can repair a previously overwritten unloaded descriptor');
 const durable='https://chatgpt.com/c/durable';assert.equal(restoreConversationUrl({...record,phase:'bound',url:durable},saved),durable);
 assert.equal(restoreConversationUrl({...record,url:durable},saved),durable,'unbound non-placeholder ledger addresses are not replaced');
});

for(const direct of [false,true])for(const registered of [false,true])test('actual saved workspace reload preserves an accepted '+(direct?'direct bound homepage':'unbound')+' conversation before hydration, with no bind or Send ('+registered+')',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-accepted-conversation-restart-')),home='https://chatgpt.com/';
 try{
  const original=new WorkspaceState(folder,u=>u.startsWith('https://chatgpt.com/'));
  original.update(id,{url,account:'A',title:'Original first task',closed:false});original.selected=id;original.save();
  const recovered=new WorkspaceState(folder,u=>u.startsWith('https://chatgpt.com/')),navigations=[],calls=[],domCalls=[];
  class View{
   constructor(options){this.options=options;let current='about:blank';this.webContents=Object.assign(new EventEmitter(),{
    session:{},isDestroyed:()=>false,getURL:()=>current,setWindowOpenHandler(){},
    loadURL:async target=>{current=target;navigations.push(target);},debugger:{isAttached:()=>true,sendCommand:async()=>({})}
   });}setBounds(){}setVisible(){}
  }
  const pool=new BrowserPool({window:{getContentSize:()=>[1200,800],contentView:{addChildView(){}}},WebContentsView:View,
   partitionForAccount:account=>'persist:test-'+account,allowedUrl:u=>u.startsWith('https://chatgpt.com/')});
  if(registered)pool.register(id,recovered.tasks.get(id).url,recovered.tasks.get(id));
  const existing=pool.pages.get(id),record={page_id:id,account:'A',url:home,phase:'receiver_enrolled',bootstrap_state:'sent',
   first_turn_mode:'task_v1',thread_id:'original-thread',session_id:'original-session',paused:true,
   latest_request:{id:'original-request',phase:'queued',attempt_id:null}};
  if(direct){
   const attempt='control_'+'a'.repeat(32);record.phase='bound';record.conversation_mode='direct';
   record.latest_request.attempt_id=attempt;record.latest_request.sent_user_hash=null;
   record.attempt={id:attempt,state:'unknown',dispatched:123,acknowledged:null};
  }
  const before=JSON.stringify(record),runtime=new EventEmitter();runtime.ready=true;
  runtime.call=async(op)=>{calls.push(op);assert.equal(op,'list','restoring a viewing URL cannot bind, Send or resume a task');return {pages:[record]};};
  const driver=new WebDriver({runtime,pool,metadata:key=>recovered.tasks.get(key)||{},onRecords:rows=>{assert.equal(recovered.syncBindings(rows),false);},onNotice(){},
   dom:async(wc,action)=>{domCalls.push(action);assert.equal(action,'snapshot');return {url:wc.getURL(),editor:true,controlKnown:true,
    userId:'original-user',assistantId:'',bootstrapMarker:'[CLW-BOOTSTRAP:'+id+']',bootstrapMarkerCount:1,
    historyAtLatest:true,generating:false,draft:false,composing:false,complete:false};}});
  await driver.reconcileAll();await new Promise(resolve=>setImmediate(resolve));await driver.reconcileAll();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(navigations,[url]);assert.equal(pool.pages.get(id).view.webContents.getURL(),url);assert.equal(pool.pages.get(id).account,'A');
  if(registered)assert.equal(pool.pages.get(id),existing);assert.equal(pool.pages.size,1);assert.equal(pool.pages.get(id).view.options.webPreferences.partition,'persist:test-A');
  assert.equal(JSON.stringify(record),before);assert.equal(driver.records.get(id).latest_request.id,'original-request');
  assert.equal(recovered.tasks.get(id).boundUrl,null);assert.equal(recovered.tasks.get(id).url,url);assert.ok(domCalls.length>0);assert.ok(domCalls.every(op=>op==='snapshot'));assert.ok(calls.every(op=>op==='list'));
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('runtime binding repairs old home metadata and survives login, navigation, close and restart',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-conversation-recovery-'));
  const allowed=u=>/^https:\/\/(chatgpt.com|auth.openai.com)\//.test(u);
  try{
    const state=new WorkspaceState(folder,allowed);state.update(id,{url:'https://chatgpt.com/',title:'math',closed:false});
    const record={page_id:id,phase:'bound',url};
    assert.equal(state.syncBindings([record]),true);assert.equal(state.syncBindings([record]),false);
    for(const visibleUrl of ['https://auth.openai.com/login','https://chatgpt.com/','https://chatgpt.com/c/another']){
      state.capture({selected:id,inspect:()=>[{id,url:visibleUrl}]});
      assert.equal(state.tasks.get(id).url,url);assert.equal(state.tasks.get(id).visibleUrl,visibleUrl);
    }
    state.update(id,{closed:true});state.save();
    const recovered=new WorkspaceState(folder,allowed);assert.equal(recovered.closed()[0].url,url);
    recovered.update(id,{closed:false,url:'https://chatgpt.com/'});assert.equal(recovered.tasks.get(id).url,url);
    assert.equal(recovered.syncBindings([{...record,url:'https://other.invalid/c/wrong'}]),false);
    assert.equal(recovered.syncBindings([{...record,phase:'reserved',url:'https://chatgpt.com/c/new'}]),false);
    assert.equal(recovered.tasks.get(id).url,url);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('actual main startup registrations, onRecords, hydration and navigation capture keep a direct accepted reading URL',async t=>{
 const vm=require('node:vm'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-direct-main-startup-'));
 t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const workspace=new WorkspaceState(folder,u=>u.startsWith('https://chatgpt.com/'));
 workspace.update(id,{url,account:'A',conversation_mode:'direct',closed:false});workspace.selected=id;workspace.save();
 const restored=new WorkspaceState(folder,u=>u.startsWith('https://chatgpt.com/')),guard={ready:false,protect:async()=>{},protectContents(){}},navigations=[],calls=[];
 class View{
  constructor(options){this.options=options;let current='about:blank';this.webContents=Object.assign(new EventEmitter(),{
   session:{},isDestroyed:()=>false,getURL:()=>current,setWindowOpenHandler(){},
   loadURL:async target=>{navigations.push(target);current=target;this.webContents.emit('did-navigate',{},target);},
   debugger:{isAttached:()=>true,sendCommand:async()=>({})}
  });}setBounds(){}setVisible(){}
 }
 const pool=new BrowserPool({window:{getContentSize:()=>[1200,800],contentView:{addChildView(){}}},WebContentsView:View,
  networkGuard:guard,partitionForAccount:account=>'persist:clw-account-'+account.toLowerCase(),allowedUrl:u=>u.startsWith('https://chatgpt.com/')});
 const source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
 const sandbox={workspace:restored,pool,guard,driver:null,taskStateRead:null,workspaceRestored:false,
  loaded:page=>!!page?.view,publish(){},savePages(){restored.capture(pool);restored.save();}};
 const first=source.indexOf('  for(const saved of workspace.tasks.values())'),firstEnd=source.indexOf('  nativePreviewPool=',first);
 assert.ok(first>0&&firstEnd>first);vm.runInNewContext(source.slice(first,firstEnd),sandbox);
 const originalPage=pool.pages.get(id);assert.equal(originalPage.url,url);
 const attempt='control_'+'a'.repeat(32),record={page_id:id,account:'A',url:'https://chatgpt.com/',phase:'bound',conversation_mode:'direct',paused:true,
  thread_id:'original-thread',latest_request:{id:'original-request',phase:'queued',attempt_id:attempt,sent_user_hash:null},
  attempt:{id:attempt,state:'dispatching',dispatched:1791713885.2374823,acknowledged:null}};
 const before=JSON.stringify(record),runtime=new EventEmitter();runtime.ready=true;
 runtime.call=async op=>{calls.push(op);assert.equal(op,'list','startup cannot bind, ACK, Send or resume');return {pages:[record]};};
 const callback=source.indexOf('        const onRecords=records=>'),callbackEnd=source.indexOf('        const approvals=',callback);
 assert.ok(callback>0&&callbackEnd>callback);
 vm.runInNewContext(source.slice(callback,callbackEnd)+'\nstartupOnRecords=onRecords;',sandbox);
 const driver=new WebDriver({runtime,pool,metadata:key=>restored.tasks.get(key)||{},onRecords:sandbox.startupOnRecords,onNotice(){},
  dom:async(wc,action)=>{assert.equal(action,'snapshot');return {url:wc.getURL(),editor:true,controlKnown:true,historyAtLatest:true,
   userId:'',assistantId:'',generating:false,draft:false,composing:false,complete:false};}});
 t.after(()=>driver.dispose());sandbox.driver=driver;pool.on('navigation',sandbox.savePages);
 await driver.restore();await Promise.allSettled([...driver.pageReconciliations.values()]);
 assert.equal(originalPage.url,url);assert.equal(originalPage.view,null);assert.deepEqual(navigations,[]);
 guard.ready=true;
 const second=source.indexOf('  if(guard.ready){\n    const saved=');
 const fallbackSecond=second<0?source.indexOf('  if(guard.ready){\r\n    const saved='):second;
 const secondEnd=source.indexOf('  workspaceRestored=true;publish();',fallbackSecond);
 assert.ok(fallbackSecond>0&&secondEnd>fallbackSecond);
 await vm.runInNewContext('(async()=>{'+source.slice(fallbackSecond,secondEnd)+'})()',sandbox);
 await Promise.allSettled([...driver.pageReconciliations.values()]);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(navigations,[url]);assert.equal(pool.pages.get(id),originalPage);assert.equal(originalPage.view.webContents.getURL(),url);
 assert.equal(restored.tasks.get(id).url,url);assert.equal(restored.tasks.get(id).boundUrl,null);assert.equal(JSON.stringify(record),before);
 assert.equal(new WorkspaceState(folder,u=>u.startsWith('https://chatgpt.com/')).tasks.get(id).url,url);assert.ok(calls.every(op=>op==='list'));
});


const home='https://chatgpt.com/',manualUrl='https://chatgpt.com/c/manual';
const idle=(current=home)=>({url:current,editor:true,controlKnown:true,historyAtLatest:true,
 generating:false,draft:false,composing:false,approvalRequired:false,loginRequired:false,blocked:false,accessLimited:false,complete:false,
 userId:'',assistantId:'',userText:'',publicText:'',html:'',failure:'',attemptMarker:null,bootstrapMarker:null,attemptMarkerCount:0,bootstrapMarkerCount:0});
function refreshFixture(t,{phase=null,current=home,manual=false}={}){
 const navigations=[],reloads=[],calls=[],snapshot=idle(current),hooks={};let location=current;
 const wc=Object.assign(new EventEmitter(),{getURL:()=>location,isDestroyed:()=>false,setWindowOpenHandler(){},
  loadURL:async target=>{navigations.push(target);location=target;},reload:()=>reloads.push(location)});
 const page={id,account:'A',paused:true,documentGeneration:1,manualControl:manual,manualUrl:manual?current:null,view:{webContents:wc}};
 const record={page_id:id,thread_id:'original-thread',phase:'bound',url,account:'A',paused:true,
  ...(phase?{latest_request:{id:'original-request',phase,attempt_id:'original-attempt'}}:{})};
 const runtime=new EventEmitter();runtime.call=async(op,args)=>{calls.push([op,args]);assert.fail('refresh cannot bind, ACK, Send or change a request');};
 const pool=new BrowserPool({networkGuard:{ready:true},allowedUrl:value=>value.startsWith('https://chatgpt.com/'),
  accountAccessFor:()=>({assertCanStart(){},admitNavigation:async()=>hooks.admission?.()})});
 pool.pages.set(id,page);pool.selected=id;
 const driver=new WebDriver({runtime,pool,dom:async()=>{await hooks.snapshot?.();return {...snapshot};},onNotice(){}});driver.records.set(id,record);
 t.after(()=>driver.dispose());
 return {driver,pool,page,record,wc,snapshot,hooks,navigations,reloads,calls,setLocation(value){location=value;snapshot.url=value;}};
}

test('explicit refresh keeps the idle visible homepage instead of navigating to its old binding',async t=>{
 const f=refreshFixture(t),before=JSON.stringify(f.record);const result=await f.driver.refresh(f.page);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[home]);assert.equal(f.wc.getURL(),home);
 assert.equal(JSON.stringify(f.record),before);assert.deepEqual(f.calls,[]);assert.equal(f.page.paused,true);assert.equal(f.pool.selected,id);
 assert.match(result.message,/刷新/);assert.doesNotMatch(result.message,/返回原对话/);
});

for(const phase of ['processing','suspended','unknown'])test('a protected '+phase+' original does not make refresh return to its older conversation',async t=>{
 const f=refreshFixture(t,{phase}),before=JSON.stringify(f.record);
 await assert.rejects(f.driver.refresh(f.page),/回执待核对/);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[]);assert.equal(JSON.stringify(f.record),before);assert.deepEqual(f.calls,[]);
});

for(const phase of ['processing','suspended','unknown','blocked'])test('manual browsing another chat can refresh it despite the old '+phase+' task',async t=>{
 const f=refreshFixture(t,{phase,current:manualUrl,manual:true}),before=JSON.stringify(f.record);
 await f.driver.refresh(f.page);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[manualUrl]);assert.equal(f.wc.getURL(),manualUrl);
 assert.equal(JSON.stringify(f.record),before);assert.deepEqual(f.calls,[]);assert.equal(f.page.manualControl,true);
});

for(const kind of ['draft','composing','generating','unknown','approval','pending','result','approvalBusy','account'])
 test('manual current-page refresh still refuses actual '+kind+' ownership or unsafe DOM',async t=>{
  const f=refreshFixture(t,{phase:'unknown',current:manualUrl,manual:true});
  if(kind==='draft'||kind==='composing'||kind==='generating'||kind==='unknown')f.snapshot[kind]=true;
  if(kind==='approval')f.snapshot.approvalRequired=true;
  if(kind==='pending')f.driver.pending.set(id,{attempt:'accepted-original',state:'unknown'});
  if(kind==='result')f.driver.resultCandidates.set('original-attempt',{state:'collecting'});
  if(kind==='approvalBusy')f.driver.approvals={busy:new Set([id])};
  if(kind==='account')f.page.account='B';
  const before=JSON.stringify(f.record);await assert.rejects(f.driver.refresh(f.page));
  assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[]);assert.equal(JSON.stringify(f.record),before);assert.deepEqual(f.calls,[]);
 });

for(const change of ['pending','request','visible-url','account','generation','renderer','connection'])
 test('manual refresh checks late '+change+' changes after navigation admission',async t=>{
  const f=refreshFixture(t,{phase:'suspended',current:manualUrl,manual:true}),before=JSON.stringify(f.record);
  f.hooks.admission=async()=>{
   if(change==='pending')f.driver.pending.set(id,{original:'accepted',state:'unknown'});
   if(change==='request')f.driver.records.set(id,{...f.record,latest_request:{...f.record.latest_request,id:'different'}});
   if(change==='visible-url')f.setLocation('https://chatgpt.com/c/later-manual');
   if(change==='account')f.page.account='B';
   if(change==='generation')f.page.documentGeneration++;
   if(change==='renderer')f.page.view={webContents:{}};
   if(change==='connection')f.driver.connectionGeneration++;
  };
  await assert.rejects(f.driver.refresh(f.page),/状态已变化/);
  assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[]);assert.equal(JSON.stringify(f.record),before);assert.deepEqual(f.calls,[]);
 });

for(const input of [{type:'keyDown',key:'F5'},{type:'keyDown',key:'r',control:true},{type:'keyDown',key:'R',meta:true}])
 test('original browser '+input.key+' refresh shortcut keeps the manual chat through the no-send dispatcher',async t=>{
  const f=refreshFixture(t,{phase:'suspended',current:manualUrl,manual:true}),before=JSON.stringify(f.record);let prevented=0,refresh;
  f.pool.bindView(f.page,f.page.view,'persist:fixture');
  f.pool.on('refresh-requested',({id:target})=>{assert.equal(target,id);refresh=f.driver.refresh(f.page);});
  f.wc.emit('before-input-event',{preventDefault(){prevented++;}},input);
  await refresh;assert.equal(prevented,1);assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[manualUrl]);
  assert.equal(JSON.stringify(f.record),before);assert.deepEqual(f.calls,[]);
 });

test('new runtime bindings are published before a page can be restored or inspected',async()=>{
 const runtime=new EventEmitter();runtime.ready=true;const record={page_id:id,phase:'bound',url,paused:true};
 runtime.call=async op=>{assert.equal(op,'list');return {pages:[record]};};
 const steps=[],pages=new Map();
 const driver=new WebDriver({runtime,onRecords:records=>{steps.push('binding');assert.deepEqual(records,[record]);},
  pool:{pages,create:async(_id,target)=>{steps.push('restore');assert.equal(target,url);pages.set(_id,{id:_id,view:{webContents:{isDestroyed:()=>false}}});}},onNotice(){}});
 driver.tick=async()=>{steps.push('inspect');};await driver.reconcileAll();assert.deepEqual(steps,['binding','restore','inspect']);driver.dispose();
});

test('accepted direct reading ownership survives a missing record but does not override a later request or account',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-direct-reading-missing-')),state=new WorkspaceState(folder,()=>true);
 t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));const attempt='control_'+'a'.repeat(32);
 const record={page_id:id,account:'A',phase:'bound',conversation_mode:'direct',url:home,
  latest_request:{id:'original-request',phase:'queued',attempt_id:attempt},attempt:{id:attempt,state:'dispatching',dispatched:123}};
 const records=new Map([[id,record]]);state.update(id,{url,account:'A'},record);
 for(const rows of [undefined,new Map(),new Map([[id,{page_id:id,account:'A'}]])]){
  state.capture({selected:id,inspect:()=>[{id,account:'A',url:home}]},rows);
  assert.equal(state.tasks.get(id).url,url);assert.equal(state.tasks.get(id).visibleUrl,home);
 }
 assert.equal(restoreConversationUrl({...record,latest_request:{...record.latest_request,id:'another-request'}},state.tasks.get(id)),home);
 assert.equal(restoreConversationUrl({...record,latest_request:{...record.latest_request,attempt_id:'control_'+'b'.repeat(32)},
  attempt:{...record.attempt,id:'control_'+'b'.repeat(32)}},state.tasks.get(id)),home);
 assert.equal(restoreConversationUrl(record,{...state.tasks.get(id),account:'B'}),home);
 state.capture({selected:id,inspect:()=>[{id,account:'B',url:home}]},records);
 assert.equal(state.tasks.get(id).url,home);assert.equal('readingRequestId' in state.tasks.get(id),false);assert.equal('readingAttemptId' in state.tasks.get(id),false);
});

test('a blocked record with no executing turn refreshes the visible homepage without reviving its task',async t=>{
 const f=refreshFixture(t,{phase:'blocked'}),before=JSON.stringify(f.record);await f.driver.refresh(f.page);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[home]);assert.equal(JSON.stringify(f.record),before);assert.deepEqual(f.calls,[]);
});


test('a user-selected original direct reply remains publicly readable without navigation, ACK or Send',async t=>{
 const attempt='control_'+'a'.repeat(32),marker='[CLW:'+attempt+']',f=refreshFixture(t,{current:url});
 const record={page_id:id,thread_id:'original-thread',account:'A',phase:'bound',url:home,conversation_mode:'direct',paused:true,
  latest_request:{id:'original-request',phase:'queued',attempt_id:attempt,sent_user_hash:null},
  attempt:{id:attempt,state:'dispatching',dispatched:123,acknowledged:null}};
 const before=JSON.stringify(record);f.driver.records.set(id,record);Object.assign(f.snapshot,{url,userId:'original-user',assistantId:'original-assistant',
  attemptMarker:marker,attemptMarkerCount:1,complete:true});
 const actions=[];f.driver.dom=async(_wc,action)=>{
  actions.push(action);if(action==='connector-state')return {text:'',editorCount:1,required:false};
  assert.equal(action,'snapshot');return {...f.snapshot};
 };
 const observed=await f.driver.observeTask(f.page);
 assert.equal(observed.url,url);assert.equal(observed.snapshot.attemptMarker,marker);
 assert.equal(observed.user_turn_sha256,require('node:crypto').createHash('sha256').update('original-user').digest('hex'));
 assert.deepEqual(actions,['snapshot','connector-state']);assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[]);assert.deepEqual(f.calls,[]);
 assert.equal(JSON.stringify(record),before);assert.equal(f.driver.pending.size,0);assert.equal(f.driver.completed.size,0);
});
