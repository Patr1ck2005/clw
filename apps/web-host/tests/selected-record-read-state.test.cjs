'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {SelectedViewPoller}=require('../state-pipeline.cjs');
const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
const quotaProjection=main.split('\n').find(line=>line.startsWith('const quotaSnapshots='));
assert.ok(quotaProjection);
const pollerSource=main.slice(main.indexOf('const selectedViewPoller='),main.indexOf('const nativeBridgeModule=')).replace('const selectedViewPoller=','selectedViewPoller=');
const collectSource=main.slice(main.indexOf('function collectState(){'),main.indexOf('function persistProjection('));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({holdActivity=false}={}){
  const reads=[],activities=[],records=new Map(['a','b'].map(id=>[id,{thread_id:'thread-'+id,phase:'bound',paused:true,latest_request:{id:'original-'+id,phase:'processing'}}]));
  const c={previewMode:false,defaultWebAccount:'B',exitLifecycle:require('../exit-lifecycle.cjs').createExitLifecycle(),SelectedViewPoller,boundConversationUrl:require('../workspace-state.cjs').boundConversationUrl,selectedViewPoller:null,selectedRecordsRead:null,view:null,quitting:false,maintenanceChecking:false,selectedReadGeneration:1,runtimeGeneration:1,
    ROOT:'fixture',runtimeAvailability:require('../runtime-availability.js'),notice:'',snapshotFailures:[],workspaceRestored:true,taskStateRead:{state:'ready'},accountAccess:new Map(),quotas:new Map(),projectTaskRelations:()=>new Map(),
    driver:{records,recordsLoaded:true},pool:{selected:'a',pages:new Map(['a','b'].map(id=>[id,{id,kind:'task'}])),inspect(){return [...this.pages.values()];}},
    workspace:{tasks:new Map(),pendingStarts:{},closed:()=>[]},localCodex:{snapshot:()=>({})},nativeBridge:null,nativeConversations:null,guard:{state:'verified'},publish(){},
    runtime:{ready:true,snapshot:()=>({state:'ready'}),call(op,p){if(op==='session-activity'){if(!holdActivity)return Promise.resolve({state:'ready'});const d=deferred();activities.push(d);return d.promise;}assert.equal(op,'view');const d=deferred();reads.push({id:p.page_id,...d});return d.promise;}}};
  vm.createContext(c);vm.runInContext(quotaProjection+'\n'+pollerSource+'\n'+collectSource,c);
  const value=id=>({page_id:id,thread_id:'thread-'+id,request:{id:'original-'+id,phase:'processing'}});
  return {c,reads,activities,value,state:()=>c.collectState().selectedRecords,select(id){c.pool.selected=id;c.selectedReadGeneration++;c.selectedViewPoller.invalidate();c.view=null;}};
}
test('the current original record is loading until its own read succeeds without changing task phase',async()=>{
  const f=fixture(),before=JSON.stringify([...f.c.driver.records]);assert.equal(f.state().state,'loading');const request=f.c.selectedViewPoller.refresh();await tick();assert.equal(f.state().state,'loading');f.reads[0].resolve(f.value('a'));await request;assert.equal(f.state().state,'ready');assert.equal(f.state().page_id,'a');assert.equal(JSON.stringify([...f.c.driver.records]),before);
});
test('a first original read failure without an old view is unavailable and ends loading',async()=>{
  const f=fixture(),request=f.c.selectedViewPoller.refresh();await tick();f.reads[0].reject(Error('runtime_receipt_unknown_reconcile_original'));await request;assert.equal(f.c.view,null);assert.equal(f.state().state,'unavailable');assert.equal(f.state().code,'runtime_selected_records_unavailable');assert.equal(f.c.driver.records.get('a').latest_request.phase,'processing');assert.equal(f.c.collectState().taskStateReady,true);
});
test('rapid A B A does not borrow an earlier ready or unavailable read from the same page',async()=>{
  const f=fixture(),a=f.c.selectedViewPoller.refresh();await tick();f.select('b');const b=f.c.selectedViewPoller.refresh();await tick();f.select('a');assert.equal(f.state().state,'loading');const fresh=f.c.selectedViewPoller.refresh();await tick();f.reads[0].resolve(f.value('a'));f.reads[1].reject(Error('old b failed'));await Promise.all([a,b]);assert.equal(f.state().state,'loading');assert.equal(f.state().page_id,'a');f.reads[2].resolve(f.value('a'));await fresh;assert.equal(f.state().state,'ready');f.c.runtimeGeneration++;assert.equal(f.state().state,'loading');
});
test('optional activity cannot clear a view-read failure; a new successful original read can',async()=>{
  const f=fixture({holdActivity:true}),initial=f.c.selectedViewPoller.refresh();await tick();f.reads[0].resolve(f.value('a'));await initial;const failure=f.c.selectedViewPoller.refresh({force:true});await tick();f.reads[1].reject(Error('view read failed'));await failure;assert.equal(f.state().state,'unavailable');f.activities[0].resolve({state:'ready'});await tick();assert.equal(f.state().state,'unavailable');assert.equal(f.c.view.state_read.unavailable,true);const recovery=f.c.selectedViewPoller.refresh({force:true});await tick();f.reads[2].resolve(f.value('a'));await recovery;assert.equal(f.state().state,'ready');
});
