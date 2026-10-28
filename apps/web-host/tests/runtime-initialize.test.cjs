'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const availability=require('../runtime-availability.js');
const {connectorNames}=require('../connector-identity.cjs');
const {WebDriver}=require('../web-driver.cjs'),{BrowserPool}=require('../browser-pool.cjs');
const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),start=main.indexOf('  // Local service readiness is independent'),end=main.indexOf('  if(configuredBridge&&guard.ready)',start);
assert.ok(start>0&&end>start);
async function initialize({listFails=false,listFailOnce=false,restoreFails=false,vpnFails=false,reconnectFails=false,realDriver=false,rows=[]}={}){
 let calls=0,restores=0,views=0,navigations=0;const publications=[],approvalOptions=[];
 class Runtime extends EventEmitter{constructor(){super();this.ready=false;this.closed=false;}snapshot(){return {state:this.ready?'ready':'starting',code:null};}async start(){this.ready=true;this.emit('ready');}async call(action){calls++;assert.equal(action,'list');if(listFails||listFailOnce&&calls===1)throw Error('fixture-private-record-read-error');return {pages:rows};}}
 class Driver{constructor({runtime,onRecords,onNotice}){this.runtime=runtime;this.recordsLoaded=false;this.onRecords=onRecords;runtime.on('ready',()=>{this.recordsLoaded=false;void this.restore().catch(error=>onNotice(error.message));});}async restore(){restores++;if(restoreFails||reconnectFails&&restores>1)throw Error('fixture-private-restore-error');const result=await this.runtime.call('list');this.recordsLoaded=true;this.onRecords(result.pages);}}
 class ObservingDriver extends WebDriver{constructor(options){super({...options,observeIntervalMs:8});}restore(){restores++;return super.restore();}}
 const guard={ready:false,state:'未核对',async verify(){if(vpnFails)throw Error('fixture-vpn-unavailable');this.ready=true;}};
 class View{constructor(){views++;this.webContents={isDestroyed:()=>false,loadURL(){navigations++;}};}}
 const pool=realDriver?new BrowserPool({networkGuard:guard,allowedUrl:()=>true,WebContentsView:View}):{pages:new Map(),register(){},select(){}};
 const workspace={tasks:new Map(rows.map(row=>[row.page_id,{id:row.page_id,kind:'task',account:row.account,url:'https://chatgpt.com/'}])),selected:null,
  syncBindings(records){for(const row of records){const saved=this.tasks.get(row.page_id);if(saved)saved.boundUrl=row.url;}return false;},save(){},isClosed:()=>false};
 const context={ROOT:'fixture-root',profile:'fixture-profile',isolatedCheck:false,previewMode:false,previewConfig:{childEnvironment:(_root,env)=>env},runtime:null,driver:null,submissions:null,notice:'',runtimeGeneration:0,view:null,workspaceRestored:false,taskStateRead:{state:'pending',code:null},runtimeAvailability:availability,
  require:name=>name==='./runtime-bridge.cjs'?{RuntimeBridge:Runtime}:name==='./web-driver.cjs'?{WebDriver:realDriver?ObservingDriver:Driver}:name==='./connector-identity.cjs'?{connectorNames}:assert.fail(name),process:{env:{}},TaskSubmission:class{},ApprovalManager:class{constructor(options){approvalOptions.push(options);}},fileApprovalAuthorized(){},quotas:new Map(),
  path,fs:{existsSync:()=>false},pool,workspace,loaded:page=>!!page.view,session:{fromPartition:()=>({})},partition:'original',selectedViewPoller:{invalidate(){}},savePages(){},guard,publish(){publications.push(true);}};
 await vm.runInNewContext('(async()=>{'+main.slice(start,end)+'})()',context);
 return {context,get calls(){return calls;},get restores(){return restores;},get views(){return views;},get navigations(){return navigations;},publications,approvalOptions,ui:availability.presentation({connected:context.runtime.ready,taskStateReady:context.workspaceRestored&&context.driver?.recordsLoaded===true,runtime:context.runtime.snapshot(),taskStateRead:context.taskStateRead})};
}
test('actual main initialization reports original list failure without leaving a perpetual record read',async()=>{
 const r=await initialize({listFails:true});assert.equal(r.context.workspaceRestored,true);assert.equal(r.context.taskStateRead.code,'runtime_task_state_unavailable');assert.equal(r.ui.loading,false);assert.equal(r.calls,2);assert.doesNotMatch(r.context.notice,/fixture-private/);
});
test('actual main installs the real original observer before a failed first read and recovers without a new ready or navigation',async t=>{
 const original={page_id:'original-paused',thread_id:'original-thread',url:'https://chatgpt.com/c/original',account:'A',phase:'bound',paused:true,latest_request:{id:'original-request',phase:'processing'}};
 const r=await initialize({listFailOnce:true,vpnFails:true,realDriver:true,rows:[original]});t.after(()=>r.context.driver?.dispose());
 assert.ok(r.context.driver instanceof WebDriver);assert.equal(r.context.runtime.ready,true);assert.equal(r.context.driver.recordsLoaded,false);assert.equal(r.calls,1);
 const owner=r.context.runtime,driver=r.context.driver,generation=r.context.runtimeGeneration,deadline=Date.now()+1000;
 while(!driver.recordsLoaded){assert.ok(Date.now()<deadline,'same ready Host never recovered its first list fault');await new Promise(resolve=>setTimeout(resolve,4));}
 assert.equal(r.context.runtime,owner);assert.equal(r.context.driver,driver);assert.equal(r.context.runtimeGeneration,generation);
 assert.equal(driver.records.get(original.page_id),original);assert.equal(r.context.taskStateRead.state,'ready');assert.equal(r.context.workspaceRestored,true);
 assert.equal(original.paused,true);assert.equal(original.latest_request.id,'original-request');assert.ok(r.calls>=2);
 assert.equal(r.context.pool.pages.get(original.page_id).url,original.url);assert.equal(r.views,0);assert.equal(r.navigations,0);
});
test('actual main restore failure is a read availability fault, retaining the ready service',async()=>{
 const r=await initialize({restoreFails:true});assert.equal(r.context.runtime.ready,true);assert.equal(r.context.taskStateRead.code,'runtime_task_state_unavailable');assert.equal(r.ui.loading,false);assert.equal(r.restores,2);assert.doesNotMatch(r.context.notice,/fixture-private/);assert.deepEqual(r.approvalOptions[0].connectors,connectorNames());
});
test('actual main VPN rejection leaves local records readable without navigating a Web page',async()=>{
 const r=await initialize({vpnFails:true});assert.equal(r.context.runtime.ready,true);assert.equal(r.context.taskStateRead.code,null);assert.equal(r.ui.loading,false);assert.equal(r.restores,1);assert.equal(r.context.driver.recordsLoaded,true);assert.equal(r.context.workspaceRestored,true);assert.match(r.context.guard.state,/VPN 不可用/);
});
test('actual main later ready listener reports failed original record recovery instead of indefinite loading',async()=>{
 const r=await initialize({reconnectFails:true});assert.equal(r.context.driver.recordsLoaded,true);assert.deepEqual(r.approvalOptions[0].connectors,connectorNames());r.context.runtime.emit('ready');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(r.context.driver.recordsLoaded,false);assert.equal(r.context.taskStateRead.code,'runtime_task_state_unavailable');assert.equal(availability.presentation({connected:true,taskStateReady:false,runtime:r.context.runtime.snapshot(),taskStateRead:r.context.taskStateRead}).loading,false);assert.doesNotMatch(r.context.notice,/fixture-private/);
});
