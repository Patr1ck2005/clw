'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {captureTaskIdentity}=require('../task-action-identity.cjs');
const {loaded}=require('../page-residency.cjs');
const {WebDriver}=require('../web-driver.cjs');

function fixture(t,{unloaded=false,maintenanceChecking=false}={}){
  const url='https://chatgpt.com/c/original',calls=[];
  const contents={getURL:()=>url,isDestroyed:()=>false};
  const page={id:'original',account:'A',documentGeneration:3,view:unloaded?null:{webContents:contents}};
  const row={page_id:page.id,thread_id:'original-thread',account:'A',latest_request:{id:'original-request',phase:'processing'}};
  const runtime=new EventEmitter();runtime.ready=true;runtime.call=async()=>assert.fail('observation must not call or mutate the task ledger');
  const pool={selected:'another-selected-page',pages:new Map([[page.id,page]]),ensure:async()=>assert.fail('observation must not hydrate a renderer')};
  const hooks={};
  const driver=new WebDriver({pool,runtime,dom:async(wc,action,arg)=>{
    assert.equal(wc,contents);calls.push(action);hooks[action]?.();
    if(action==='snapshot')return {url,editor:true,controlKnown:true,generating:true,draft:true,composing:true,userId:'Original private user',assistantId:'Original private reply'};
    assert.equal(action,'connector-state');assert.equal(arg.expectedConnector,'Local-MCP');assert.equal(arg.diagnostics,true);
    return {editorCount:1,text:'原草稿',selected:['Local-MCP'],visibleSelectedCount:1,composing:true,generating:true};
  }});driver.records.set(page.id,row);t.after(()=>driver.dispose());
  const source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),start=source.indexOf('  const dispatchCommand=async'),end=source.indexOf('  shellControl=new ShellControl',start);
  assert.ok(start>=0&&end>start);let handle;
  const sandbox={ipcMain:{handle:(_name,fn)=>{handle=fn;}},ownShell(){},recordCommands:{actions:new Set()},isolatedCheck:false,
    checkActions:[],maintenanceChecking,driver,runtime,pool,captureTaskIdentity,loaded,runtimeGeneration:1,
    pageById:id=>{if(id!==page.id)throw Error('missing');return page;}};
  vm.runInNewContext(source.slice(start,end),sandbox,{filename:'actual-main-task-observation.cjs'});
  const command=(payload={id:page.id,expected_connection_generation:1})=>handle({}, {action:'task-observation',payload});
  return {command,page,row,calls,hooks,driver,sandbox};
}

test('actual main task-observation reads the explicitly owned generating page with zero hydration or composer controls',async t=>{
  const f=fixture(t),result=await f.command();
  assert.deepEqual(f.calls,['snapshot','connector-state']);assert.equal(result.page_id,'original');
  assert.equal(result.snapshot.generating,true);assert.equal(result.snapshot.draft,true);assert.equal(result.snapshot.composing,true);
  assert.equal(result.composer.text,undefined);assert.equal(result.composer.text_utf8_bytes,9);
  assert.equal(JSON.stringify(result).includes('Original private'),false);assert.equal(JSON.stringify(result).includes('原草稿'),false);
});
test('actual main observation of an unloaded original page rejects before hydration or DOM reads',async t=>{
  const f=fixture(t,{unloaded:true});await assert.rejects(f.command(),/task_observation_original_page_unavailable/);assert.deepEqual(f.calls,[]);
});
test('actual main observation requires an explicit task and current connection before touching a page',async t=>{
  const f=fixture(t);
  for(const payload of [{},{id:'missing'},{id:'original',expected_connection_generation:0}]){
    await assert.rejects(f.command(payload),/managed_task_identity_(required|changed)/);
  }
  assert.deepEqual(f.calls,[]);
});
test('actual main observation rejects a closed original task without reading its retained renderer',async t=>{
  const f=fixture(t);f.page.closed=true;await assert.rejects(f.command(),/managed_task_identity_changed/);assert.deepEqual(f.calls,[]);
});
test('actual main observation discards navigation between the two original DOM reads',async t=>{
  const f=fixture(t);f.hooks.snapshot=()=>{f.page.documentGeneration++;};
  await assert.rejects(f.command(),/managed_task_identity_changed|task_observation_original_page_changed/);assert.deepEqual(f.calls,['snapshot']);
});
test('actual main observation does not return a late result for a replacement original request',async t=>{
  const f=fixture(t);f.hooks['connector-state']=()=>{f.row.latest_request={id:'replacement-request',phase:'processing'};};
  await assert.rejects(f.command(),/managed_task_identity_changed|managed_task_response_stale/);assert.deepEqual(f.calls,['snapshot','connector-state']);
});
test('actual main observation rejects a reconnect during its first read',async t=>{
  const f=fixture(t);f.hooks.snapshot=()=>{f.sandbox.runtimeGeneration++;};
  await assert.rejects(f.command(),/managed_task_identity_changed/);assert.deepEqual(f.calls,['snapshot']);
});
test('actual main maintenance checking refuses observation without any page or ledger operation',async t=>{
  const f=fixture(t,{maintenanceChecking:true});await assert.rejects(f.command(),/正在核对原执行/);assert.deepEqual(f.calls,[]);
});
