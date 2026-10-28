'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {captureTaskIdentity}=require('../task-action-identity.cjs'),{loaded}=require('../page-residency.cjs');
function fixture({unloaded=false}={}){
 const page={id:'original',account:'A',documentGeneration:3,view:unloaded?null:{webContents:{isDestroyed:()=>false}}};
 const row={page_id:page.id,thread_id:null,account:'A',latest_request:null},calls=[];
 const driver={records:new Map([[page.id,row]])},task={id:page.id},workspace={tasks:new Map([[page.id,task]]),
  update(id,value){assert.equal(id,page.id);Object.assign(task,value);},save(){calls.push('save-intent');}};
 const sandbox={recordCommands:{actions:new Set()},isolatedCheck:false,maintenanceChecking:false,driver,pool:{
  ensure:()=>assert.fail('query reset must never hydrate')},runtimeGeneration:1,captureTaskIdentity,loaded,
  pageById:id=>{if(id!==page.id)throw Error('missing');return page;},workspace,publish(){calls.push('publish');},
  require:name=>{assert.equal(name,'./bootstrap-query-reset.cjs');return {resetBootstrapQuery:async options=>{
   assert.equal(options.driver,driver);assert.equal(options.page,page);assert.equal(options.operationId,'original-execution');
   options.assertCurrent();calls.push('reset');options.resetStore.persist({state:'pending',operation_id:options.operationId});
   assert.equal(options.resetStore.get().state,'pending');return {cleared:true,model_sends:0};
  }};},ipcMain:{handle(){}},ownShell(){}};
 const source=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),start=source.indexOf('  const dispatchCommand=async'),end=source.indexOf('  shellControl=new ShellControl',start);
 vm.runInNewContext(source.slice(start,end)+'\nglobalThis.invoke=dispatchCommand;',sandbox);
 return {page,row,calls,task,run:(payload={id:page.id,expected_connection_generation:1},context={execution_reference:'original-execution'})=>
  sandbox.invoke('reset-bootstrap-query',payload,context)};
}
test('actual dispatcher passes only the original loaded page, formal operation and durable workspace intent to query reset',async()=>{
 const f=fixture(),result=await f.run();assert.equal(result.model_sends,0);assert.equal(result.cleared,true);
 assert.deepEqual(f.calls,['reset','save-intent','publish']);assert.equal(f.task.bootstrapQueryReset.operation_id,'original-execution');
});
test('query reset rejects IPC without a formal execution reference before input or intent changes',async()=>{
 const f=fixture();await assert.rejects(f.run(undefined,null),/bootstrap_query_control_operation_required/);assert.deepEqual(f.calls,[]);
});
test('query reset rejects unloaded, missing and stale original identities without hydration',async()=>{
 const f=fixture({unloaded:true});await assert.rejects(f.run(),/task_observation_original_page_unavailable/);assert.deepEqual(f.calls,[]);
 for(const payload of [{},{id:'missing'},{id:'original',expected_connection_generation:0}]){
  const g=fixture();await assert.rejects(g.run(payload),/managed_task_identity_(required|changed)/);assert.deepEqual(g.calls,[]);
 }
});
