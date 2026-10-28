'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const id='original',url='https://chatgpt.com/c/original';
const failureHome=()=>({url:'https://chatgpt.com/',pageLoadFailure:'account_load_failed',editor:false,controlKnown:false,
 readiness:{knownEditors:{visibleCount:0},editableAlternatives:{visibleCount:0}},
 generating:false,draft:false,composing:false,approvalRequired:false,loginRequired:false,blocked:false,accessLimited:false,complete:false,
 userId:'',assistantId:'',userText:'',publicText:'',html:'',failure:'',attemptMarker:null,bootstrapMarker:null,attemptMarkerCount:0,bootstrapMarkerCount:0});
function fixture(phase='suspended',{bound=true,manual=bound}={}){
 let current='https://chatgpt.com/';const navigations=[],reloads=[];
 const wc={getURL:()=>current,isDestroyed:()=>false,loadURL:async target=>{current=target;navigations.push(target);},reload:()=>reloads.push(current)};
 const page={id,account:'A',manualControl:manual,manualUrl:manual?current:null,documentGeneration:1,view:{webContents:wc}},runtime=new EventEmitter();
 runtime.call=()=>assert.fail('refresh cannot send or change business state');
 const record={page_id:id,thread_id:bound?'original-thread':null,phase:bound?'bound':'reserved',url:bound?url:current,account:'A',paused:true,
  ...(bound?{latest_request:{id:'original-request',phase,attempt_id:'original-attempt'}}:{bootstrap_state:'pending'})};
 const pool=new BrowserPool({networkGuard:{ready:true},allowedUrl:()=>true});pool.pages.set(id,page);pool.selected=id;
 const driver=new WebDriver({runtime,pool,dom:async()=>failureHome(),onNotice(){}});driver.records.set(id,record);
 return {page,record,pool,driver,navigations,reloads};
}
for(const phase of ['processing','suspended','unknown','blocked'])test('explicit account-load refresh keeps the manually selected homepage with original '+phase+' receipt unchanged',async()=>{
 const f=fixture(phase),before=JSON.stringify(f.record);await f.driver.refresh(f.page);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,['https://chatgpt.com/']);assert.equal(JSON.stringify(f.record),before);
});
test('an unsent reservation may reload its own verified account-error homepage',async()=>{
 const f=fixture(undefined,{bound:false});await f.driver.refresh(f.page);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,['https://chatgpt.com/']);
});
test('account-error code cannot erase ambiguous page state or a live turn',async()=>{
 const changes=[{pageLoadFailure:undefined},{pageLoadFailure:'other'}, {url:'https://chatgpt.com/c/another'},
  {editor:true},{controlKnown:true},{generating:true},{draft:true},{composing:true},{approvalRequired:true},{loginRequired:true},
  {blocked:true},{accessLimited:true},{complete:true},{userId:'user'},{assistantId:'assistant'},{publicText:'reply'},
  {html:'reply'},{userText:'body'},{failure:'platform failure'},{attemptMarker:'original'},{attemptMarkerCount:1},
  {bootstrapMarker:'original'},{bootstrapMarkerCount:1},{unknown:true},{error:'unknown'},{known:false},{generating:undefined},
  {readiness:undefined},{readiness:{knownEditors:{visibleCount:2},editableAlternatives:{visibleCount:0}}},
  {readiness:{knownEditors:{visibleCount:0},editableAlternatives:{visibleCount:1}}}];
 for(const change of changes){const f=fixture();f.driver.dom=async()=>({...failureHome(),...change});
  await assert.rejects(f.driver.refresh(f.page));assert.deepEqual(f.navigations,[],JSON.stringify(change));assert.deepEqual(f.reloads,[]);}
});
test('local submission and collected-result ownership still refuse account-error reload',async()=>{
 for(const kind of ['pending','result']){const f=fixture();
  if(kind==='pending')f.driver.pending.set(id,{accepted:true});else f.driver.resultCandidates.set('original-attempt',{});
  await assert.rejects(f.driver.refresh(f.page));assert.deepEqual(f.navigations,[]);}
});
test('late request, URL, document, renderer or submission change cancels account-error navigation',async()=>{
 for(const kind of ['request','url','document','renderer','pending']){const f=fixture(),before=JSON.stringify(f.record);
  f.pool.accountAccessFor=()=>({assertCanStart(){},admitNavigation:async()=>{
   if(kind==='request')f.driver.records.set(id,{...f.record,latest_request:{...f.record.latest_request,id:'changed'}});
   if(kind==='url')f.page.view.webContents.getURL=()=> 'https://chatgpt.com/c/changed';
   if(kind==='document')f.page.documentGeneration++;
   if(kind==='renderer')f.page.view={webContents:{}};
   if(kind==='pending')f.driver.pending.set(id,{accepted:true});
  }});
  await assert.rejects(f.driver.refresh(f.page));assert.deepEqual(f.navigations,[],kind);assert.equal(JSON.stringify(f.record),before);
 }
});

for(const phase of ['processing','suspended','unknown'])test('account-load failure does not navigate or refresh a protected '+phase+' original automatically',async()=>{
 const f=fixture(phase,{manual:false}),before=JSON.stringify(f.record);await assert.rejects(f.driver.refresh(f.page),/回执待核对/);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,[]);assert.equal(JSON.stringify(f.record),before);
});

test('a blocked record without an active turn may refresh the current account-error homepage without returning to its binding',async()=>{
 const f=fixture('blocked',{manual:false}),before=JSON.stringify(f.record);await f.driver.refresh(f.page);
 assert.deepEqual(f.navigations,[]);assert.deepEqual(f.reloads,['https://chatgpt.com/']);assert.equal(JSON.stringify(f.record),before);
});
