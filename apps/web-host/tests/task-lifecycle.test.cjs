'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {WorkspaceState}=require('../workspace-state.cjs');
const {taskLocation,removeClosedTask}=require('../task-lifecycle.cjs');
const {WebDriver}=require('../web-driver.cjs');
const id='web-11111111-1111-4111-8111-111111111111';
const setup=()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-lifecycle-'));
  const workspace=new WorkspaceState(path.join(home,'metadata'),()=>true);
  const location=taskLocation({id,home});
  workspace.update(id,{id,url:'https://chatgpt.com/c/kept',title:'Original',closed:true,...location});workspace.save();
  const args={id,workspace,pool:{pages:new Map(),close(){assert.fail('no page to close');}},driver:{records:new Map(),busy:new Set(),pending:new Map()},snapshot:()=>assert.fail('no page to read')};
  return {home,workspace,args,location};
};
test('missing directory creates an isolated persistent workspace; explicit projects stay unchanged',()=>{
 const f=setup();try{
  assert.equal(f.location.automaticWorkspace,true);assert.equal(fs.statSync(f.location.root).isDirectory(),true);
  assert.match(fs.readFileSync(path.join(f.location.root,'AGENTS.md'),'utf8'),/独立目录/);
  const project=path.join(f.home,'project');fs.mkdirSync(project);
  assert.deepEqual(taskLocation({root:project,id,home:f.home}),{root:project,automaticWorkspace:false});
  assert.deepEqual(fs.readdirSync(project),[]);
  assert.throws(()=>taskLocation({root:path.join(f.home,'missing'),id,home:f.home}),/不存在/);
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
test('deleted closed rows cannot return through capture, runtime reconciliation, or restart; files stay',async()=>{
 const f=setup();try{
  const output=path.join(f.location.root,'RESULT.md');fs.writeFileSync(output,'keep result');
  const receipt=await removeClosedTask(f.args);assert.equal(receipt.webConversationDeleted,false);
  const restored=new WorkspaceState(f.workspace.folder,()=>true);
  assert.equal(restored.tasks.has(id),false);assert.equal(restored.isClosed(id),true);
  restored.capture({inspect:()=>[{id,url:'https://chatgpt.com/c/kept',closed:false}],selected:id});
  assert.equal(restored.tasks.size,0);assert.equal(restored.selected,null);
  assert.equal(fs.readFileSync(output,'utf8'),'keep result');
  const runtime=new EventEmitter();runtime.ready=true;const calls=[];
  runtime.call=async op=>{calls.push(op);return {pages:[{page_id:id,paused:true}]};};
  await new WebDriver({runtime,pool:{pages:new Map(),create:()=>assert.fail('deleted page restored')},isClosed:x=>restored.isClosed(x),onNotice(){},dom:()=>assert.fail('deleted page dispatched')}).reconcileAll();
  assert.deepEqual(calls,['list']);
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
test('cleanup refuses open rows, uncertain submissions, active work, drafts, and lost runtime',async()=>{
 const f=setup();try{
  f.workspace.update(id,{closed:false});await assert.rejects(()=>removeClosedTask(f.args),/先关闭/);
  f.workspace.update(id,{closed:true});f.workspace.pendingStarts[id]={objective:'saved'};
  await assert.rejects(()=>removeClosedTask(f.args),/提交尚未核对/);delete f.workspace.pendingStarts[id];
  f.args.driver.records.set(id,{paused:true,phase:'bound'});
  await assert.rejects(()=>removeClosedTask(f.args),/连接恢复/);
  f.args.runtime={ready:true,call:async()=>({request:{phase:'processing'}})};
  await assert.rejects(()=>removeClosedTask(f.args),/未结束/);
  f.args.runtime.call=async()=>({});f.args.pool.pages.set(id,{view:{webContents:{}}});f.args.snapshot=async()=>({draft:true});
  await assert.rejects(()=>removeClosedTask(f.args),/未发送内容/);
  assert.equal(f.workspace.tasks.has(id),true);assert.deepEqual(f.workspace.removed,{});
 }finally{fs.rmSync(f.home,{recursive:true,force:true});}
});
test('first preparation combines scope and user requirements with one durable reservation',async()=>{
 const runtime=new EventEmitter(),calls=[];let reserved=false;
 runtime.call=async(op,p)=>{calls.push({op,p});if(op==='list')return {pages:reserved?[{page_id:id}]:[]};if(op==='reserve'){reserved=true;return {state:'reserved',page_id:id};}assert.fail(op);};
 const driver=new WebDriver({runtime,pool:{pages:new Map()},onNotice(){},dom:async()=>({editor:true,controlKnown:true})});
 driver.inspect=async()=>({model:'GPT-6',effort:'极高'});
 driver.selectModel=async(_page,settings)=>{assert.equal(settings.effort,'极高');return {model:'GPT-6',effort:'极高'};};
 driver.reconcileAll=async()=>{};
 const page={id,account:'A',view:{webContents:{}}},payload={root:'D:/test',title:'Prepare',instructions:'Read handoff and plan'};
 await driver.startFirstTurn(page,payload);
 assert.equal(calls.filter(c=>c.op==='reserve').length,1);
 const reserve=calls.find(c=>c.op==='reserve').p;
 assert.equal(reserve.account,'A');assert.equal(reserve.first_turn_instructions,payload.instructions);assert.deepEqual(reserve.write_paths,['.']);
 await assert.rejects(()=>driver.startFirstTurn(page,payload),/已提交/);
 assert.equal(calls.filter(c=>c.op==='reserve').length,1);
});
test('slow or busy public pages preserve first-turn intent without reserving or sending',async()=>{
 for(const snapshot of [{loginRequired:true},{editor:false},{editor:true,controlKnown:true,draft:true}]){
  const runtime=new EventEmitter();runtime.call=async op=>{assert.equal(op,'list');return {pages:[]};};
  const driver=new WebDriver({runtime,pool:{pages:new Map()},onNotice(){},dom:async()=>snapshot});
  driver.inspect=()=>assert.fail('page not ready for model selection');
  await assert.rejects(()=>driver.startFirstTurn({id,view:{webContents:{}}},{root:'D:/test',title:'Prepare',instructions:'Saved intent'}));
  assert.equal(driver.busy.size,0);
 }
});
test('first preparation Pro choice changes the actual model and is rechecked before reservation',async()=>{
 const runtime=new EventEmitter(),calls=[];let observed={model:'GPT-6',effort:'极高',slider:{index:3}};
 runtime.call=async(op,p)=>{calls.push({op,p});return op==='list'?{pages:[]}:{state:'reserved',page_id:id};};
 const driver=new WebDriver({runtime,pool:{pages:new Map()},onNotice(){},dom:async()=>({editor:true,controlKnown:true})});
 driver.inspect=async()=>observed;driver.reconcileAll=async()=>{};
 driver.selectModel=async(_page,settings)=>{
  assert.equal(settings.effort,'Pro');assert.equal(settings.model_selection.slider,null);
  observed={model:'GPT-6',effort:'Pro'};return observed;
 };
 await driver.startFirstTurn({id,account:'A',view:{webContents:{}}},{root:'D:/test',title:'Research preparation',instructions:'Read the evidence and develop a complete research plan.',effort:'Pro'});
 const reservation=calls.find(c=>c.op==='reserve').p;
 assert.equal(reservation.effort,'Pro');assert.equal(reservation.model_selection.effort,'Pro');
 driver.selectModel=async()=>({model:'GPT-6',effort:'极高'});
 await assert.rejects(()=>driver.startFirstTurn({id,account:'A',view:{webContents:{}}},{root:'D:/test',instructions:'Keep intent',effort:'Pro'}),/模型已变化/);
 assert.equal(calls.filter(c=>c.op==='reserve').length,1);
});

test('blank Pro first turn is rejected before reading the page or creating a reservation',async()=>{
 const runtime=new EventEmitter();runtime.call=async()=>assert.fail('no reservation or model probe');
 const driver=new WebDriver({runtime,pool:{pages:new Map()},onNotice(){},dom:async()=>assert.fail('no page probe')});
 await assert.rejects(()=>driver.startFirstTurn({id},{instructions:'  ',effort:'Pro'}),/Pro 需要完整/);
});

test('new page loading is waited by program and respects first-task settings',async()=>{
 const runtime=new EventEmitter(),calls=[];let samples=0,waits=0;
 runtime.call=async(op,p)=>{calls.push({op,p});return op==='list'?{pages:[]}:{state:'reserved',page_id:id};};
 const driver=new WebDriver({runtime,pool:{pages:new Map()},onNotice(){},sleep:async()=>{waits++;},dom:async()=>({editor:++samples>2,controlKnown:samples>2})});
 driver.inspect=async()=>({model:'GPT-6',effort:'极高'});driver.selectModel=async()=>driver.inspect();driver.reconcileAll=async()=>{};
 await driver.startFirstTurn({id,view:{webContents:{}}},{root:'D:/test',title:'Plan',instructions:'Read',waitForReady:true,
   access:'read',write_paths:[],collaboration_protocol:'text_v1',duration_seconds:10800,max_dispatches:60});
 assert.equal(waits,2);const reservation=calls.find(c=>c.op==='reserve').p;
 assert.equal(reservation.access,'read');assert.deepEqual(reservation.write_paths,[]);
 assert.equal(reservation.collaboration_protocol,'text_v1');assert.equal(reservation.max_dispatches,60);assert.equal(reservation.duration_seconds,10800);
});

test('close during initial page loading never reserves or probes a model',async()=>{
 const runtime=new EventEmitter();runtime.call=async op=>{assert.equal(op,'list');return {pages:[]};};let closed=false,samples=0;
 const driver=new WebDriver({runtime,pool:{pages:new Map()},onNotice(){},isClosed:()=>closed,sleep:async()=>{closed=true;},
   dom:async()=>({editor:++samples>1,controlKnown:true})});
 driver.inspect=async()=>assert.fail('closed page');
 await assert.rejects(()=>driver.startFirstTurn({id,view:{webContents:{}}},{instructions:'Read',waitForReady:true}),/已关闭/);
});
