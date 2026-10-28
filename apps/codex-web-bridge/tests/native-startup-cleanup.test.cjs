'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {settleNativeStartupFailure}=require('../native-startup-cleanup.cjs');
const {createNativeMaintenanceController}=require('../native-maintenance.cjs');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {createNativeMaintenanceExit,waitNormalChildExit}=require('../native-maintenance-exit.cjs');
const keys=['activeHttp','activeBrowser','brokerPending','externalOwners','physicalCleanup','pendingCompactions'];
function fixture(){const owner={},serverChild={pid:42},proof={version:1,kind:'native_owner_maintenance',runtimePid:42,ownerEpoch:randomUUID(),fenceId:randomUUID(),nativeTurns:[],...Object.fromEntries(keys.map(key=>[key,0]))};
 const receipt={version:1,kind:'native_maintenance_exit',state:'exited',runtimePid:42,ownerEpoch:proof.ownerEpoch,fenceId:proof.fenceId,shutdownDispatched:true,runtimeExit:{pid:42,code:0,signal:null}};
 const calls=[];return {owner,proof,receipt,calls,options:{owner,serverChild,host:{},cleanupUnstarted:async()=>{calls.push('unstarted');},prepare:async()=>{calls.push('prepare');return proof;},close:async()=>{calls.push('close');return receipt;},release:async p=>{calls.push(['release',p]);}}};}
test('unspawned startup closes only its empty local control and does not invent a child exit receipt',async()=>{const f=fixture(),original=Error('bridge_build_required');
 const result=await settleNativeStartupFailure(original,{...f.options,serverChild:null,host:null});assert.strictEqual(result,original);assert.equal(result.nativeStartup.state,'not_started');assert.equal(result.nativeStartup.ownerStarted,false);assert.equal(result.nativeStartup.receipt,undefined);assert.equal(result.nativeOwner,undefined);assert.deepEqual(f.calls,['unstarted']);});
test('only an exact no-admission fenced normal exit marks a spawned initialization cleaned',async()=>{const f=fixture(),result=await settleNativeStartupFailure(Error('bridge_public_owner_changed'),f.options);
 assert.equal(result.nativeStartup.state,'cleaned');assert.equal(result.nativeStartup.ownerStarted,false);assert.strictEqual(result.nativeStartup.receipt,f.receipt);assert.strictEqual(result.nativeOwner,f.owner);assert.deepEqual(f.calls,['prepare','close']);});
test('browser created without an execution owner cannot be destroyed by guessing that it is idle',async()=>{const f=fixture(),result=await settleNativeStartupFailure(Error('browser not ready'),{...f.options,serverChild:null});assert.equal(result.nativeStartup.state,'cleanup_unknown');assert.equal(result.nativeStartup.ownerStarted,true);assert.strictEqual(result.nativeOwner,f.owner);assert.deepEqual(f.calls,[['release',undefined]]);});
test('unknown owner, accepted turn or any pending physical counter preserves the original owner',async()=>{
 for(const change of [{nativeTurns:[{}]},...keys.map(key=>({[key]:1}))]){const f=fixture();Object.assign(f.proof,change);const original=Error('original startup failure'),result=await settleNativeStartupFailure(original,f.options);assert.strictEqual(result,original);assert.equal(result.nativeStartup.state,'cleanup_unknown');assert.strictEqual(result.nativeOwner,f.owner);assert.equal(f.calls.includes('close'),false);assert.equal(f.calls[1][0],'release');assert.strictEqual(f.calls[1][1],f.proof);}
 const f=fixture(),result=await settleNativeStartupFailure(Error('startup'),{...f.options,prepare:async()=>{throw Error('native_maintenance_owner_unknown');}});assert.equal(result.nativeStartup.reason,'native_maintenance_owner_unknown');assert.strictEqual(result.nativeOwner,f.owner);assert.deepEqual(f.calls,[['release',undefined]]);
});
test('unknown dispatched close keeps its exact owner and fence without resume, replay, kill or cleanup',async()=>{const f=fixture(),error=Object.assign(Error('native_maintenance_child_exit_unknown'),{maintenanceClose:{kind:'native_maintenance_exit',state:'unknown',runtimePid:42,ownerEpoch:f.proof.ownerEpoch,fenceId:f.proof.fenceId,shutdownDispatched:true,stage:'shutdown_dispatched'}});
 const result=await settleNativeStartupFailure(Error('startup'),{...f.options,close:async()=>{f.calls.push('close');throw error;}});assert.equal(result.nativeStartup.state,'cleanup_unknown');assert.strictEqual(result.nativeStartup.maintenanceClose,error.maintenanceClose);assert.strictEqual(result.nativeOwner,f.owner);assert.deepEqual(f.calls,['prepare','close']);});
test('known pre-dispatch refusal releases only the original caller fence, retaining the startup error',async()=>{const f=fixture(),original=Error('bridge_public_owner_changed'),error=Object.assign(Error('native_maintenance_close_verification_refused'),{maintenanceClose:{state:'refused',shutdownDispatched:false,stage:'before_shutdown'}});
 const result=await settleNativeStartupFailure(original,{...f.options,close:async()=>{throw error;}});assert.strictEqual(result,original);assert.equal(result.nativeStartup.ownerStarted,true);assert.strictEqual(f.calls[1][1],f.proof);});
test('nonzero, signaled, mismatched or malformed close receipts never claim startup cleanup complete',async()=>{
 for(const change of [{runtimeExit:{pid:42,code:1,signal:null}},{runtimeExit:{pid:42,code:0,signal:'SIGTERM'}},{runtimePid:43},{fenceId:randomUUID()},{ownerEpoch:randomUUID()},{shutdownDispatched:false},{kind:'ordinary_exit'},{state:'unknown'}]){const f=fixture();Object.assign(f.receipt,change);const result=await settleNativeStartupFailure(Error('startup'),f.options);assert.equal(result.nativeStartup.state,'cleanup_unknown');assert.equal(result.nativeStartup.ownerStarted,true);assert.strictEqual(result.nativeOwner,f.owner);assert.deepEqual(f.calls,['prepare','close']);}
});
test('an untyped close failure is unknown after the attempt, never permission to resume or replay',async()=>{const f=fixture(),result=await settleNativeStartupFailure(Error('startup'),{...f.options,close:async()=>{f.calls.push('close');throw Error('lost transport without typed response');}});assert.equal(result.nativeStartup.state,'cleanup_unknown');assert.equal(result.nativeStartup.reason,'native_startup_cleanup_unknown');assert.deepEqual(f.calls,['prepare','close']);});
test('local control cleanup failure does not discard its original object or fake an empty owner',async()=>{const f=fixture(),result=await settleNativeStartupFailure(Error('startup'),{...f.options,serverChild:null,host:null,cleanupUnstarted:async()=>{throw Error('private details must stay private');}});assert.equal(result.nativeStartup.state,'cleanup_unknown');assert.equal(result.nativeStartup.reason,'native_startup_local_cleanup_unknown');assert.strictEqual(result.nativeOwner,f.owner);assert.equal(JSON.stringify(result.nativeStartup).includes('private details'),false);});
test('actual startup controller rejects existing admissions before acquiring any fence',async()=>{let actions=0;const epoch=randomUUID(),c=createNativeMaintenanceController({runtimePid:42,account:'A',request:async(route)=>{if(route.endsWith('state'))return {version:1,pid:42,ownerEpoch:epoch,acceptingTurns:true,admitted:[{}],historyAttention:[],admissionSha256:'a'.repeat(64),...Object.fromEntries(keys.map(key=>[key,0]))};actions++;throw Error('must not acquire');}});await assert.rejects(c.prepareStartupCleanup(),/startup_admission_present/);assert.equal(actions,0);});
test('admission racing the startup fence is refused and only that caller fence is released',async()=>{const epoch=randomUUID(),operations=[];let held;const state={version:1,pid:42,ownerEpoch:epoch,acceptingTurns:true,admitted:[],historyAttention:[],admissionSha256:'a'.repeat(64),...Object.fromEntries(keys.map(key=>[key,0]))};
 const c=createNativeMaintenanceController({runtimePid:42,account:'A',request:async(route,_method,body)=>{if(route.endsWith('state'))return state;operations.push({...body});if(body.action==='acquire'){held=body.operationId;return {...state,state:'native_owner_fenced',fenceId:held,acceptingTurns:false,admitted:[{}]};}assert.equal(body.operationId,held);return {state:'native_fence_released',pid:42,ownerEpoch:epoch,fenceId:held};}});
 await assert.rejects(c.prepareStartupCleanup(),/startup_admission_present/);assert.deepEqual(operations.map(x=>x.action),['acquire','release']);assert.equal(new Set(operations.map(x=>x.operationId)).size,1);
});
test('startup controller accepts only current original zero-admission owner with all physical work settled',async()=>{for(const key of [null,...keys]){const epoch=randomUUID(),state={version:1,pid:42,ownerEpoch:epoch,acceptingTurns:true,admitted:[],historyAttention:[],admissionSha256:'a'.repeat(64),...Object.fromEntries(keys.map(k=>[k,k===key?1:0]))},calls=[];
 const c=createNativeMaintenanceController({runtimePid:42,account:'A',request:async(route,_method,body)=>{if(route.endsWith('state'))return state;calls.push(body.action);if(body.action==='release')return {state:'native_fence_released',pid:42,ownerEpoch:epoch,fenceId:body.operationId};return {...state,state:'native_owner_fenced',fenceId:body.operationId,acceptingTurns:false};}});
 if(key){await assert.rejects(c.prepareStartupCleanup(),/fence_unknown/);assert.deepEqual(calls,['acquire','release']);}else{const proof=await c.prepareStartupCleanup();assert.deepEqual(proof.nativeTurns,[]);assert.equal(proof.runtimePid,42);assert.deepEqual(calls,['acquire']);}
}});
// Run the saved start() function with owned in-memory process/browser surfaces.
// No filesystem, network, account profile, model or external process is used.
function startupFixture({guardReady=true,buildPresent=true,hostReady=true,admitted=[],physicalCleanup=0,unknownShutdown=false}={}){
 const source=fs.readFileSync(path.resolve(__dirname,'../electron-host.cjs'),'utf8'),from=source.indexOf('async function start({'),to=source.indexOf('\nmodule.exports=',from);assert.ok(from>0&&to>from);
 const counts={controlCreated:0,controlClosed:0,destroyed:0,spawned:0,shutdowns:0,acquires:0,releases:0,listenerStopped:0},epoch=randomUUID(),child=new EventEmitter();Object.assign(child,{pid:42001,exitCode:null,signalCode:null,stdout:{resume(){}},stderr:{resume(){}},kill(){throw Error('startup cannot kill');}});
 const finish=()=>{child.exitCode=0;child.emit('exit',0,null);};let held=null,port=40000,listenerReady=false,owner;
 const state=()=>({version:1,pid:child.pid,ownerEpoch:epoch,acceptingTurns:!held,fenceId:held,admitted,historyAttention:[],admissionSha256:'a'.repeat(64),...Object.fromEntries(keys.map(key=>[key,key==='physicalCleanup'?physicalCleanup:0]))});
 const localJson=async(url,_method,body)=>{
  if(url.endsWith('/healthz'))return {pid:listenerReady?42002:child.pid}; // fail after the real listener is established
  if(url.endsWith('/admin/maintenance-state'))return state();
  if(url.endsWith('/admin/maintenance-fence')){assert.equal(body.expectedPid,child.pid);assert.equal(body.expectedOwnerEpoch,epoch);
   if(body.action==='acquire'){counts.acquires++;held=body.operationId;return {...state(),state:'native_owner_fenced',priorDraining:false};}
   assert.equal(body.operationId,held);if(body.action==='verify')return {...state(),state:'native_owner_fenced',priorDraining:false};
   if(body.action==='release'){counts.releases++;const original=held;held=null;return {state:'native_fence_released',pid:child.pid,ownerEpoch:epoch,fenceId:original};}
  }
  if(url.endsWith('/admin/shutdown')){counts.shutdowns++;assert.equal(body.operationId,held);if(unknownShutdown)throw Error('fixture reply lost');setImmediate(finish);return {state:'native_shutdown_accepted',shutdownDispatched:true,pid:child.pid,ownerEpoch:epoch,operationId:held};}
  throw Error('unexpected request');
 };
 class Control{constructor(){counts.controlCreated++;}async start(){return this;}descriptor(){return {};}async close(){counts.controlClosed++;}}
 class Host{constructor(){this.turnTabs=new Map();this.view={webContents:{isDestroyed:()=>false,getURL:()=>''}};}async ready(){if(!hostReady)throw Error('fixture_browser_not_ready');}setBounds(bounds){assert.equal(bounds.width,1200);assert.equal(bounds.height,900);assert.equal(bounds.x,0);assert.equal(bounds.y,0);}beginTurn(){throw Error('model forbidden');}destroy(){counts.destroyed++;}}
 const fakeJournal={get:()=>({}),list:()=>[],cachedList:()=>({rows:[],status:{}}),history:()=>({}),recordIndex:()=>({}),ownerClosed(){throw Error('startup cannot rewrite original records');}};
 const fakeRequire=name=>{
  if(name==='./mcp-activity.cjs')return {createActivityProjection:()=>()=>null};
  if(name==='./tool-readiness.cjs')return {createToolCheck:()=>({snapshot:()=>({ready:false}),check:async()=>({ready:false})})};
  if(name==='../web-host/account-access.cjs')return {publicAccessLimit:()=>false};
  if(name==='./upstream/launcher/electron/control-server.cjs')return {BrowserControlServer:Control};
  if(name==='./upstream/launcher/electron/browser-host.cjs')return {BrowserHost:Host};
  if(name==='./turn-journal.cjs')return {installTurnJournal:()=>fakeJournal};
  if(name==='./home-navigation.cjs')return {installSlowNavigationNotice:()=>{}};
  if(name==='./native-maintenance.cjs')return {createNativeMaintenanceController};
  throw Error('unexpected dependency '+name);
 };
 const context=vm.createContext({fs:{mkdirSync(){},appendFileSync(){},existsSync:()=>buildPresent},path,process:{env:{},execPath:'fixture',pid:501},__dirname:path.resolve(__dirname,'..'),require:fakeRequire,
  cfg:{PROXY:'fixture',webAccount:()=> 'A',paths:()=>({home:'D:/fixture',helper:'helper',bun:'bun',config:'config',upstream:'upstream',descriptor:'descriptor',status:'status'}),isolatedEnvironment:()=>({}),runtimeConfig:()=>({controlToken:'fixture',appName:'fixture'})},
  freePort:async()=>++port,createNativeActivityProjection:()=>({start(){},stop(){},snapshot:()=>({})}),createRuntimeFailureState:()=>({watch(){},apply:x=>x,failed:false}),writePrivateFileAtomic(){},
  localJson,createListenerSupervisor:()=>({async start(){listenerReady=true;},prepareMaintenance:()=>({pid:43001}),async stopMaintenance(){counts.listenerStopped++;return {pid:43001,code:0,signal:null};},resumeMaintenance(){},stop(){throw Error('ordinary listener stop forbidden');}}),
  // Windows timer scheduling under parallel tests can exceed 10ms before the
  // fixture's setImmediate exit. Keep the wait short, with a realistic margin.
  spawn:()=>{counts.spawned++;return child;},createNativeMaintenanceExit:options=>createNativeMaintenanceExit({...options,timeoutMs:100}),settleNativeStartupFailure,canReverifyTools:()=>false,
  setInterval:()=>({unref(){}}),clearInterval(){},setTimeout,clearTimeout,queueMicrotask,setImmediate,delay:async()=>{},Object,Error,Promise,Set,Map});
 vm.runInContext(source.slice(from,to)+'\nthis.start=start;',context);
 return {counts,finish,run:async()=>{try{await context.start({root:'D:/fixture',window:{show(){},getContentSize:()=>[1200,900]},guard:{ready:guardReady},configured:{selected:{transport:'shared-mcp'},cdpPort:1},accountAccess:{snapshot:()=>({}),admitNavigation:async()=>{}}});throw Error('expected failed startup');}catch(error){owner=error.nativeOwner;return error;}},get owner(){return owner;},fence:()=>held};
}
test('actual saved start fails build/VPN before creating any browser or execution owner',async()=>{for(const input of [{guardReady:false},{buildPresent:false}]){const f=startupFixture(input),error=await f.run();assert.equal(error.nativeStartup.state,'not_started');assert.equal(error.nativeStartup.ownerStarted,false);assert.deepEqual(f.counts,{controlCreated:0,controlClosed:0,destroyed:0,spawned:0,shutdowns:0,acquires:0,releases:0,listenerStopped:0});}});
test('actual saved start preserves a partially created browser when no execution proof exists',async()=>{const f=startupFixture({hostReady:false}),error=await f.run();assert.equal(error.nativeStartup.state,'cleanup_unknown');assert.strictEqual(error.nativeOwner,f.owner);assert.equal(typeof f.owner.prepareMaintenance,'function');assert.throws(()=>f.owner.turns(),/startup_unresolved/);await assert.rejects(f.owner.close(),/original_fence_required/);assert.equal(f.counts.destroyed,0);assert.equal(f.counts.controlClosed,0);assert.equal(f.counts.spawned,0);});
test('actual saved start cleans a published listener failure only by original zero-admission normal exit',async()=>{const f=startupFixture(),error=await f.run();assert.equal(error.nativeStartup.state,'cleaned');assert.equal(error.nativeStartup.ownerStarted,false);assert.equal(error.nativeStartup.receipt.runtimeExit.code,0);assert.equal(error.nativeStartup.receipt.listenerExit.code,0);assert.deepEqual(f.counts,{controlCreated:1,controlClosed:1,destroyed:1,spawned:1,shutdowns:1,acquires:1,releases:0,listenerStopped:1});assert.strictEqual(await f.owner.close(),error.nativeStartup.receipt);});
test('actual saved start refuses cleanup for admitted or physically unfinished work without cancelling it',async()=>{for(const input of [{admitted:[{}]},{physicalCleanup:1}]){const f=startupFixture(input),error=await f.run();assert.equal(error.nativeStartup.state,'cleanup_unknown');assert.equal(error.nativeStartup.ownerStarted,true);assert.equal(f.counts.shutdowns,0);assert.equal(f.counts.destroyed,0);assert.equal(f.counts.controlClosed,0);await assert.rejects(f.owner.close(),/original_fence_required/);}});
test('actual saved start retains dispatched unknown close and completes only the original late exit',async()=>{const f=startupFixture({unknownShutdown:true}),error=await f.run();assert.equal(error.nativeStartup.state,'cleanup_unknown');assert.equal(error.nativeStartup.maintenanceClose.shutdownDispatched,true);assert.equal(f.counts.shutdowns,1);assert.equal(f.counts.releases,0);assert.equal(f.counts.destroyed,0);const events=[];f.owner.onMaintenanceExit(receipt=>events.push(receipt));f.finish();for(let i=0;i<100&&!events.length;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(events.length,1);assert.equal(events[0].state,'exited');assert.equal(f.counts.shutdowns,1);assert.equal(f.counts.releases,0);assert.equal(f.counts.destroyed,1);assert.equal(f.counts.controlClosed,1);});
function listenerFixture({unknownExit=false}={}){
 const source=fs.readFileSync(path.resolve(__dirname,'../electron-host.cjs'),'utf8'),from=source.indexOf('function createListenerSupervisor('),to=source.indexOf('\nfunction createRuntimeFailureState',from);assert.ok(from>0&&to>from);
 const child=new EventEmitter(),stdin=new EventEmitter(),stdout=new EventEmitter();let spawns=0,kills=0,writes=[];
 const finish=()=>{child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);};Object.assign(stdin,{destroyed:false,write(raw,callback){writes.push(JSON.parse(raw));callback?.();if(!unknownExit)setImmediate(finish);}});
 Object.assign(child,{pid:43001,exitCode:null,signalCode:null,stdin,stdout,stderr:{resume(){}},kill(){kills++;throw Error('unknown startup listener cannot kill');}});
 const context=vm.createContext({spawn:()=>{spawns++;return child;},randomBytes:require('node:crypto').randomBytes,waitNormalChildExit,setTimeout,clearTimeout,Promise,Error,JSON});
 vm.runInContext(source.slice(from,to)+'\nthis.create=createListenerSupervisor;',context);
 const supervisor=context.create({executable:'fixture',script:'fixture',publicPort:43002,ownerPort:43003,ownerPid:42001,readyTimeoutMs:5});
 return {supervisor,child,finish,counts:()=>({spawns,kills,writes}),fail:async(output)=>{const pending=supervisor.start();if(output!==undefined)setImmediate(()=>stdout.emit('data',Buffer.from(output)));await assert.rejects(pending,/bridge_listener_(start_timeout|invalid_ready)/);}};
}
test('actual listener missing/malformed READY keeps the original child and stream, never kill or replacement',async()=>{
 for(const output of [undefined,'not-json\n','x'.repeat(4097),JSON.stringify({ready:true,pid:99999,port:43002})+'\n',JSON.stringify({ready:true,pid:43001,port:99999})+'\n']){
  const f=listenerFixture();await f.fail(output);assert.equal(f.supervisor.snapshot().state,'startup_unresolved');assert.equal(f.supervisor.snapshot().pid,f.child.pid);assert.equal(f.counts().kills,0);
  await assert.rejects(f.supervisor.start(),/original_start_unresolved/);assert.equal(f.counts().spawns,1);
  const key=randomUUID();assert.equal(f.supervisor.prepareMaintenance({ownerPid:42001,operationId:key}).pid,f.child.pid);
  const receipt=await f.supervisor.stopMaintenance({ownerPid:42001,operationId:key,timeoutMs:30});assert.deepEqual(receipt,{pid:f.child.pid,code:0,signal:null});
  assert.equal(f.counts().writes.length,1);assert.equal(f.counts().writes[0].operationId,key);assert.equal(f.counts().writes[0].listenerPid,f.child.pid);assert.equal(f.counts().writes[0].capability,f.child.listenerCapability);assert.equal(f.counts().kills,0);
 }
});
test('startup listener graceful ACK timeout retains its original key/PID and does not replay or kill',async()=>{
 const f=listenerFixture({unknownExit:true});await f.fail();const key=randomUUID();f.supervisor.prepareMaintenance({ownerPid:42001,operationId:key});
 await assert.rejects(f.supervisor.stopMaintenance({ownerPid:42001,operationId:key,timeoutMs:5}),/child_exit_unknown/);
 await assert.rejects(f.supervisor.start(),/original_start_unresolved/);assert.equal(f.counts().spawns,1);assert.equal(f.counts().writes.length,1);assert.equal(f.counts().kills,0);
 assert.throws(()=>f.supervisor.resumeMaintenance(key),/original_operation_required/);f.finish();assert.deepEqual(await f.supervisor.stopMaintenance({ownerPid:42001,operationId:key,timeoutMs:5}),{pid:f.child.pid,code:0,signal:null});assert.equal(f.counts().writes.length,1);assert.equal(f.counts().kills,0);
});
