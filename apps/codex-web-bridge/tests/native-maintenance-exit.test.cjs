'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const {createNativeMaintenanceExit}=require('../native-maintenance-exit.cjs');
function fixture({timeoutMs=100,shutdown,listener,hasOwnedTunnel}={}){
 const child=new EventEmitter();Object.assign(child,{pid:42001,exitCode:null,signalCode:null});
 const proof={runtimePid:child.pid,ownerEpoch:randomUUID(),fenceId:randomUUID()};let sends=0;
 const exit=createNativeMaintenanceExit({child,getProof:()=>proof,verify:async()=>proof,finalVerify:()=>proof,listener,hasOwnedTunnel,timeoutMs,
  shutdown:async identity=>{sends++;if(shutdown)return shutdown(identity,child);return {pid:identity.runtimePid,ownerEpoch:identity.ownerEpoch,operationId:identity.fenceId,state:'native_shutdown_accepted',shutdownDispatched:true};}});
 return {exit,child,proof,sends:()=>sends,finish(code=0,signal=null){child.exitCode=code;child.signalCode=signal;child.emit('exit',code,signal);}};
}
test('transport reply lost retains the original shutdown identity; retry waits without another POST',async()=>{
 const x=fixture({shutdown:()=>{throw Error('lost PRIVATE reply');}});await assert.rejects(x.exit.close(),e=>e.maintenanceClose.stage==='shutdown_dispatched'&&e.maintenanceClose.state==='unknown'&&!e.message.includes('PRIVATE'));
 x.finish();const receipt=await x.exit.close();assert.equal(x.sends(),1);assert.equal(receipt.fenceId,x.proof.fenceId);assert.equal(receipt.runtimeExit.code,0);assert.equal(receipt.state,'exited');assert.strictEqual(await x.exit.close(),receipt);
});
test('late original server exit continues its original listener and notifies without any caller retry',async()=>{
 let stops=0;const x=fixture({listener:{prepareMaintenance:()=>({pid:43001}),stopMaintenance:async()=>{stops++;return {pid:43001,code:0,signal:null};}}});let receipt;
 const notified=new Promise(resolve=>{x.exit.onSettlement(value=>{receipt=value;resolve();});});await assert.rejects(x.exit.close(),/child_exit_unknown/);x.finish();await notified;
 assert.equal(receipt.state,'exited');assert.equal(receipt.fenceId,x.proof.fenceId);assert.equal(stops,1);assert.equal(x.sends(),1);
});
test('known original refusal and unavailable dedicated tunnel happen before shutdown; foreign refusal stays unknown',async()=>{
 const x=fixture({shutdown:id=>({pid:id.runtimePid,ownerEpoch:id.ownerEpoch,operationId:id.fenceId,status:'refused',shutdownDispatched:false})});
 await assert.rejects(x.exit.close(),e=>e.maintenanceClose.stage==='before_shutdown'&&!e.maintenanceClose.shutdownDispatched);assert.equal(x.exit.shutdownDispatched,false);
 const tunnel=fixture({hasOwnedTunnel:()=>true});await assert.rejects(tunnel.exit.close(),/tunnel_graceful_unavailable/);assert.equal(tunnel.sends(),0);
 const foreign=fixture({shutdown:id=>({pid:999,ownerEpoch:id.ownerEpoch,operationId:id.fenceId,status:'refused',shutdownDispatched:false})});
 await assert.rejects(foreign.exit.close(),e=>e.maintenanceClose.shutdownDispatched===true);assert.equal(foreign.sends(),1);
});
test('nonzero or signaled child exit is not normal maintenance completion',async()=>{
 for(const [code,signal] of [[1,null],[null,'SIGTERM']]){const x=fixture();const pending=x.exit.close();setImmediate(()=>x.finish(code,signal));await assert.rejects(pending,e=>e.maintenanceClose.state==='failed'&&e.maintenanceClose.shutdownDispatched);}
});
test('listener timeout after native exit retains the original wait and completes automatically without replay',async()=>{
 let n=0,settle;const gate=new Promise(r=>{settle=r;}),listener={prepareMaintenance(){return {pid:43001};},async stopMaintenance(){n++;await gate;return {pid:43001,code:0,signal:null};}};
 const x=fixture({listener});let observed;const notified=new Promise(r=>{x.exit.onSettlement(value=>{observed=value;r();});});const pending=x.exit.close();setImmediate(()=>x.finish());await assert.rejects(pending,/child_exit_unknown/);
 settle();await notified;assert.equal(observed.listenerExit.pid,43001);assert.equal(x.sends(),1);assert.equal(n,1);assert.strictEqual(await x.exit.close(),observed);
});
test('real isolated original child exits normally without kill or a replacement PID probe',async()=>{
 const child=spawn(process.execPath,['-e',"process.stdin.once('data',()=>{process.stdin.destroy();});"],{windowsHide:true,stdio:['pipe','ignore','ignore']});
 const proof={runtimePid:child.pid,ownerEpoch:randomUUID(),fenceId:randomUUID()};let sends=0;
 const exit=createNativeMaintenanceExit({child,getProof:()=>proof,verify:async()=>proof,finalVerify:()=>{},timeoutMs:3000,
  shutdown:async id=>{sends++;child.stdin.write('stop\n');return {pid:id.runtimePid,ownerEpoch:id.ownerEpoch,operationId:id.fenceId,state:'native_shutdown_accepted',shutdownDispatched:true};}});
 const result=await exit.close();assert.deepEqual(result.runtimeExit,{pid:child.pid,code:0,signal:null});assert.equal(sends,1);
});
async function actualOwnerCase(t,rejectCleanup=false){
 const bun=path.resolve(__dirname,'../../../.local/runtimes/bun-1.4.0/bun.exe');assert.equal(fs.existsSync(bun),true,'bundled isolated test runtime must exist');
 // Production config deliberately rejects ephemeral service entries; this is an
 // isolated, owned evidence directory, never an installed profile or service.
 const fixtures=path.resolve(__dirname,'../../../.local/native-history-compat-20261004/exit-fixtures');fs.mkdirSync(fixtures,{recursive:true});
 const home=fs.mkdtempSync(path.join(fixtures,'owner-')),token=randomUUID(),epoch=randomUUID(),file=path.join(home,'owner.ts');
 const configUrl=pathToFileURL(path.resolve(__dirname,'../upstream/src/config.ts')).href,serverUrl=pathToFileURL(path.resolve(__dirname,'../upstream/src/server.ts')).href;
 const workerUrl=pathToFileURL(path.resolve(__dirname,'../upstream/src/adapters/chatgpt-web/browser-worker.ts')).href;
 fs.writeFileSync(file,`import {defaultConfig,providerConfig} from ${JSON.stringify(configUrl)};\nimport {startServer} from ${JSON.stringify(serverUrl)};\nimport {ChatGptBrowserWorker} from ${JSON.stringify(workerUrl)};\nconst config={...defaultConfig('browser-only'),port:0,storageStatePath:${JSON.stringify(path.join(home,'never-opened.json'))},controlToken:${JSON.stringify(token)}};\n${rejectCleanup?"ChatGptBrowserWorker.forProvider(providerConfig(config)).close=async()=>{throw Error('isolated cleanup rejection');};":''}\nconst server=startServer(config,{maintenanceAuthority:{ownerEpoch:${JSON.stringify(epoch)},read:()=>({admitted:[],historyAttention:[],admissionSha256:'a'.repeat(64)})},onShutdownSettled:value=>{if(value.maintenance)process.exit(value.clean?0:1);}});\nconsole.log(JSON.stringify({pid:process.pid,port:server.port}));\nawait new Promise(()=>{});\n`);
 const child=spawn(bun,['run',file],{cwd:home,env:{...process.env,CODEX_CHATGPT_WEB_HOME:home},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let listener,stderr='';child.stderr.on('data',part=>{if(stderr.length<2048)stderr+=part;});const oldKill=child.kill.bind(child);let kills=0;
 try{
  // Full-suite parallel module imports need a bounded fixture startup budget;
  // readiness identity and maintenance exit assertions remain unchanged.
  const ready=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('isolated owner startup timeout')),15000);child.stdout.on('data',x=>{text+=x;const i=text.indexOf('\n');if(i<0)return;clearTimeout(timer);try{resolve(JSON.parse(text.slice(0,i)));}catch{reject(Error('isolated owner readiness invalid'));}});child.once('exit',()=>{clearTimeout(timer);reject(Error('isolated owner exited before ready: '+stderr));});});
  assert.equal(ready.pid,child.pid);const {freePort,localJson,createListenerSupervisor}=require('../electron-host.cjs'),{createNativeMaintenanceController}=require('../native-maintenance.cjs');
  const endpoint='http://127.0.0.1:'+ready.port,controller=createNativeMaintenanceController({runtimePid:child.pid,home,account:'A',sessionsRoot:path.join(home,'sessions'),request:(route,method,body)=>localJson(endpoint+route,method,body,token,{maintenance:true})});
  let proof=await controller.prepareMaintenance();let publicPort=await freePort();while(publicPort===ready.port)publicPort=await freePort();
  listener=createListenerSupervisor({executable:bun,script:path.resolve(__dirname,'../public-listener.cjs'),publicPort,ownerPort:ready.port,ownerPid:child.pid,cwd:home,env:{...process.env,CODEX_CHATGPT_WEB_HOME:home}});await listener.start();
  child.kill=()=>{kills++;throw Error('maintenance must not kill');};
  const exit=createNativeMaintenanceExit({child,listener,getProof:()=>proof,verify:async p=>(proof=await controller.verifyMaintenance(p)),finalVerify:p=>controller.finalVerifyMaintenance(p),timeoutMs:6000,
   shutdown:id=>localJson(endpoint+'/admin/shutdown','POST',{operationId:id.fenceId,expectedPid:id.runtimePid,expectedOwnerEpoch:id.ownerEpoch,expectedNativeTurns:proof.nativeTurns},token,{maintenance:true})});
  if(rejectCleanup){await assert.rejects(exit.close(),e=>e.maintenanceClose.state==='failed'&&e.maintenanceClose.shutdownDispatched);assert.equal(child.exitCode,1);assert.equal(kills,0);}
  else{const result=await exit.close();assert.equal(result.state,'exited');assert.equal(result.runtimePid,ready.pid);assert.equal(result.ownerEpoch,epoch);assert.equal(result.runtimeExit.code,0);assert.equal(result.listenerExit.code,0);assert.equal(kills,0);}
 }finally{child.kill=oldKill;if(child.exitCode===null){oldKill();await new Promise(r=>child.once('exit',r));}await listener?.stop();fs.rmSync(home,{recursive:true,force:true});}
}
test('actual isolated Bun owner fence and shutdown plus its original listener produce normal exit receipts',t=>actualOwnerCase(t));
test('actual original Bun worker cleanup rejection exits one and is never recorded as normal maintenance',t=>actualOwnerCase(t,true));
