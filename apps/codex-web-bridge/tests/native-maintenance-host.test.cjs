'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const {createNativeMaintenanceExit}=require('../native-maintenance-exit.cjs');
// Execute the saved production close function and publication boundary with
// isolated children/control surfaces, rather than duplicate its branching.
function hostFixture({writeFails=false,late=false,hasProof=true}={}){
 const source=fs.readFileSync(path.resolve(__dirname,'../electron-host.cjs'),'utf8'),start=source.indexOf('  async function close(){'),end=source.indexOf('\n  try{\n    if(!fs.existsSync',start);
 assert.ok(start>0&&end>start);const publication=source.match(/  const publishMaintenanceStatus=\(\)=>\{[^\n]+\};/)[0];
 const child=new EventEmitter();Object.assign(child,{pid:42001,exitCode:null,signalCode:null,kill(){throw Error('maintenance cannot kill');}});
 const proof={runtimePid:child.pid,ownerEpoch:randomUUID(),fenceId:randomUUID(),nativeTurns:[]};let sends=0,destroyed=0,controlClosed=0,listenerStops=0,published=0;const events=[];
 const finish=()=>{child.exitCode=0;child.emit('exit',0,null);};
 const context=vm.createContext({closed:false,maintenanceProof:hasProof?proof:null,maintenanceExit:null,maintenanceExitReceipt:null,maintenanceClosePromise:null,serverChild:child,tunnelChild:null,
  listenerSupervisor:{prepareMaintenance:()=>({pid:43001}),stopMaintenance:async()=>{listenerStops++;return {pid:43001,code:0,signal:null};},stop:async()=>{throw Error('ordinary stop forbidden');}},
  createNativeMaintenanceExit:options=>createNativeMaintenanceExit({...options,timeoutMs:30}),maintenanceMethods:{verifyMaintenance:async()=>proof,finalVerifyMaintenance:()=>proof},
  ownerEndpoint:'http://127.0.0.1:1',config:{controlToken:'isolated'},localJson:async(_url,_method,body)=>{sends++;assert.equal(body.operationId,proof.fenceId);if(!late)setImmediate(finish);return {state:'native_shutdown_accepted',shutdownDispatched:true,pid:proof.runtimePid,ownerEpoch:proof.ownerEpoch,operationId:proof.fenceId};},
  nativeActivity:{stop(){}},clearInterval(){},accessMonitor:null,host:{destroy(){destroyed++;}},control:{async close(){controlClosed++;}},status:{},
  publish(){published++;if(writeFails)throw Error('isolated status disk failure');},emitMaintenanceExit(receipt){context.maintenanceExitReceipt=receipt;events.push(receipt);},
  journal:{ownerClosed(){throw Error('historical mutation forbidden');}},queueMicrotask,Object,Error});
 vm.runInContext(publication+'\n'+source.slice(start,end)+'\nthis.close=close;',context);
 return {context,proof,events,finish,counts:()=>({sends,destroyed,controlClosed,listenerStops,published})};
}
test('support status write failure cannot hide a real original exit or strand its completion callback',async()=>{
 const f=hostFixture({writeFails:true});const receipt=await f.context.close();assert.equal(receipt.state,'exited');assert.equal(receipt.supportStatusPublished,false);assert.equal(f.events.length,1);
 assert.deepEqual(f.counts(),{sends:1,destroyed:1,controlClosed:1,listenerStops:1,published:1});assert.strictEqual(await f.context.close(),receipt);
});
test('public close without the original proof refuses before any cancellation, shutdown or surface destruction',async()=>{
 const f=hostFixture({hasProof:false});await assert.rejects(f.context.close(),error=>{
  assert.equal(error.message,'native_maintenance_original_fence_required');assert.equal(error.maintenanceClose.state,'refused');
  assert.equal(error.maintenanceClose.runtimePid,42001);assert.equal(error.maintenanceClose.shutdownDispatched,false);assert.equal(error.maintenanceClose.stage,'before_shutdown');return true;
 });assert.equal(f.context.closed,false);assert.deepEqual(f.counts(),{sends:0,destroyed:0,controlClosed:0,listenerStops:0,published:0});assert.equal(f.events.length,0);
 await assert.rejects(f.context.close(),/original_fence_required/);assert.equal(f.context.maintenanceExit,null);
});
test('saved electron close publishes a late original exit automatically and cleans each local surface once',async()=>{
 const f=hostFixture({late:true});await assert.rejects(f.context.close(),e=>e.maintenanceClose.state==='unknown');assert.equal(f.events.length,0);f.finish();
 for(let i=0;i<100&&f.events.length===0;i++)await new Promise(r=>setTimeout(r,2));assert.equal(f.events.length,1);assert.equal(f.events[0].fenceId,f.proof.fenceId);
 assert.deepEqual(f.counts(),{sends:1,destroyed:1,controlClosed:1,listenerStops:1,published:1});
});
