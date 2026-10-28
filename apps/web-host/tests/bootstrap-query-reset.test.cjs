'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {resetBootstrapQuery}=require('../bootstrap-query-reset.cjs');
const {WorkspaceState}=require('../workspace-state.cjs');
const {capabilities,assertControlIdentity,commandPayload,taskIdentity}=require('../app-control-identity.cjs');
const hash=text=>createHash('sha256').update(text).digest('hex');
const operation='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',nextOperation='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const pageId='web-cccccccc-cccc-4ccc-cccc-cccccccccccc',url='https://chatgpt.com/',root='D:/original-project';
function fixture({account='A',workspace}={}){
  const calls=[],hooks={},query=account==='A'?'@Local-MCP':'@Local-MCP-B';let intent;
  const page={id:pageId,account,root,documentGeneration:2,closed:false,
    view:{webContents:{getURL:()=>url,isDestroyed:()=>false}}};
  const row={page_id:pageId,target_id:'original-target',parent_target:'original-parent',root,title:'Original ACTORS',account,
    url,model:'GPT-6',effort:'Pro',phase:'reserved',bootstrap_state:'pending',paused:true,own_paused:true,
    thread_id:null,latest_request:null,issue_kind:'control_failed',attention:'original connector error',
    access:'write',write_paths:['Assets/Actors'],resources:['original-reservation'],collaboration_protocol:'tool_v1',
    first_turn_instructions:'Original substantial actors package',first_turn_mode:'prepare_v1',
    settings:'{"account":"'+account+'","first_turn_instructions":"Original actors package"}',bootstrap_text:'Original bootstrap body'};
  const snapshot={url,editor:true,controlKnown:true,historyAtLatest:null,complete:false,draft:true,
    generating:false,composing:false,approvalRequired:false,accessLimited:false,blocked:false,loginRequired:false,stopped:false,usageLimited:false,
    userId:'',assistantId:'',userText:'',publicText:'',html:'',failure:'',attemptMarker:null,attemptMarkerCount:0,bootstrapMarker:null,bootstrapMarkerCount:0};
  const composer={editorCount:1,text:query,selected:[],visibleSelectedCount:0,
    generating:false,composing:false,approvalRequired:false,accessLimited:false,blocked:false};
  const proof={eligible:true,code:'bootstrap_query_reset_eligible',page_id:pageId,account,root,
    phase:'reserved',bootstrap_state:'pending',thread_id:null,own_paused:true,issue_kind:'control_failed',budget_admitted:false,
    contract_sha256:hash('original-reservation')};
  const resetStore=workspace?{
    get:()=>workspace.tasks.get(pageId)?.bootstrapQueryReset,
    persist:value=>{workspace.update(pageId,{bootstrapQueryReset:value});workspace.save();}
  }:{get:()=>intent,persist:value=>{intent=structuredClone(value);hooks.persist?.(value);}};
  const driver={records:new Map([[pageId,row]]),recordsLoaded:true,busy:new Set(),pending:new Map(),bootstrapPrepared:new Map(),
    connectionGeneration:1,pool:{pages:new Map([[pageId,page]])},stopped:false,observationQuiesced:false,
    runtime:{ready:true,closed:false,call:async(op,payload)=>{
      calls.push(op);assert.equal(op,'bootstrap-query-reset-check');assert.deepEqual(payload,{page_id:pageId});
      await hooks.host?.(calls.filter(value=>value===op).length);return structuredClone(proof);
    }},
    dom:async(wc,action,arg)=>{
      calls.push(action);assert.equal(wc,page.view.webContents);await hooks[action]?.();
      if(action==='snapshot')return {...snapshot,draft:!!composer.text};
      if(action==='connector-state')return structuredClone(composer);
      assert.equal(action,'connector-clear-query');assert.equal(arg.reconciliationId,operation);
      assert.equal(arg.expectedConnector,query.slice(1));assert.equal(arg.expectedText,query);
      assert.deepEqual(arg.expectedBaseline,{url,userId:'',assistantId:''});
      composer.text='';return {cleared:true};
    }};
  const payload={id:pageId,expected_connection_generation:4,expected_query_sha256:hash(query)};
  const run=(op=operation)=>resetBootstrapQuery({driver,page,payload,operationId:op,resetStore,assertCurrent(){hooks.identity?.();}});
  return {driver,page,row,payload,query,composer,snapshot,proof,resetStore,calls,hooks,run,
    get clears(){return calls.filter(value=>value==='connector-clear-query').length;}};
}

for(const account of ['A','B'])test('operator reset clears only the exact '+account+' query and preserves the paused original reservation',async()=>{
  const f=fixture({account}),before=structuredClone(f.row),result=await f.run();
  assert.equal(result.state,'bootstrap_query_cleared');assert.equal(result.model_sends,0);
  assert.equal(result.original_reservation_preserved,true);assert.equal(result.paused,true);assert.equal(result.issue_preserved,true);
  assert.equal(f.clears,1);assert.equal(f.composer.text,'');assert.deepEqual(f.row,before);assert.equal(f.driver.busy.size,0);
  assert.equal(f.resetStore.get().state,'cleared');assert.equal(f.resetStore.get().operation_id,operation);
  assert.equal(f.calls.filter(value=>value==='bootstrap-query-reset-check').length,3);
  assert.equal(f.calls.some(value=>['bootstrap','send','resume','page-issue'].includes(value)),false);
});

const recordChanges={
  'bound task':row=>{row.phase='bound';},'already admitted bootstrap':row=>{row.bootstrap_state='sending';},
  'unpaused reservation':row=>{row.own_paused=false;},'thread binding':row=>{row.thread_id='original-thread';},
  'latest request':row=>{row.latest_request={id:'original-request',phase:'queued'};},
  'different issue':row=>{row.issue_kind='bootstrap_receipt_missing';},
  'unresumed stop':row=>{row.observed_stop_user_hash='user-stopped';},'handoff':row=>{row.successor='other-page';}
};
for(const [name,change]of Object.entries(recordChanges))test('reset refuses '+name+' without touching a query',async()=>{
  const f=fixture();change(f.row);await assert.rejects(f.run(),error=>error.accepted===false);
  assert.equal(f.clears,0);assert.equal(f.composer.text,f.query);assert.equal(f.resetStore.get(),undefined);
});

for(const [name,change]of Object.entries({
  'wrong account query':f=>{f.composer.text='@Local-MCP-B';},'same prefix user draft':f=>{f.composer.text=f.query+' my draft';},
  'leading whitespace':f=>{f.composer.text=' '+f.query;},'extra newline':f=>{f.composer.text=f.query+'\n';},
  'selected app':f=>{f.composer.selected=['Local-MCP'];f.composer.visibleSelectedCount=1;},
  'multiple editors':f=>{f.composer.editorCount=2;},'generating':f=>{f.snapshot.generating=true;},
  'IME composition':f=>{f.composer.composing=true;},'approval':f=>{f.snapshot.approvalRequired=true;},
  'login':f=>{f.snapshot.loginRequired=true;},'old user baseline':f=>{f.snapshot.userId='original-user';},
  'old assistant baseline':f=>{f.snapshot.assistantId='original-assistant';},'existing marker':f=>{f.snapshot.bootstrapMarker='[CLW:original]';},
  'unknown snapshot':f=>{delete f.snapshot.controlKnown;},'operator SHA mismatch':f=>{f.payload.expected_query_sha256=hash('foreign');}
}))test('reset preserves '+name,async()=>{
  const f=fixture();change(f);const text=f.composer.text;
  await assert.rejects(f.run(),error=>error.accepted===false);assert.equal(f.clears,0);assert.equal(f.composer.text,text);
  assert.equal(f.resetStore.get(),undefined);assert.equal(f.driver.busy.size,0);
});

for(const change of ['budget','eligible','account','root','contract'])test('fresh Host '+change+' rejects before clearing',async()=>{
  const f=fixture();f.hooks.host=n=>{if(n!==2)return;
    if(change==='budget')f.proof.budget_admitted=true;if(change==='eligible')f.proof.eligible=false;
    if(change==='account')f.proof.account='B';if(change==='root')f.proof.root='foreign-root';
    if(change==='contract')f.proof.contract_sha256=hash('foreign-reservation');};
  await assert.rejects(f.run(),error=>error.accepted===false);assert.equal(f.clears,0);assert.equal(f.resetStore.get(),undefined);
});

for(const change of ['first-task','write-paths','document','view','pool-page','runtime','connection'])
  test('an async '+change+' change keeps the original query',async()=>{
    const f=fixture();f.hooks.host=n=>{if(n!==1)return;
      if(change==='first-task')f.row.first_turn_instructions='Another task';
      if(change==='write-paths')f.driver.records.set(pageId,{...f.row,write_paths:['Other']});
      if(change==='document')f.page.documentGeneration++;
      if(change==='view')f.page.view={webContents:f.page.view.webContents};
      if(change==='pool-page')f.driver.pool.pages.set(pageId,{...f.page});
      if(change==='runtime')f.driver.runtime={...f.driver.runtime};
      if(change==='connection')f.driver.connectionGeneration++;};
    await assert.rejects(f.run(),error=>error.accepted===false);assert.equal(f.clears,0);assert.equal(f.composer.text,f.query);
  });

test('no browser mutation occurs until the pending intent is durably saved',async()=>{
  const f=fixture();f.hooks.persist=()=>{throw Error('disk_unavailable');};
  await assert.rejects(f.run(),error=>error.accepted===false);assert.equal(f.clears,0);assert.equal(f.composer.text,f.query);
  assert.equal(f.resetStore.get().state,'pending');
});
test('an asynchronous persistence adapter is never treated as a flush acknowledgement',async()=>{
  const f=fixture();f.resetStore.persist=async()=>{};
  await assert.rejects(f.run(),/persistence_unconfirmed/);assert.equal(f.clears,0);
});
test('an unknown clear result keeps the original pending operation and blocks every second clear',async()=>{
  const f=fixture();f.hooks['connector-clear-query']=()=>{throw Error('page_input_unknown');};
  await assert.rejects(f.run(),error=>error.code==='bootstrap_query_clear_unknown'&&error.accepted===true);
  assert.equal(f.clears,1);const original=structuredClone(f.resetStore.get());
  await assert.rejects(f.run(),/original_operation_requires_reconciliation/);
  await assert.rejects(f.run(nextOperation),/original_operation_requires_reconciliation/);
  assert.equal(f.clears,1);assert.deepEqual(f.resetStore.get(),original);
});
test('a changed Host contract after clearing retains pending and never grants resume',async()=>{
  const f=fixture();f.hooks.host=n=>{if(n===3)f.proof.contract_sha256=hash('changed-after-clear');};
  await assert.rejects(f.run(),error=>error.code==='bootstrap_query_clear_unknown'&&error.accepted===true);
  assert.equal(f.clears,1);assert.equal(f.resetStore.get().state,'pending');assert.equal(f.row.paused,true);assert.equal(f.row.issue_kind,'control_failed');
});
test('a failed final flush restores the pending intent and blocks a new operation',async()=>{
  const f=fixture();f.hooks.persist=value=>{if(value.state==='cleared')throw Error('disk_unavailable');};
  await assert.rejects(f.run(),error=>error.accepted===true);assert.equal(f.clears,1);assert.equal(f.resetStore.get().state,'pending');
  await assert.rejects(f.run(nextOperation),/original_operation_requires_reconciliation/);assert.equal(f.clears,1);
});

test('a real atomic WorkspaceState reload retains an unknown reset even with a different operation key',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-bootstrap-reset-'));
  assert.equal(path.dirname(folder),path.resolve(os.tmpdir()));
  try{
    const first=new WorkspaceState(folder,value=>value===url);first.update(pageId,{account:'A',root,url,originalField:'preserved'});first.save();
    const f=fixture({workspace:first});f.hooks['connector-clear-query']=()=>{throw Error('page_input_unknown');};
    await assert.rejects(f.run(),/clear_unknown/);
    const second=new WorkspaceState(folder,value=>value===url),g=fixture({workspace:second});
    const bytes=fs.readFileSync(second.file);await assert.rejects(g.run(nextOperation),/original_operation_requires_reconciliation/);
    assert.equal(g.clears,0);assert.deepEqual(fs.readFileSync(second.file),bytes);
    assert.equal(second.tasks.get(pageId).originalField,'preserved');assert.equal(second.tasks.get(pageId).bootstrapQueryReset.operation_id,operation);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('a confirmed old clear permits only a new explicit operator transaction for a newly matching query',async()=>{
  const f=fixture();await f.run();f.composer.text=f.query;
  await assert.rejects(f.run(),/original_operation_requires_reconciliation/);assert.equal(f.clears,1);
  const previous=f.driver.dom;f.driver.dom=async(wc,action,arg)=>{
    if(action==='connector-clear-query')arg={...arg,reconciliationId:operation};
    return previous(wc,action,arg);
  };
  const result=await f.run(nextOperation);assert.equal(result.operation_id,nextOperation);assert.equal(f.clears,2);
  assert.equal(f.resetStore.get().state,'cleared');assert.equal(f.row.paused,true);
});

test('the formal AppControl action pins original identity without creating an active request',()=>{
  const f=fixture(),identity=taskIdentity(f.page,f.row,4),state={app_instance_id:'original-app-instance',root:'D:/clw',runtime_generation:4,
    tasks:[{id:pageId,identity}]},expected={app_instance_id:state.app_instance_id,root:state.root,runtime_generation:4,task:{...identity}};
  assert.equal(capabilities.includes('reset-bootstrap-query'),true);
  assertControlIdentity('reset-bootstrap-query',f.payload,expected,state);
  assert.deepEqual(commandPayload('reset-bootstrap-query',{id:pageId,expected_query_sha256:hash(f.query)},expected),f.payload);
  for(const key of Object.keys(identity))assert.throws(()=>assertControlIdentity('reset-bootstrap-query',f.payload,
    {...expected,task:{...identity,[key]:'foreign'}},state),/task_changed/);
  assert.equal(identity.active_request_id,null);
});

test('the operator payload cannot add a prompt, selector, legacy proof or a foreign reservation',async()=>{
  for(const change of [payload=>{payload.text='delete my draft';},payload=>{payload.selector='#prompt-textarea';},
    payload=>{payload.legacy_incident='automatic-ownership';},payload=>{payload.id='foreign-page';},
    payload=>{payload.expected_query_sha256='*';}]){
    const f=fixture();change(f.payload);await assert.rejects(f.run(),error=>error.code==='bootstrap_query_reset_invalid'&&error.accepted===false);
    assert.equal(f.clears,0);assert.equal(f.calls.length,0);assert.equal(f.resetStore.get(),undefined);
  }
});

test('the existing synchronous public DOM clears the empty-home query and never activates a send button',async()=>{
  const {createWindow}=require('../../codex-web-bridge/upstream/node_modules/@mixmark-io/domino'),{dom}=require('../page-dom.cjs');
  const window=createWindow('<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true">@Local-MCP</div><button type="submit">Send</button></form><button data-testid="model-switcher-dropdown-button" aria-haspopup="menu">GPT-6 Pro</button>');
  const document=window.document,editor=document.getElementById('prompt-textarea');let active=null,deletions=0,sends=0;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>active});document.hasFocus=()=>false;
  Object.defineProperty(editor,'focus',{value:()=>{active=editor;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return 100;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return 30;}});
  window.HTMLElement.prototype.getClientRects=()=>[{}];
  const prototype=Object.getPrototypeOf(document.querySelectorAll('div'));
  Object.defineProperty(prototype,Symbol.iterator,{configurable:true,value:Array.prototype[Symbol.iterator]});
  const selection={anchorNode:null,removeAllRanges(){this.anchorNode=null;},addRange(range){this.anchorNode=range.node;}};
  window.getSelection=()=>selection;document.createRange=()=>({selectNodeContents(node){this.node=node;}});
  document.execCommand=action=>{assert.equal(action,'delete');assert.equal(selection.anchorNode,editor);deletions++;editor.textContent='';return true;};
  Object.defineProperty(document.querySelector('button[type="submit"]'),'click',{value:()=>{sends++;}});
  const context=vm.createContext({document,window,location:{href:url},Node:window.Node,getComputedStyle:()=>({flexDirection:'column'})});
  const f=fixture();f.driver.dom=async(_wc,action,arg={})=>vm.runInContext(`(${dom.toString()})(${JSON.stringify(action)},${JSON.stringify(arg)},()=>{},()=>false,()=>({required:false}))`,context);
  const result=await f.run();assert.equal(result.model_sends,0);assert.equal(deletions,1);assert.equal(sends,0);assert.equal(editor.textContent,'');
});
