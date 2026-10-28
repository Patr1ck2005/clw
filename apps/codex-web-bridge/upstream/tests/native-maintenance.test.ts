import {test,expect} from 'bun:test';
import fs,{mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createNativeMaintenanceFence} from '../src/native-maintenance';
import {createMaintenanceOperationHistory} from '../src/native-maintenance-history';
import {ChatGptTurnSessions,ChatGptTextFeed,ChatGptTraceFeed} from '../src/adapters/chatgpt-web/turn-execution';
import {runStructuredCompactionOnce,structuredCompactionMaintenanceState} from '../src/adapters/chatgpt-web/compaction-handoff';
import {TurnBroker,RemoteTurnBroker,callTurnBroker,type BrokerToolResult} from '../src/adapters/chatgpt-web/turn-broker';
import {startServer} from '../src/server';
import {defaultConfig,defaultBrokerEndpoint} from '../src/config';
import {createNativeTurnAdmission,currentNativeOwnerAdmissions} from '../../native-turn-admission';
import {readNativeOwnerAdmissions} from '../../native-owner-admissions';
import source from '../../turn-source.cjs';
import {observedAdapter} from '../../observed-adapter';
import {ChatGptBrowserWorker} from '../src/adapters/chatgpt-web/browser-worker';
import {providerConfig} from '../src/config';

const thread='01a10714-bd83-7830-87b6-3d663d9f8ba2',turn='01a10714-c266-7e91-9feb-a6049a761218',trace='abcdef123456';
const empty=()=>({admitted:[],historyAttention:[],admissionSha256:'a'.repeat(64)});

test('maintenance history beyond 256 cycles is archived; current snapshot never scans terminal history and original keys stay ended',()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-maintenance-history-')),epoch=randomUUID(),keys:string[]=[];let draining=false,fenced=false,active=0;
 const make=()=>createNativeMaintenanceFence({pid:42,authority:{ownerEpoch:epoch,operationHistoryDirectory:home,read:empty},
  readCounters:()=>({activeHttp:active}),isDraining:()=>draining,setDraining:v=>{draining=v;},setBrokerFence:v=>{fenced=v;}});
 const input=(key:string,action:string)=>({expectedPid:42,expectedOwnerEpoch:epoch,operationId:key,action});
 try{
  const f=make();for(let n=0;n<300;n++){const key=randomUUID();keys.push(key);expect(f.action(input(key,'acquire')).state).toBe('native_owner_fenced');expect(f.action(input(key,'release')).state).toBe('native_fence_released');}
  const refused=randomUUID();active=1;expect(()=>f.action(input(refused,'acquire'))).toThrow('execution_active');active=0;
  expect(()=>f.action(input(refused,'acquire'))).toThrow('original_operation_ended');expect(()=>f.action(input(keys[0]!,'acquire'))).toThrow('original_operation_ended');
  expect(f.action(input(keys[0]!,'release')).replayed).toBeTrue();expect(draining).toBeFalse();expect(fenced).toBeFalse();
  const history=createMaintenanceOperationHistory(42,epoch,home);expect(history.pendingCount()).toBe(0);expect(history.read(keys[0]!)).toBe('released');
  const recreated=make();expect(()=>recreated.action(input(keys.at(-1)!,'acquire'))).toThrow('original_operation_ended');
  const nativeRead=fs.readFileSync,nativeList=fs.readdirSync;let reads=0,lists=0;
  fs.readFileSync=((...args:any[])=>{reads++;return (nativeRead as any)(...args);}) as any;
  fs.readdirSync=((...args:any[])=>{lists++;return (nativeList as any)(...args);}) as any;
  try{for(let n=0;n<5;n++)expect(recreated.snapshot().fenceId).toBeNull();expect(reads).toBe(0);expect(lists).toBe(0);}
  finally{fs.readFileSync=nativeRead;fs.readdirSync=nativeList;}
  const next=randomUUID();expect(recreated.action(input(next,'acquire')).state).toBe('native_owner_fenced');expect(recreated.action(input(next,'release')).state).toBe('native_fence_released');
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('maintenance archive write failure keeps original fence and broker drain; corrupt same-key history is unknown',()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-maintenance-history-failure-')),historyPath=join(home,'archive'),epoch=randomUUID(),key=randomUUID();let draining=false,fenced=false;
 const f=createNativeMaintenanceFence({pid:42,authority:{ownerEpoch:epoch,operationHistoryDirectory:historyPath,read:empty},readCounters:()=>({activeHttp:0}),
  isDraining:()=>draining,setDraining:v=>{draining=v;},setBrokerFence:v=>{fenced=v;}}),input={expectedPid:42,expectedOwnerEpoch:epoch,operationId:key};
 try{f.action({...input,action:'acquire'});writeFileSync(historyPath,'owned isolated write failure');
  expect(()=>f.action({...input,action:'release'})).toThrow();expect(f.ownership(key).operationState).toBe('fenced');expect(draining).toBeTrue();expect(fenced).toBeTrue();
  expect(()=>f.action({...input,operationId:randomUUID(),action:'acquire'})).toThrow('fence_owned');unlinkSync(historyPath);
  expect(f.action({...input,action:'release'}).state).toBe('native_fence_released');expect(draining).toBeFalse();
  const dir=join(historyPath,fs.readdirSync(historyPath)[0]!);writeFileSync(join(dir,key+'.json'),'broken original tombstone');
  expect(()=>f.action({...input,action:'acquire'})).toThrow('history_unknown');expect(f.ownership(key).operationState).toBe('unknown');
 }finally{rmSync(home,{recursive:true,force:true});}
});
function fenceFixture(prior=false){let draining=prior,fenced=false,active=0,read=empty;
 const epoch=randomUUID(),key=randomUUID(),input={expectedPid:42,expectedOwnerEpoch:epoch,operationId:key};
 const f=createNativeMaintenanceFence({pid:42,authority:{ownerEpoch:epoch,read:()=>read()},readCounters:()=>({activeHttp:active}),isDraining:()=>draining,setDraining:v=>{draining=v;},setBrokerFence:v=>{fenced=v;}});
 return {f,input,key,setActive:v=>{active=v;},setRead:fn=>{read=fn;},state:()=>({draining,fenced})};}
test('original identity and caller fence CAS preserve prior and concurrent foreign drain',()=>{const x=fenceFixture(true);expect(()=>x.f.action({...x.input,action:'acquire',expectedPid:43})).toThrow('owner_changed');x.f.action({...x.input,action:'acquire'});
 expect(()=>x.f.action({...x.input,action:'release',operationId:randomUUID()})).toThrow('fence_owned');x.f.action({...x.input,action:'release'});expect(x.state()).toEqual({draining:true,fenced:false});expect(()=>x.f.action({...x.input,action:'acquire'})).toThrow('original_operation_ended');
 const y=fenceFixture();y.f.action({...y.input,action:'acquire'});y.f.preserveDrain();y.f.action({...y.input,action:'release'});expect(y.state().draining).toBeTrue();});
test('acquire reply/read failure after fence is observable under the same original key and can release',()=>{const x=fenceFixture();let n=0;x.setRead(()=>{if(++n===2)throw Error('native_maintenance_admission_changed');return empty();});expect(()=>x.f.action({...x.input,action:'acquire'})).toThrow('admission_changed');expect(x.f.ownership(x.key)).toEqual({fenceId:x.key,operationState:'fenced'});
 x.setActive(1);expect(()=>x.f.action({...x.input,action:'acquire'})).toThrow('execution_active');expect(x.f.ownership(x.key).fenceId).toBe(x.key);x.f.action({...x.input,action:'release'});expect(x.state()).toEqual({draining:false,fenced:false});});
test('accepted shutdown seals the same original fence against delayed release or new ownership',()=>{const x=fenceFixture();x.f.action({...x.input,action:'acquire'});x.f.sealShutdown(x.input);expect(()=>x.f.action({...x.input,action:'release'})).toThrow('shutdown_original_unresolved');expect(x.state()).toEqual({draining:true,fenced:true});expect(()=>x.f.action({...x.input,action:'acquire',operationId:randomUUID()})).toThrow('fence_owned');});
test('original fence admission SHA never rebases during a later verify or shutdown preflight',()=>{const x=fenceFixture();x.f.action({...x.input,action:'acquire'});x.setRead(()=>({...empty(),admissionSha256:'b'.repeat(64)}));expect(()=>x.f.action({...x.input,action:'verify'})).toThrow('admission_changed');x.f.action({...x.input,action:'release'});expect(x.state().draining).toBeFalse();});
test('browser final does not hide pending physical cleanup or retired promise',async()=>{const sessions=new ChatGptTurnSessions();let complete!:()=>void;
 const item=sessions.getOrCreate('original',()=>({mode:'read-only',browser:Promise.resolve('final'),physicalSettlement:new Promise<void>(r=>{complete=r;}),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),cancel:()=>{}}));await item.browserOutcome;
 expect(sessions.activeCount()).toBe(0);expect(sessions.maintenanceState().physicalCleanup).toBeGreaterThan(0);sessions.retire('original',item);expect(sessions.maintenanceState().physicalCleanup).toBeGreaterThan(0);complete();await item.physicalSettlement;await Bun.sleep(0);expect(sessions.maintenanceState()).toEqual({activeBrowser:0,physicalCleanup:0});});
test('structured compaction keeps a returned result physically pending until retained owner settles',async()=>{let settle!:()=>void;const gate=new Promise<void>(r=>{settle=r;});const result=runStructuredCompactionOnce(randomUUID(),{ownerKey:randomUUID(),traceIds:[trace]},async(_signal,retain)=>{retain(gate);return 'summary';});expect(await result).toBe('summary');expect(structuredCompactionMaintenanceState().pendingCompactions).toBeGreaterThan(0);settle();await Bun.sleep(0);expect(structuredCompactionMaintenanceState().pendingCompactions).toBe(0);});
test('actual pending broker invocation/activity blocks acquisition; fence rejects new work after settlement',async()=>{
 const home=mkdtempSync(join(tmpdir(),'clw-maintenance-broker-')),endpoint=defaultBrokerEndpoint(home),broker=TurnBroker.forSocket(endpoint,join(home,'activity.jsonl')),remote=new RemoteTurnBroker(endpoint);
 try{await broker.listen();const environment={cwd:home,roots:[home],writableRoots:[home],sandboxPolicy:{type:'dangerFullAccess' as const},tools:[{name:'exec_command',description:'Simulated tool',parameters:{type:'object'}}]};
  const token=await remote.register(environment,60000,trace),{bindingId,activityId}=await callTurnBroker<{bindingId:string;activityId:string}>(endpoint,{method:'claim',token});
  const pending=callTurnBroker<BrokerToolResult>(endpoint,{method:'invoke',bindingId,wireName:'exec_command',arguments:{cmd:'fixture-no-executor'}},10000);
  const [call]=await remote.nextToolBatch(token);let draining=false;const epoch=randomUUID(),f=createNativeMaintenanceFence({pid:42,authority:{ownerEpoch:epoch,read:empty},readCounters:()=>broker.maintenanceState(),isDraining:()=>draining,setDraining:v=>{draining=v;},setBrokerFence:v=>broker.setMaintenanceFenced(v)});
  expect(broker.maintenanceState().brokerPending).toBeGreaterThan(0);expect(()=>f.action({action:'acquire',expectedPid:42,expectedOwnerEpoch:epoch,operationId:randomUUID()})).toThrow('execution_active');
  broker.completeTool(token,call!.callId,{content:[{type:'text',text:'simulated terminal'}]});await pending;
  expect(broker.maintenanceState().brokerPending).toBeGreaterThan(0);await callTurnBroker(endpoint,{method:'activity_complete',token,activityId});
  expect(broker.maintenanceState()).toEqual({brokerPending:0,externalOwners:1});expect(()=>f.action({action:'acquire',expectedPid:42,expectedOwnerEpoch:epoch,operationId:randomUUID()})).toThrow('execution_active');await remote.revoke(token);
  expect(broker.maintenanceState()).toEqual({brokerPending:0,externalOwners:0});const key=randomUUID();f.action({action:'acquire',expectedPid:42,expectedOwnerEpoch:epoch,operationId:key});
  await expect(callTurnBroker(endpoint,{method:'claim',token})).rejects.toThrow('maintenance');await expect(remote.register(environment,60000,trace)).rejects.toThrow('maintenance');
  f.action({action:'release',expectedPid:42,expectedOwnerEpoch:epoch,operationId:key});expect(draining).toBeFalse();
 }finally{await broker.close();rmSync(home,{recursive:true,force:true});}
});
test('current accepted tuples require all original durable layers/source/cwd/account; history corruption is not execution authority',()=>{const home=mkdtempSync(join(tmpdir(),'clw-owner-registry-')),epoch=randomUUID();try{
 const a=createNativeTurnAdmission(home,epoch);a.admit({threadId:thread,turnId:turn},trace);expect(currentNativeOwnerAdmissions(home,epoch)).toEqual([{traceId:trace,threadId:thread,turnId:turn}]);expect(()=>readNativeOwnerAdmissions(home,epoch,'A')).toThrow();
 source.saveSource(home,{traceId:trace,threadId:thread,turnId:turn,account:'A',model:'chatgpt-web/high',workingDirectory:home});expect(readNativeOwnerAdmissions(home,epoch,'A').admitted).toHaveLength(1);
 const dir=join(home,'runtime/native-turn-admission');writeFileSync(join(dir,'trace-bad-history.json'),'malformed PRIVATE');expect(readNativeOwnerAdmissions(home,epoch,'A').admitted).toHaveLength(1);
 const file=join(home,'turn-sources',trace+'.json'),original=readFileSync(file);writeFileSync(file,JSON.stringify({traceId:trace,threadId:thread,turnId:turn,account:'A',model:'chatgpt-web/high'}));expect(()=>readNativeOwnerAdmissions(home,epoch,'A')).toThrow('source_unknown');writeFileSync(file,original);expect(()=>readNativeOwnerAdmissions(home,epoch,'B')).toThrow('source_unknown');
 unlinkSync(join(dir,'trace-'+trace+'.json'));expect(()=>readNativeOwnerAdmissions(home,epoch,'A')).toThrow();
 }finally{rmSync(home,{recursive:true,force:true});}});
test('actual observed response and compaction paths register their original tuple before delegation',async()=>{
 for(const compaction of [false,true]){
  const home=mkdtempSync(join(tmpdir(),'clw-owner-path-')),epoch=randomUUID();let delegated=0;
  const parsed:any={modelId:'gpt-5.6-pro',context:{messages:[]},options:{reasoning:'max'},_compactionRequest:compaction,
   _rawBody:{model:'chatgpt-web/pro',client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:thread,turn_id:turn})},input:[{type:'message',role:'user',id:'message-1',content:'PRIVATE fixture',internal_chat_message_metadata_passthrough:{turn_id:turn}}]}};
  try{const factory:any=()=>({name:'isolated',async runTurn(){delegated++;const accepted=currentNativeOwnerAdmissions(home,epoch);expect(accepted).toHaveLength(1);expect(accepted[0].threadId).toBe(thread);const saved:any=JSON.parse(readFileSync(join(home,'turn-sources',accepted[0].traceId+'.json'),'utf8'));expect(saved.purpose).toBe(compaction?'compaction':'response');}});
   await observedAdapter({adapter:'chatgpt-web',baseUrl:'http://127.0.0.1:1'},home,factory,epoch).runTurn(parsed,{headers:new Headers()},()=>{});expect(delegated).toBe(1);
  }finally{rmSync(home,{recursive:true,force:true});}
 }
});
test('real controlled owner endpoints require original PID/epoch/key and preserve an existing drain',async()=>{const epoch=randomUUID();
 // The config's token is passed explicitly; no installed config/profile is read.
 const config={...defaultConfig('browser-only'),port:0,controlToken:randomUUID()};const s=startServer(config,{maintenanceAuthority:{ownerEpoch:epoch,read:empty}}),url=`http://127.0.0.1:${s.port}`,headers={Authorization:'Bearer '+config.controlToken,'Content-Type':'application/json'},key=randomUUID();
 try{expect((await fetch(url+'/admin/maintenance-state')).status).toBe(401);const snap:any=await (await fetch(url+'/admin/maintenance-state',{headers})).json();expect(snap.pid).toBe(process.pid);expect(snap.ownerEpoch).toBe(epoch);
 const action=async(action:string,operationId=key)=>fetch(url+'/admin/maintenance-fence',{method:'POST',headers,body:JSON.stringify({action,operationId,expectedPid:process.pid,expectedOwnerEpoch:epoch})});
 expect((await action('acquire')).status).toBe(200);expect((await fetch(url+'/admin/resume',{method:'POST',headers})).status).toBe(409);expect((await action('release',randomUUID())).status).toBe(409);expect((await action('release')).status).toBe(200);expect((await action('acquire')).status).toBe(409);
 }finally{s.stop(true);}});
test('shutdown settled callback waits for the actual worker close promise and marks rejection unclean',async()=>{
 for(const fail of [false,true]){
  const home=mkdtempSync(join(tmpdir(),'clw-worker-close-')),epoch=randomUUID(),key=randomUUID();let settle!:()=>void,notified:any=null;
  const config={...defaultConfig('browser-only'),port:0,controlToken:randomUUID(),storageStatePath:join(home,'never-opened.json')};
  const worker=ChatGptBrowserWorker.forProvider(providerConfig(config)),gate=new Promise<void>(r=>{settle=r;});worker.close=async()=>{await gate;if(fail)throw Error('isolated close rejection');};
  const previousCode=process.exitCode,s=startServer(config,{maintenanceAuthority:{ownerEpoch:epoch,read:empty},onShutdownSettled:value=>{notified=value;}}),url=`http://127.0.0.1:${s.port}`,headers={Authorization:'Bearer '+config.controlToken,'Content-Type':'application/json'},identity={operationId:key,expectedPid:process.pid,expectedOwnerEpoch:epoch};
  try{expect((await fetch(url+'/admin/maintenance-fence',{method:'POST',headers,body:JSON.stringify({...identity,action:'acquire'})})).status).toBe(200);
   const ack:any=await (await fetch(url+'/admin/shutdown',{method:'POST',headers,body:JSON.stringify({...identity,expectedNativeTurns:[]})})).json();expect(ack.shutdownDispatched).toBeTrue();await Bun.sleep(10);expect(notified).toBeNull();
   settle();for(let i=0;i<100&&!notified;i++)await Bun.sleep(2);expect(notified).toEqual({maintenance:true,clean:!fail});
  }finally{settle();await s.stop(true);process.exitCode=previousCode??0;rmSync(home,{recursive:true,force:true});}
 }
});
test('actual shutdown endpoint rejects changed first-fence bytes and a late Session proof before dispatch',async()=>{
 const epoch=randomUUID(),key=randomUUID();let current=empty(),sessionChanged=false,notified=false;
 const config={...defaultConfig('browser-only'),port:0,controlToken:randomUUID()},s=startServer(config,{maintenanceAuthority:{ownerEpoch:epoch,read:()=>current,verifySessions:()=>{if(sessionChanged)throw Error('native_maintenance_session_changed');}},onShutdownSettled:()=>{notified=true;}}),url=`http://127.0.0.1:${s.port}`,headers={Authorization:'Bearer '+config.controlToken,'Content-Type':'application/json'},identity={operationId:key,expectedPid:process.pid,expectedOwnerEpoch:epoch};
 try{
  expect((await fetch(url+'/admin/maintenance-fence',{method:'POST',headers,body:JSON.stringify({...identity,action:'acquire'})})).status).toBe(200);
  for(const variant of ['admission','session']){
   current={...empty(),admissionSha256:(variant==='admission'?'b':'a').repeat(64)};sessionChanged=variant==='session';
   const rejected=await fetch(url+'/admin/shutdown',{method:'POST',headers,body:JSON.stringify({...identity,expectedNativeTurns:[]})});expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({status:'refused',shutdownDispatched:false,operationId:key,pid:process.pid,ownerEpoch:epoch});
  }
  expect(notified).toBeFalse();expect((await fetch(url+'/healthz')).status).toBe(200);expect((await fetch(url+'/admin/maintenance-fence',{method:'POST',headers,body:JSON.stringify({...identity,action:'release'})})).status).toBe(200);
 }finally{await s.stop(true);}
});
