'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WebDriver}=require('../web-driver.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const {createHash}=require('node:crypto'),ATTEMPT='control_'+'d'.repeat(32);
const hash=value=>createHash('sha256').update(value||'').digest('hex');
function fixture(){
 const r={page_id:'original',thread_id:'original-thread',phase:'bound',url:'https://chatgpt.com/c/original',model:'gpt-6 · 最新',effort:'pro',model_selection:{selection:['最新']},
  latest_request:{id:'original-request',phase:'queued',cancel_requested:0,attempt_id:null}};
 const p={id:r.page_id,modelRestorePending:true,documentGeneration:1,view:{webContents:{getURL:()=>r.url}}};
 const calls=[],runtime=new EventEmitter();let state='offer',prepared;
 runtime.call=async(op,args)=>{
  calls.push([op,args]);
  if(op==='wire'&&args.data.action==='pulse')return {state,attempt_id:ATTEMPT,request_id:r.latest_request.id};
  if(op==='wire'&&args.data.action==='dispatch')return {dispatch:true,attempt_id:ATTEMPT,prompt:'original goal'};
  if(op==='prepare'){prepared={attempt_id:args.attempt_id,previous_user_hash:hash(snapshot.userId),
   assistant_before_hash:args.assistant_before_hash,prompt_hash:args.prompt_hash};return {prepared:true};}
  if(op==='list')return {pages:[{...r,latest_request:{...r.latest_request,attempt_id:ATTEMPT}}]};
  if(op==='view')return {page_id:r.page_id,thread_id:r.thread_id,latest_request:{...r.latest_request,attempt_id:ATTEMPT},
   request:{id:r.latest_request.id,phase:r.latest_request.phase,cancel_requested:0},
   attempt:{id:ATTEMPT,state:'dispatching',dispatched:123,acknowledged:null}};
  if(op==='prepared')return prepared;
  return {};
 };
 let snapshot={url:r.url,editor:true,controlKnown:true,userId:'before',assistantId:'before-reply',effortLabel:'Pro'};
 const d=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},dom:async(_wc,op)=>{assert.equal(op,'snapshot');return {...snapshot};}});
 d.inspect=async()=>{calls.push(['inspect']);const selected={model:'GPT-6 · 最新',effort:snapshot.effortLabel};p.modelSelection=selected;return selected;};
 d.selectModel=async()=>assert.fail('a restored offer may observe but cannot change the public model');
 d.records.set(p.id,r);
 d.send=async(_p,prompt,_s,marker)=>{calls.push(['send',prompt]);assert.equal(marker,'[CLW:'+ATTEMPT+']');return {...snapshot,userId:'actual-turn',userText:prompt};};
 return {d,r,p,calls,snapshot,setState:x=>state=x};
}
test('first unsent offer after reload observes matching public Pro and sends the same original attempt once',async()=>{
 const f=fixture();await f.d.tick(f.r);
 assert.deepEqual(f.calls.map(c=>c[0]),['wire','inspect','wire','prepare','list','view','prepared','send','wire']);
 assert.equal(f.calls[2][1].data.page.model_label,'GPT-6 · 最新');assert.equal(f.calls[2][1].data.page.effort_label,'Pro');
 assert.equal(f.calls[2][1].data.attempt_id,ATTEMPT);assert.equal(f.snapshot.effortLabel,'Pro');assert.deepEqual(f.p.modelSelection,{model:'GPT-6 · 最新',effort:'Pro'});
});
test('paused, idle and uncertain sends never restore controls or issue another Send',async()=>{
 for(const state of ['paused','idle_or_old_request_not_adopted','original_attempt_requires_reconciliation','model_received_browser_confirmation_pending']){
  const f=fixture();f.setState(state);f.snapshot.userText='earlier unrelated turn';
  await f.d.tick({...f.r,paused:state==='paused'});
  assert.ok(!f.calls.some(c=>['select','send','prepare'].includes(c[0])));assert.equal(f.p.modelRestorePending,true);
 }
});
test('an editor arriving before conversation history waits without offering, changing models or spending retries',async()=>{
 const f=fixture();f.snapshot.userId='';f.snapshot.assistantId='';await f.d.tick(f.r);
 assert.deepEqual(f.calls,[]);assert.equal(f.p.observation.editorReady,true);assert.equal(f.p.observation.historyReady,false);assert.equal(f.d.failures.size,0);
 f.snapshot.userId='before';f.snapshot.assistantId='before-reply';await f.d.tick(f.r);
 assert.equal(f.calls.filter(c=>c[0]==='send').length,1);assert.equal(f.p.observation.historyReady,true);
});
test('a draft or another navigation appearing during model observation prevents dispatch',async()=>{
 for(const reason of ['draft','navigation']){
  const f=fixture(),inspect=f.d.inspect;
  f.d.inspect=async(...args)=>{const selected=await inspect(...args);if(reason==='draft')f.snapshot.draft=true;else f.p.documentGeneration++;return selected;};
  await f.d.tick(f.r);assert.ok(!f.calls.some(c=>c[0]==='send'||c[1]?.data?.action==='dispatch'));
  assert.equal(f.p.modelRestorePending,true);
 }
});
test('a changed public model never restores the saved model or dispatches with a fallback',async()=>{
 const f=fixture();f.snapshot.effortLabel='High';
 await f.d.tick(f.r);assert.ok(!f.calls.some(c=>c[0]==='send'||c[1]?.data?.action==='dispatch'));
 assert.equal(f.calls.filter(c=>c[0]==='page-issue').length,1);assert.equal(f.calls.find(c=>c[0]==='page-issue')[1].kind,'model_mismatch');assert.equal(f.d.failures.size,0);assert.equal(f.snapshot.effortLabel,'High');
 assert.equal(f.p.modelRestorePending,true);
});
test('known login or quota stop preserves only that page while an independent Extra High branch sends',async()=>{
 for(const fault of ['login','quota']){
  const bad=fixture(),good=fixture();good.r.effort='极高';good.snapshot.effortLabel='极高';
  if(fault==='login')bad.snapshot.loginRequired=true;else bad.snapshot.usageLimited=true;
  await Promise.all([bad.d.tick(bad.r),good.d.tick(good.r)]);
  assert.equal(bad.calls.filter(c=>c[0]==='page-issue').length,1);assert.ok(!bad.calls.some(c=>c[0]==='send'||c[1]?.data?.action==='dispatch'));
  assert.equal(good.calls.filter(c=>c[0]==='send').length,1);
 }
});
test('authentication redirects report once even before a composer or conversation history exists',async()=>{
 const f=fixture();f.p.view.webContents.getURL=()=> 'https://auth.openai.com/login';await f.d.tick(f.r);
 assert.deepEqual(f.calls.map(c=>c[0]),['page-issue']);await f.d.tick({...f.r,paused:true,issue_kind:'login_required'});assert.equal(f.calls.length,1);
});
test('only a new main document invalidates the restored picker, not subframes or history navigation',async()=>{
 class View{constructor(){this.webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){},loadURL:async()=>{},isDestroyed:()=>false});}setBounds(){}setVisible(){}}
 const pool=new BrowserPool({window:{getContentSize:()=>[1440,960],contentView:{addChildView(){}}},WebContentsView:View,allowedUrl:()=>true});
 const page=await pool.create('original');assert.equal(page.modelRestorePending,true);page.modelRestorePending=false;
 page.view.webContents.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});assert.equal(page.modelRestorePending,false);
 page.view.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});assert.equal(page.modelRestorePending,false);
 page.view.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});assert.equal(page.modelRestorePending,true);assert.equal(page.documentGeneration,1);
});
