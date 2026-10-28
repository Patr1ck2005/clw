'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const availability=require('../runtime-availability.js');
const {NetworkGuard}=require('../network-guard.cjs');
const {BrowserPool}=require('../browser-pool.cjs');
const {WebDriver}=require('../web-driver.cjs');
const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
const quotaProjection=main.split('\n').find(line=>line.startsWith('const quotaSnapshots='));
assert.ok(quotaProjection);
const start=main.indexOf('function collectState('),end=main.indexOf('function persistProjection(',start);
assert.ok(start>0&&end>start);
const offline='VPN 尚未通过核验，网页保持离线。';
function fixture(){
 const guard=new NetworkGuard(),navigations=[],runtime=new EventEmitter();runtime.ready=true;
 const original={page_id:'original',thread_id:'original-thread',account:'A',url:'https://chatgpt.com/c/original',phase:'bound',paused:true,latest_request:{id:'original-request',phase:'completed'}};
 const originalBytes=JSON.stringify(original);
 const ses={setProxy:async()=>{},closeAllConnections:async()=>{},setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(){}},resolveProxy:async()=> 'PROXY 127.0.0.1:17890',fetch:async()=>({ok:true,text:async()=> 'ip=fixture-only\n'})};
 class View{
  constructor(){let url='about:blank';this.webContents=Object.assign(new EventEmitter(),{session:ses,isDestroyed:()=>false,getURL:()=>url,setWindowOpenHandler(){},setWebRTCIPHandlingPolicy(){},loadURL:async value=>{url=value;navigations.push(value);}});}
  setBounds(){}setVisible(){}
 }
 const pool=new BrowserPool({window:{getContentSize:()=>[1440,960],contentView:{addChildView(){},removeChildView(){}}},WebContentsView:View,partitionForAccount:account=>'persist:original-'+account,allowedUrl:()=>true,networkGuard:guard});
 pool.register(original.page_id,original.url,{kind:'task',account:original.account});pool.select(original.page_id);
 runtime.call=async action=>{assert.equal(action,'list','network recovery cannot send a model or mutate a task');return {pages:[original]};};runtime.snapshot=()=>({state:'ready',code:null});
 const context={previewMode:false,defaultWebAccount:'B',exitLifecycle:require('../exit-lifecycle.cjs').createExitLifecycle(),boundConversationUrl:require('../workspace-state.cjs').boundConversationUrl,ROOT:'original-fixture-root',notice:'',guard,runtime,runtimeGeneration:1,workspaceRestored:true,taskStateRead:{state:'ready',code:null},selectedRecordsRead:null,selectedReadGeneration:0,view:null,pool,workspace:{tasks:new Map([[original.page_id,{account:'A'}]]),pendingStarts:{},closed:()=>[],theme:'dark'},quotas:new Map(),accountAccess:new Map(),snapshotFailures:[],quitting:false,maintenanceChecking:false,projectTaskRelations:()=>new Map(),runtimeAvailability:availability,localCodex:{snapshot:()=>({state:'idle'})},nativeBridge:null,nativeConversations:null};
 const driver=new WebDriver({runtime,pool,onNotice:message=>{context.notice=message;},onRecords(){},dom:async()=>assert.fail('not-ready DOM must remain untouched'),input:{key:async()=>assert.fail('no keyboard input'),insert:async()=>assert.fail('no model input')}});context.driver=driver;
 const collect=vm.runInNewContext('(function(){'+quotaProjection+'\n'+main.slice(start,end)+';return collectState;})()',context);
 return {guard,ses,pool,driver,context,collect,navigations,original,originalBytes};
}
test('actual main retires the pre-verification BrowserPool notice after the same guard verifies',async t=>{
 const f=fixture();t.after(()=>f.driver.dispose());
 await f.driver.reconcileAll();assert.equal(f.context.notice,offline);assert.equal(f.collect().notice,offline);assert.equal(f.navigations.length,0);
 await f.guard.verify(f.ses);await f.driver.reconcileAll();
 const state=f.collect();assert.equal(f.guard.ready,true);assert.equal(state.network,'VPN 已连接 · 直连已禁用');assert.equal(state.notice,'');
 assert.equal(state.connected,true);assert.equal(state.taskStateReady,true);assert.deepEqual(f.navigations,[f.original.url]);assert.equal(JSON.stringify(f.original),f.originalBytes);
});
test('late pre-verification callbacks cannot restore an offline notice to an already verified snapshot',async t=>{
 const f=fixture();t.after(()=>f.driver.dispose());await f.guard.verify(f.ses);
 for(const message of [offline,'VPN 尚未通过核验，不能刷新网页。',availability.notice('runtime_network_unavailable')]){
  f.context.notice=message;assert.equal(f.collect().notice,'');assert.equal(f.context.notice,message,'publishing cannot rewrite retained diagnostics');
 }
});
test('an unavailable guard retains each of its original network notices',async t=>{
 const f=fixture();t.after(()=>f.driver.dispose());f.ses.fetch=async()=>({ok:false});
 await assert.rejects(f.guard.verify(f.ses),/VPN 出口检查失败/);assert.equal(f.guard.ready,false);
 for(const message of [offline,'VPN 尚未通过核验，不能刷新网页。',availability.notice('runtime_network_unavailable')]){f.context.notice=message;assert.equal(f.collect().notice,message);}
});
test('network readiness does not retire task, Native, Host, actual load failures or unconfirmed execution',async t=>{
 const f=fixture();t.after(()=>f.driver.dispose());await f.guard.verify(f.ses);
 for(const message of ['网页加载失败，原任务已保留。请检查 VPN 后重试该网页。','原对话暂未加载完成，请检查 VPN 后刷新；没有重发任务。','Codex Web 接入待处理：原 owner 仍待核对',availability.notice('runtime_receipt_unknown_reconcile_original'),availability.notice('runtime_task_state_unavailable'),'VPN 路由核验失败，网页联网已停止。',offline+'\n原回执未知']){f.context.notice=message;assert.equal(f.collect().notice,message);}
});
test('retiring a guard notice preserves an independent snapshot persistence failure',async t=>{
 const f=fixture();t.after(()=>f.driver.dispose());await f.guard.verify(f.ses);f.context.notice=offline;f.context.snapshotFailures=[{file:'health.json',code:'EBUSY'}];
 const state=f.collect();assert.doesNotMatch(state.notice,/网页保持离线/);assert.match(state.notice,/health\.json：EBUSY/);
});
test('the pure notice projection requires explicit verified readiness and preserves raw input',()=>{
 for(const ready of [undefined,false,null,0,1,'true'])assert.equal(availability.currentNotice(offline,{networkReady:ready}),offline);
 assert.equal(availability.currentNotice(offline,{networkReady:true}),'');assert.equal(availability.currentNotice(''), '');
});
