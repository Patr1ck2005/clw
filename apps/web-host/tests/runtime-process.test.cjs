'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {RuntimeBridge}=require('../runtime-bridge.cjs');
const {WorkspaceState}=require('../workspace-state.cjs');
const {TaskSubmission}=require('../task-submission.cjs');

test('real child crash after acceptance and UI reopen recover the receipt with one side effect',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-pipe-fault-'));
 const children=[],r=new RuntimeBridge(folder,{restartDelays:[10],startupTimeoutMs:3000,closeTimeoutMs:2000,spawnProcess:()=>{
  const child=spawn(process.execPath,[path.join(__dirname,'fixtures/receipt-process.cjs'),folder],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);return child;
 }});
 const page='web-11111111-1111-4111-8111-111111111111';
 try{
  await Promise.all([r.start(),r.start()]);assert.equal(children.length,1);
  const workspace=new WorkspaceState(folder,()=>true);
  await assert.rejects(new TaskSubmission(r,workspace).start(page,'original complete work package'),/disconnected_reconcile_original/);
  const id=workspace.pendingStarts[page].operation_id;
  const deadline=Date.now()+4000;
  while(!r.ready&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(r.ready,true);assert.equal(children.length,2);
  const reopened=new WorkspaceState(folder,()=>true);
  assert.equal(reopened.pendingStarts[page].operation_id,id);
  const result=await new TaskSubmission(r,reopened).start(page,'original complete work package');
  assert.equal(result.request_id,id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'receipt.json'))).effects,1);
  assert.deepEqual(new WorkspaceState(folder,()=>true).pendingStarts,{});
 }finally{
  await r.close();
  for(const child of children)if(child.exitCode===null)child.kill();
  fs.rmSync(folder,{recursive:true,force:true});
 }
});
