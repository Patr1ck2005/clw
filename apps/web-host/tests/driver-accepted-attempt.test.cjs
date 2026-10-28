'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createHash}=require('node:crypto'),{WebDriver}=require('../web-driver.cjs');
const hash=value=>createHash('sha256').update(value||'').digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const URL='https://chatgpt.com/c/original',ATTEMPT='control_'+'a'.repeat(32),OLD='control_'+'b'.repeat(32);
const marker='[CLW:'+ATTEMPT+']',body='完整开发、接线和实际验证。',prompt=body+'\n'+marker;
function fixture({recovery=false,direct=false,onQuery,onHost,sendError=false,connectorError=false}={}){
  const record={page_id:'original',thread_id:'original-thread',account:'A',url:direct?'https://chatgpt.com/':URL,phase:'bound',root:direct?'':'D:/original',
    ...(direct?{conversation_mode:'direct',collaboration_enabled:false}:{}),
    model:'gpt-6 · latest',effort:'pro',access:'full',write_paths:['.'],collaboration_protocol:'tool_v1',
    bootstrap_state:'sent',first_turn_mode:'task_v1',
    paused:false,own_paused:false,latest_request:{id:'original-request',phase:recovery?'processing':'queued',
      cancel_requested:0,attempt_id:recovery?OLD:null}};
  const accepted=clone(record);accepted.latest_request.attempt_id=ATTEMPT;
  const baseline={url:record.url,userId:direct?'':'original-user',assistantId:direct?'':'original-answer'};
  const view={page_id:record.page_id,thread_id:record.thread_id,latest_request:clone(accepted.latest_request),
    request:{id:record.latest_request.id,phase:record.latest_request.phase,cancel_requested:0},
    attempt:{id:ATTEMPT,state:'dispatching',dispatched:123,acknowledged:null}};
  const prepared={attempt_id:ATTEMPT,previous_user_hash:hash(baseline.userId),
    assistant_before_hash:hash(baseline.assistantId),prompt_hash:hash(body)};
  let url=baseline.url,query=false,selected=false,inserted='',sends=0;
  const p={id:record.page_id,account:'A',documentGeneration:7,domReady:true,view:{webContents:{getURL:()=>url,isDestroyed:()=>false}}};
  const calls=[],runtime=new EventEmitter();runtime.ready=true;
  runtime.call=async(op,arg)=>{
    calls.push([op,arg]);await onHost?.(op,{record,accepted,view,prepared,p,driver});
    if(op==='list')return {pages:[clone(accepted)]};
    if(op==='view')return clone(view);
    if(op==='prepared')return clone(prepared);
    if(op==='prepare')return {prepared:true};
    if(op==='bind-direct'){assert.equal(arg.url,URL);accepted.url=arg.url;return {state:'bound',url:arg.url};}
    if(op==='wire'){
      if(arg.data.action==='pulse')return {state:'offer',attempt_id:ATTEMPT,request_id:record.latest_request.id};
      if(arg.data.action==='dispatch')return {dispatch:true,attempt_id:ATTEMPT,prompt:body};
      if(arg.data.action==='sent')return {state:'browser_result_pending'};
    }
    assert.fail('unexpected Host call '+op);
  };
  const driver=new WebDriver({runtime,pool:{pages:new Map([[p.id,p]]),running(){}},onNotice(){},sleep:async()=>{},
    dom:async(_wc,action)=>{
      calls.push([action]);
      if(action==='snapshot')return sends?{...baseline,url:direct?URL:baseline.url,userId:'new-user',draft:false,attemptMarker:marker,attemptMarkerCount:1}
        :{...baseline,editor:true,controlKnown:true,historyAtLatest:true,draft:query||!!inserted,generating:false,
          ...(direct?{composing:false,approvalRequired:false,loginRequired:false,blocked:false,accessLimited:false,complete:false,attemptMarkerCount:0,bootstrapMarkerCount:0}:{})};
      if(action==='connector-state')return {editorCount:1,text:query?'@Local-MCP':'',selected:selected?['Local-MCP']:[],
        visibleSelectedCount:selected?1:0,menuCount:query?1:0,exactRows:query?1:0,...(query&&connectorError?{exactRows:2}:{})};
      if(action==='connector-query'){
        query=true;await driver.readRecords();await onQuery?.({driver,p,record,accepted,view,prepared,setUrl:value=>{url=value;}});
        return {inserted:true};
      }
      if(action==='connector-select'){selected=true;query=false;return {activated:true};}
      if(action==='focus-editor')return {focused:true};
      if(action==='insert-plain-text'){inserted=prompt;return {inserted:true};}
      if(action==='editor-text')return {text:inserted};
      if(action==='send'){sends++;if(direct)url=URL;if(sendError)throw Object.assign(Error('lost Send reply'),{code:'send_baseline_changed'});return {};}
      assert.fail('unexpected DOM call '+action);
    }});
  driver.records.set(p.id,clone(record));
  driver.inspect=async()=>({model:record.model,effort:record.effort});
  const context=()=>driver.acceptedSendContext(p,baseline,{record,requestId:record.latest_request.id,attemptId:ATTEMPT,prompt:body});
  return {driver,p,record,accepted,view,prepared,baseline,calls,context,get sends(){return sends;},get query(){return query;}};
}
test('direct conversation sends from a real empty homepage baseline and binds its original receipt once',async()=>{
 const f=fixture({direct:true});try{
  await f.driver.tick(f.record);assert.equal(f.sends,1);
  assert.equal(f.driver.records.get(f.p.id).url,URL);assert.equal(f.driver.records.get(f.p.id).thread_id,f.record.thread_id);
  const bind=f.calls.findIndex(([op])=>op==='bind-direct'),sent=f.calls.findIndex(([op,p])=>op==='wire'&&p?.data.action==='sent');
  assert.ok(bind>=0&&sent>bind);assert.equal(f.calls.filter(([op])=>op==='bind-direct').length,1);
  assert.equal(f.calls[sent][1].data.attempt_id,ATTEMPT);assert.equal(f.calls.filter(([op])=>['reserve','bootstrap','enroll'].includes(op)).length,0);
 }finally{f.driver.dispose();}
});
for(const recovery of [false,true])test((recovery?'recovery':'initial')+' accepted attempt survives its own real readRecords refresh and Sends exactly once',async()=>{
  const f=fixture({recovery});try{
    const context=await f.context();const result=await f.driver.send(f.p,prompt,f.baseline,marker,context);
    assert.equal(result.userId,'new-user');assert.equal(f.sends,1);
    assert.equal(f.driver.records.get(f.p.id).latest_request.attempt_id,ATTEMPT);
    assert.equal(f.calls.filter(([op])=>op==='connector-query').length,1);
    assert.equal(f.calls.filter(([op])=>op==='connector-select').length,1);
    assert.equal(f.p.observation.sendPreparation.send_invoked,true);
    assert.equal(f.p.observation.sendPreparation.stage,'confirmed');
    assert.equal(f.driver.sendFailures.size,0);
  }finally{f.driver.dispose();}
});
for(const recovery of [false,true])test('normal '+(recovery?'recovery':'initial')+' observer dispatch uses the verified original grant and publishes its one receipt',async()=>{
  const f=fixture({recovery});try{
    await f.driver.tick(f.record);assert.equal(f.sends,1);
    const actions=f.calls.filter(([op])=>op==='wire').map(([,args])=>args.data.action);
    assert.deepEqual(actions,['pulse','dispatch','sent']);
    assert.equal(f.calls.filter(([op])=>op==='prepare').length,1);
    assert.equal(f.calls.filter(([op])=>op==='connector-query').length,1);
    assert.equal(f.driver.pending.get(f.p.id).attempt,ATTEMPT);
  }finally{f.driver.dispose();}
});
test('the accepted projection may already have arrived before the original Host proof completes',async()=>{
  const f=fixture({recovery:true,onHost:async(op,{accepted,driver,p})=>{
    if(op==='view')driver.records.set(p.id,clone(accepted));
  }});try{
    const context=await f.context();await f.driver.send(f.p,prompt,f.baseline,marker,context);assert.equal(f.sends,1);
  }finally{f.driver.dispose();}
});
test('the operator signature verifies the exact existing prepared hash without another dispatch',async()=>{
  const f=fixture({recovery:true});try{
    const context=await f.driver.acceptedSendContext(f.p,f.baseline,{request_id:f.record.latest_request.id,
      attempt_id:ATTEMPT,prompt_hash:hash(body)});
    await f.driver.send(f.p,prompt,f.baseline,marker,context);assert.equal(f.sends,1);
    assert.equal(f.calls.some(([op])=>op==='wire'||op==='prepare'),false);
  }finally{f.driver.dispose();}
});
for(const [name,change] of [
  ['changed body',()=>({prompt:'foreign body\n'+marker})],
  ['changed marker',()=>({prompt:body+'\n[CLW:'+OLD+']',marker:'[CLW:'+OLD+']'})],
  ['changed public user',f=>({baseline:{...f.baseline,userId:'foreign-user'}})],
  ['changed public assistant',f=>({baseline:{...f.baseline,assistantId:'foreign-answer'}})],
])test(name+' cannot consume an otherwise verified accepted context',async()=>{
  const f=fixture({recovery:true});try{
    const context=await f.context(),changed=change(f);
    await assert.rejects(f.driver.send(f.p,changed.prompt||prompt,changed.baseline||f.baseline,changed.marker||marker,context),
      error=>error.code==='send_attempt_identity_unverified'&&error.sendPreparation.send_invoked===false);
    assert.equal(f.sends,0);assert.equal(f.calls.some(([op])=>op==='connector-query'||op==='snapshot'),false);
  }finally{f.driver.dispose();}
});
for(const [name,change] of [
  ['foreign attempt',({driver,p})=>{driver.records.get(p.id).latest_request.attempt_id=OLD;}],
  ['foreign request',({driver,p})=>{driver.records.get(p.id).latest_request.id='foreign-request';}],
  ['foreign thread',({driver,p})=>{driver.records.get(p.id).thread_id='foreign-thread';}],
  ['foreign account',({p})=>{p.account='B';}],
  ['foreign binding account',({driver,p})=>{driver.records.get(p.id).account='B';}],
  ['foreign binding URL',({driver,p})=>{driver.records.get(p.id).url=URL+'-foreign';}],
  ['foreign document URL',({setUrl})=>setUrl(URL+'-foreign')],
  ['foreign root',({driver,p})=>{driver.records.get(p.id).root='D:/foreign';}],
  ['foreign permissions',({driver,p})=>{driver.records.get(p.id).write_paths=['foreign'];}],
  ['foreign model',({driver,p})=>{driver.records.get(p.id).model='foreign-model';}],
  ['foreign effort',({driver,p})=>{driver.records.get(p.id).effort='high';}],
  ['new document',({p})=>{p.documentGeneration++;}],
  ['new connection',({driver})=>{driver.connectionGeneration++;}],
  ['future pause',({driver,p})=>{driver.records.get(p.id).paused=true;}],
  ['request cancellation',({driver,p})=>{driver.records.get(p.id).latest_request.cancel_requested=1;}],
  ['unresumed page stop',({driver,p})=>{driver.records.get(p.id).observed_stop_user_hash='stopped';}],
  ['workspace stop',({driver})=>driver.stop()],
])test('late '+name+' remains rejected after self projection, retains query and records unknown identity',async()=>{
  const f=fixture({recovery:true,onQuery:change});try{
    const context=await f.context();
    await assert.rejects(f.driver.send(f.p,prompt,f.baseline,marker,context),error=>{
      assert.equal(error.notSent,undefined);assert.equal(error.sendPreparation.send_invoked,false);
      assert.equal(error.sendPreparation.known_not_sent,false);assert.equal(error.sendPreparation.attempt_id,ATTEMPT);
      return ['send_page_identity_changed','workspace_stopping'].includes(error.code);
    });
    assert.equal(f.sends,0);assert.equal(f.query,true);
    assert.equal(f.calls.some(([op])=>op==='connector-select'||op==='insert-plain-text'),false);
    assert.equal(f.driver.sendFailures.get(f.p.id).send_invoked,false);
  }finally{f.driver.dispose();}
});
test('self projection is monotonic and cannot regress to the earlier accepted attempt',async()=>{
  const f=fixture({recovery:true});try{
    const context=await f.context();context.requireOpen();
    f.driver.records.set(f.p.id,clone(f.accepted));context.requireOpen();
    f.driver.records.set(f.p.id,clone(f.record));assert.throws(context.requireOpen,error=>error.code==='send_page_identity_changed');
  }finally{f.driver.dispose();}
});
for(const [name,change] of [
  ['foreign Host binding',({accepted})=>{accepted.thread_id='foreign-thread';}],
  ['Host pause',({accepted})=>{accepted.paused=true;}],
  ['Host request cancel',({view})=>{view.request.cancel_requested=1;}],
  ['foreign Host request',({view})=>{view.latest_request.id='foreign-request';}],
  ['foreign Host attempt',({view})=>{view.attempt.id=OLD;}],
  ['already acknowledged',({view})=>{view.attempt.acknowledged=456;}],
  ['unknown dispatch',({view})=>{view.attempt.state='unknown';}],
  ['missing dispatch',({view})=>{view.attempt.dispatched=null;}],
  ['foreign prepared attempt',({prepared})=>{prepared.attempt_id=OLD;}],
  ['foreign prepared public user',({prepared})=>{prepared.previous_user_hash=hash('foreign-user');}],
  ['foreign prepared assistant',({prepared})=>{prepared.assistant_before_hash=hash('foreign-answer');}],
  ['foreign prepared body',({prepared})=>{prepared.prompt_hash=hash('foreign-body');}],
])test(name+' cannot verify an accepted send context',async()=>{
  const f=fixture({recovery:true});try{
    change(f);await assert.rejects(f.context(),error=>error.code==='send_attempt_identity_unverified');
    assert.equal(f.sends,0);assert.equal(f.calls.some(([op])=>op==='connector-query'),false);
  }finally{f.driver.dispose();}
});
test('foreign local attempt delivered during an awaited original Host read is rejected',async()=>{
  const f=fixture({recovery:true,onHost:async(op,{driver,p})=>{
    if(op==='view')driver.records.get(p.id).latest_request.attempt_id='control_'+'c'.repeat(32);
  }});try{
    await assert.rejects(f.context(),error=>error.code==='send_page_identity_changed');assert.equal(f.sends,0);
  }finally{f.driver.dispose();}
});
test('known connector preparation failure saves a fresh exact pre-click proof without retry or clearing query',async()=>{
  const f=fixture({recovery:true,connectorError:true});try{
    const context=await f.context();
    await assert.rejects(f.driver.send(f.p,prompt,f.baseline,marker,context),error=>{
      assert.equal(error.code,'connector_menu_not_unique');assert.equal(error.notSent,true);
      assert.equal(error.sendPreparation.send_invoked,false);assert.equal(error.sendPreparation.known_not_sent,true);
      assert.equal(error.sendPreparation.request_id,'original-request');return true;
    });
    assert.equal(f.sends,0);assert.equal(f.query,true);
    assert.equal(f.calls.filter(([op])=>op==='connector-query').length,1);
    assert.equal(f.calls.filter(([op])=>op==='view').length,2);
  }finally{f.driver.dispose();}
});
test('foreign Host change during pre-click proof cannot fabricate a known not-sent outcome',async()=>{
  let reads=0;const f=fixture({recovery:true,connectorError:true,onHost:async(op,{view})=>{
    if(op==='view'&&++reads===2)view.attempt.id=OLD;
  }});try{
    const context=await f.context();
    await assert.rejects(f.driver.send(f.p,prompt,f.baseline,marker,context),error=>{
      assert.equal(error.code,'connector_menu_not_unique');assert.equal(error.notSent,undefined);
      assert.equal(error.sendPreparation.send_invoked,false);assert.equal(error.sendPreparation.known_not_sent,false);return true;
    });assert.equal(f.sends,0);assert.equal(f.query,true);
  }finally{f.driver.dispose();}
});
test('an error from the unique actual Send is unknown and never triggers a second click or pre-click proof',async()=>{
  const f=fixture({recovery:true,sendError:true});try{
    const context=await f.context();
    await assert.rejects(f.driver.send(f.p,prompt,f.baseline,marker,context),error=>{
      assert.equal(error.notSent,undefined);assert.equal(error.sendPreparation.send_invoked,true);
      assert.equal(error.sendPreparation.known_not_sent,false);assert.equal(error.sendPreparation.stage,'send');return true;
    });assert.equal(f.sends,1);assert.equal(f.calls.filter(([op])=>op==='view').length,1);
  }finally{f.driver.dispose();}
});
