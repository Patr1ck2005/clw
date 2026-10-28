'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const zlib=require('node:zlib');
const {fork}=require('node:child_process');
const {once}=require('node:events');
const {openOperationStore,RECEIPT_CACHE_LIMIT}=require('../app-control-store.cjs');
const {startAppControl,controlError,executionReference,writePrivateAtomic,JOURNAL_VERSION,BODY_LIMIT,OPERATION_LIMIT}=require('../app-control.cjs');
const {captureShell}=require('../control-shell-capture.cjs');
const {createCaptureStore}=require('../control-captures.cjs');
const capturePNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg4RD4DwABTAEc6BPG4AAAAABJRU5ErkJggg==','base64');
function captureImage(changes={}){return {isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>capturePNG,...changes};}

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function storedJournal(f){
  const db=new DatabaseSync(path.join(f.profile,'control','app-control-operations.sqlite'),{readOnly:true});
  try{return {operations:db.prepare(`SELECT entry_json,codec,data FROM operations LEFT JOIN results
    ON results.sha256=operations.result_sha256 WHERE instance_id=? ORDER BY operation_id`).all(f.settings.instanceId).map(row=>{
    const entry=JSON.parse(row.entry_json);
    if(row.codec){const raw=row.codec==='deflate'?zlib.inflateRawSync(row.data):Buffer.from(row.data);entry.result=JSON.parse(raw.toString('utf8'));}
    return entry;
  })};}finally{db.close();}
}
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'clw-app-control-'));
  const profile=path.join(root,'profile'),calls=[];
  let generation=7;
  const settings={root,profile,instanceId:'fixture-instance-123',capabilities:['select','pause','reload-shell','inspect-ui','capture-shell'],
    snapshot:async()=>({runtime_generation:generation,selected:'task-original',tasks:[{id:'task-original',request_id:'request-original',account:'A',root}]}),
    dispatch:async(action,payload,identity,operation)=>{
      if(identity.runtime_generation!==generation)throw controlError('fixture_generation_changed',409,false);
      calls.push({action,payload,identity,operation});return {ok:true,action};
    },...options};
  const control=await startAppControl(settings);
  t.after(async()=>{await control.close();assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  return {root,profile,calls,control,settings,generation(value){generation=value;}};
}
function command(control,operation='operation-original-001',changes={}){
  return {operation_id:operation,action:'pause',payload:{id:'task-original'},
    expected_identity:{app_instance_id:control.descriptor.app_instance_id,runtime_generation:7,
      task_id:'task-original',thread_id:'thread-original',request_id:'request-original',account:'A'},...changes};
}
function request(control,route='/state',{method='GET',value,body,headers={},chunked=false}={}){
  const url=new URL(control.descriptor.url);
  const raw=body===undefined?(value===undefined?undefined:JSON.stringify(value)):body;
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:url.port,path:route,method,headers:{
      Authorization:'Bearer '+control.descriptor.token,...(raw===undefined?{}:{'Content-Type':'application/json'}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{
        try{resolve({status:res.statusCode,headers:res.headers,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}
      });
    });
    req.on('error',reject);
    if(chunked&&raw!==undefined){for(let at=0;at<raw.length;at+=8192)req.write(raw.slice(at,at+8192));req.end();}
    else req.end(raw);
  });
}
async function terminal(control,id='operation-original-001'){
  for(let attempt=0;attempt<200;attempt++){
    const result=await request(control,'/operations/'+id);
    if(result.status===200&&!['accepted','running'].includes(result.value.state))return result.value;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('fixture operation did not finish');
}
function ordinaryExitInitializer(source){
 const start=source.indexOf('const ordinaryExit=createOrdinaryExit('),end=source.indexOf('const loadedMainSha=',start);
 const pauseStart=source.indexOf('async function pauseOrdinaryQuitFuture('),pauseEnd=source.indexOf('async function readOrdinaryQuitActivity(',pauseStart);
 assert.ok(start>=0&&end>start&&pauseStart>=0&&pauseEnd>pauseStart);return source.slice(start,end)+source.slice(pauseStart,pauseEnd);
}
test('internal UI submission uses the same durable operation journal and never replays an unknown result',async t=>{
 let sends=0;const f=await fixture(t,{capabilities:['quit'],dispatch:async()=>{sends++;throw Error('owner_shutdown_unknown');}}),envelope=command(f.control,'ui-exit-original-001',{action:'quit',payload:{}});
 const accepted=await f.control.submit(envelope);assert.equal(accepted.state,'accepted');const saved=await terminal(f.control,envelope.operation_id);assert.equal(saved.state,'unknown');assert.equal(saved.operation_id,accepted.operation_id);
 const duplicate=await f.control.submit(envelope);assert.equal(duplicate.state,'unknown');assert.equal(sends,1);assert.equal(storedJournal(f).operations[0].state,'unknown');
});
test('actual main UI quit admission and duplicate click share one formal AppControl operation',async t=>{
 const source=await fs.readFile(path.join(__dirname,'../main.cjs'),'utf8'),start=source.indexOf('async function requestQuit('),end=source.indexOf('async function reconcileExit(',start),vm=require('node:vm'),{createExitLifecycle}=require('../exit-lifecycle.cjs');
 let context,prepares=0;const prepared=deferred(),f=await fixture(t,{capabilities:['quit'],dispatch:async(_action,payload,_identity,operation)=>context.requestQuit(payload,operation)});
 context={appControl:f.control,shellExitOperation:null,maintenanceClosingContext:null,coldQuitContext:null,focusInstanceId:f.control.descriptor.app_instance_id,ROOT:f.root,runtimeGeneration:7,randomUUID:require('node:crypto').randomUUID,exitLifecycle:createExitLifecycle(),createOrdinaryExit:require('../ordinary-exit.cjs').createOrdinaryExit,driver:null,runtime:null,readOrdinaryQuitActivity:async()=>({active:[],blocked:[]}),publish(){},prepareQuit:async payload=>{assert.equal(payload.future_paused,true);prepares++;await prepared.promise;context.exitLifecycle.update('closing-host');return {exiting:true,stage:'owner_shutdown_pending'};}};vm.runInNewContext(ordinaryExitInitializer(source)+source.slice(start,end),context);
 const first=await context.requestQuit({});assert.equal(first.operation.state,'accepted');assert.equal(first.operation.action,'quit');assert.equal(first.exit.operation_id,first.operation.operation_id);
 const repeated=await context.requestQuit({});assert.equal(repeated.operation.operation_id,first.operation.operation_id);prepared.resolve();const receipt=await terminal(f.control,first.operation.operation_id);
 assert.equal(receipt.state,'completed');assert.equal(receipt.result.exit.operation_id,receipt.operation_id);assert.equal(prepares,1);assert.equal(storedJournal(f).operations.length,1);assert.equal(storedJournal(f).operations[0].action,'quit');
});
test('formal blocked maintenance exit reconciliation uses the actual dispatcher, same context and no nested submit',async t=>{
 const source=await fs.readFile(path.join(__dirname,'../main.cjs'),'utf8'),start=source.indexOf('async function requestQuit('),end=source.indexOf('async function prepareQuit(',start),dispatchStart=source.indexOf('  const dispatchCommand='),dispatchEnd=source.indexOf("  ipcMain.handle('clw-command'",dispatchStart),vm=require('node:vm'),{createExitLifecycle}=require('../exit-lifecycle.cjs');
 let context,quiet=false,prepares=0;const f=await fixture(t,{capabilities:['quit','reconcile-exit'],dispatch:async(action,payload,_identity,operation)=>context.dispatchCommand(action,payload,operation)});
 context={appControl:f.control,shellExitOperation:null,maintenanceClosingContext:null,coldQuitContext:null,maintenanceChecking:false,isolatedCheck:false,driver:null,runtime:null,recordCommands:{actions:new Set()},focusInstanceId:f.control.descriptor.app_instance_id,ROOT:f.root,runtimeGeneration:7,randomUUID:require('node:crypto').randomUUID,exitLifecycle:createExitLifecycle(),createOrdinaryExit:require('../ordinary-exit.cjs').createOrdinaryExit,readOrdinaryQuitActivity:async()=>({active:[],blocked:[]}),publish(){},prepareQuit:async payload=>{assert.equal(payload.maintenance,true);prepares++;if(!quiet)throw Object.assign(Error('browser_generating'),{code:'browser_generating',accepted:false});context.exitLifecycle.update('closing-host');return {exiting:true};}};
 vm.runInNewContext(ordinaryExitInitializer(source)+source.slice(start,end)+source.slice(dispatchStart,dispatchEnd)+'\nthis.dispatchCommand=dispatchCommand;',context);
 const first=command(f.control,'api-quit-blocked-original',{action:'quit',payload:{maintenance:true}});await f.control.submit(first);const blocked=await terminal(f.control,first.operation_id);assert.equal(blocked.state,'rejected');const id=context.exitLifecycle.snapshot().exit_id;assert.equal(context.exitLifecycle.snapshot().operation_id,first.operation_id);assert.equal(context.exitLifecycle.snapshot().mode,'maintenance');
 quiet=true;const second=command(f.control,'api-reconcile-exit-original',{action:'reconcile-exit',payload:{exit_id:id}});await f.control.submit(second);const completed=await terminal(f.control,second.operation_id);assert.equal(completed.state,'completed');assert.equal(completed.result.exit.exit_id,id);assert.equal(completed.result.exit.operation_id,first.operation_id);assert.equal(prepares,2);assert.equal(storedJournal(f).operations.length,2);
});

test('formal ordinary exit retains the working turn and reconciles its original intent without a second pause',async t=>{
 const source=await fs.readFile(path.join(__dirname,'../main.cjs'),'utf8'),start=source.indexOf('async function requestQuit('),end=source.indexOf('async function prepareQuit(',start),dispatchStart=source.indexOf('  const dispatchCommand='),dispatchEnd=source.indexOf("  ipcMain.handle('clw-command'",dispatchStart),vm=require('node:vm');
 let context,quiet=false,pauses=0,prepares=0;const f=await fixture(t,{capabilities:['quit','reconcile-exit'],dispatch:async(action,payload,_identity,operation)=>context.dispatchCommand(action,payload,operation)});
 context={appControl:f.control,shellExitOperation:null,maintenanceClosingContext:null,coldQuitContext:null,maintenanceChecking:false,isolatedCheck:false,driver:{quiesceObservation:async()=>{},pauseAll:async()=>{pauses++;},readRecords:async()=>{},resumeObservation:()=>{},reconcileAll:async()=>{throw Error('quit must not schedule execution');}},runtime:{ready:true},recordCommands:{actions:new Set()},focusInstanceId:f.control.descriptor.app_instance_id,ROOT:f.root,runtimeGeneration:7,randomUUID:require('node:crypto').randomUUID,exitLifecycle:require('../exit-lifecycle.cjs').createExitLifecycle(),createOrdinaryExit:require('../ordinary-exit.cjs').createOrdinaryExit,readOrdinaryQuitActivity:async()=>({active:quiet?[]:[{page_id:'task-original',title:'Original turn',reason:'browser_generating'}],blocked:[]}),publish(){},prepareQuit:async payload=>{assert.equal(payload.future_paused,true);prepares++;context.exitLifecycle.update('completed');return {exiting:true};}};
 vm.runInNewContext(ordinaryExitInitializer(source)+source.slice(start,end)+source.slice(dispatchStart,dispatchEnd)+'\nthis.dispatchCommand=dispatchCommand;',context);
 const first=command(f.control,'api-quit-wait-original',{action:'quit',payload:{}});await f.control.submit(first);const waiting=await terminal(f.control,first.operation_id);
 assert.equal(waiting.state,'completed');assert.equal(waiting.result.waiting,true);assert.equal(waiting.result.exit.state,'waiting-current-turn');assert.equal(waiting.result.exit.mode,'ordinary');assert.equal(prepares,0);assert.equal(pauses,1);
 const id=waiting.result.exit.exit_id;quiet=true;const second=command(f.control,'api-reconcile-wait-original',{action:'reconcile-exit',payload:{exit_id:id}});await f.control.submit(second);const done=await terminal(f.control,second.operation_id);
 assert.equal(done.state,'completed');assert.equal(done.result.exit.state,'completed');assert.equal(done.result.exit.exit_id,id);assert.equal(done.result.exit.operation_id,first.operation_id);assert.equal(pauses,1);assert.equal(prepares,1);assert.equal(storedJournal(f).operations.length,2);
});

test('loopback descriptor is privately stored; state is fresh and capabilities are explicit',async t=>{
  const f=await fixture(t),descriptor=JSON.parse(await fs.readFile(path.join(f.profile,'control','app-control.json'),'utf8'));
  assert.match(descriptor.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(descriptor.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(descriptor.pid,process.pid);assert.equal(descriptor.root,f.root);assert.equal(descriptor.profile,f.profile);
  assert.equal(descriptor.control_directory,path.join(f.profile,'control'));assert.equal(descriptor.protection.verified,true);
  assert.equal(descriptor.protection.scheme,process.platform==='win32'?'windows-dacl':'posix-mode');
  assert.equal(descriptor.app_instance_id,'fixture-instance-123');assert.equal(descriptor.version,1);
  if(process.platform!=='win32')assert.equal((await fs.stat(path.join(f.profile,'control','app-control.json'))).mode&0o777,0o600);
  const first=await request(f.control);assert.equal(first.status,200);assert.equal(first.value.state.runtime_generation,7);
  f.generation(8);const second=await request(f.control);assert.equal(second.value.state.runtime_generation,8);
  assert.equal(second.value.app_instance_id,descriptor.app_instance_id);assert.equal(second.headers['cache-control'],'no-store');
  const capabilities=await request(f.control,'/capabilities');assert.deepEqual(capabilities.value.capabilities,f.settings.capabilities);
  assert.equal(capabilities.value.limits.body_bytes,BODY_LIMIT);assert.equal(f.calls.length,0);
});

test('token, Host and browser origin guards apply to reads and writes',async t=>{
  const f=await fixture(t);
  for(const route of ['/state','/commands']){
    const options=route==='/commands'?{method:'POST',value:command(f.control)}:{};
    for(const authorization of ['','Bearer wrong','Basic '+f.control.descriptor.token]){
      assert.equal((await request(f.control,route,{...options,headers:{Authorization:authorization}})).status,401);
    }
    assert.equal((await request(f.control,route,{...options,headers:{Host:'localhost:'+new URL(f.control.descriptor.url).port}})).status,403);
    assert.equal((await request(f.control,route,{...options,headers:{Origin:'null'}})).value.error.code,'app_control_browser_forbidden');
    assert.equal((await request(f.control,route,{...options,headers:{'Sec-Fetch-Site':'same-origin'}})).status,403);
  }
  assert.equal(f.calls.length,0);
});

test('exact paths, methods, JSON type, size, depth and prototype keys are bounded',async t=>{
  const f=await fixture(t);
  assert.equal((await request(f.control,'/state?token=x')).status,404);
  assert.equal((await request(f.control,'/state',{method:'POST',value:{}})).status,405);
  assert.equal((await request(f.control,'/commands',{method:'OPTIONS'})).status,405);
  assert.equal((await request(f.control,'/commands',{method:'POST',value:{},headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await request(f.control,'/commands',{method:'POST',value:{},headers:{'Content-Encoding':'gzip'}})).status,415);
  assert.equal((await request(f.control,'/commands',{method:'POST',body:'{'})).status,400);
  assert.equal((await request(f.control,'/commands',{method:'POST',body:'x'.repeat(BODY_LIMIT+1),headers:{'Content-Length':String(BODY_LIMIT+1)}})).status,413);
  assert.equal((await request(f.control,'/commands',{method:'POST',body:'x'.repeat(BODY_LIMIT+1),chunked:true})).status,413);
  assert.equal((await request(f.control,'/commands',{method:'POST',body:'{"__proto__":{}}'})).value.error.code,'app_control_json_key');
  let nested={};for(let n=0;n<34;n++)nested={item:nested};
  assert.equal((await request(f.control,'/commands',{method:'POST',value:nested})).value.error.code,'app_control_json_depth');
  assert.equal(f.calls.length,0);
});

test('app identity, runtime generation and allowlisted command envelopes are mandatory',async t=>{
  const f=await fixture(t),original=command(f.control);
  const foreign=await request(f.control,'/commands',{method:'POST',value:{...original,expected_identity:{...original.expected_identity,app_instance_id:'foreign-instance'}}});
  assert.equal(foreign.status,409);assert.equal(foreign.value.error.code,'app_control_instance_mismatch');
  for(const generation of [undefined,-1,1.5,'7']){
    const identity={...original.expected_identity,runtime_generation:generation};
    assert.equal((await request(f.control,'/commands',{method:'POST',value:{...original,expected_identity:identity}})).status,400);
  }
  for(const action of ['evaluate','exec-command','arbitrary-file'])assert.equal((await request(f.control,'/commands',{method:'POST',value:{...original,action}})).status,403);
  assert.equal((await request(f.control,'/commands',{method:'POST',value:{...original,extra:true}})).status,400);
  assert.equal((await request(f.control,'/commands',{method:'POST',value:{...original,operation_id:'../escape'}})).status,400);
  assert.equal(f.calls.length,0);
});

test('one original operation persists accepted and running before dispatch, and duplicates do not replay',async t=>{
  const gate=deferred();let f;
  f=await fixture(t,{dispatch:async(action,payload,identity,operation)=>{
    const journal=storedJournal(f);
    assert.equal(journal.operations[0].state,'running');
    f.calls.push({action,payload,identity,operation});await gate.promise;return {ok:true,request_id:'request-original'};
  }});
  const envelope=command(f.control),accepted=await request(f.control,'/commands',{method:'POST',value:envelope});
  assert.equal(accepted.status,202);assert.equal(accepted.value.state,'accepted');
  while(!f.calls.length)await new Promise(resolve=>setTimeout(resolve,5));
  const duplicate=await request(f.control,'/commands',{method:'POST',value:envelope});assert.equal(duplicate.status,202);
  assert.equal(duplicate.value.state,'running');assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].operation,{operation_id:envelope.operation_id,app_instance_id:f.control.descriptor.app_instance_id,
    execution_reference:executionReference(f.control.descriptor.app_instance_id,envelope.operation_id)});
  const changed=await request(f.control,'/commands',{method:'POST',value:{...envelope,payload:{id:'another-task'}}});
  assert.equal(changed.status,409);assert.equal(changed.value.error.code,'app_control_operation_conflict');
  const other=await request(f.control,'/commands',{method:'POST',value:command(f.control,'operation-other-002')});
  assert.equal(other.value.error.code,'app_control_operation_in_flight');
  gate.resolve();const done=await terminal(f.control);assert.equal(done.state,'completed');assert.deepEqual(done.result,{ok:true,request_id:'request-original'});
  const repeat=await request(f.control,'/commands',{method:'POST',value:envelope});assert.equal(repeat.status,200);assert.deepEqual(repeat.value,done);assert.equal(f.calls.length,1);
  const journal=storedJournal(f);
  assert.equal(journal.operations[0].state,'completed');assert.equal(journal.operations[0].operation_id,envelope.operation_id);
});

test('canonical input ordering identifies the same operation without retaining prompt bodies',async t=>{
  const f=await fixture(t,{dispatch:async()=>({ok:true,prompt:'private reply',nested:{token:'secret reply',request_id:'safe'}})});
  const envelope=command(f.control,'operation-private-001',{payload:{id:'task-original',objective:'PRIVATE ORIGINAL PROMPT',settings:{a:1,b:2}}});
  await request(f.control,'/commands',{method:'POST',value:envelope});await terminal(f.control,envelope.operation_id);
  const reordered={payload:{settings:{b:2,a:1},objective:'PRIVATE ORIGINAL PROMPT',id:'task-original'},expected_identity:envelope.expected_identity,action:'pause',operation_id:envelope.operation_id};
  const result=await request(f.control,'/commands',{method:'POST',value:reordered});assert.equal(result.status,200);assert.equal(result.value.state,'completed');
  const journal=JSON.stringify(storedJournal(f));
  assert.ok(!journal.includes('PRIVATE ORIGINAL PROMPT'));assert.ok(!journal.includes('private reply'));assert.ok(!journal.includes('secret reply'));
  assert.ok(!journal.includes(f.control.descriptor.token));assert.ok(journal.includes('request_id'));assert.ok(journal.includes('request_hash'));
});

test('pre-dispatch validation is rejected; uncertain dispatch errors retain unknown original receipt',async t=>{
  const f=await fixture(t,{dispatch:async(action,payload)=>{
    if(payload.rejected)throw controlError('fixture_identity_rejected',409,false);
    f.calls.push(payload);throw Object.assign(new Error('private error text'),{code:'fixture_callback_failed'});
  }});
  const rejected=command(f.control,'operation-rejected-001',{payload:{rejected:true}});
  await request(f.control,'/commands',{method:'POST',value:rejected});
  const no=await terminal(f.control,rejected.operation_id);assert.equal(no.state,'rejected');assert.equal(no.error.accepted,false);assert.equal(f.calls.length,0);
  const uncertain=command(f.control,'operation-unknown-002');
  await request(f.control,'/commands',{method:'POST',value:uncertain});
  const unknown=await terminal(f.control,uncertain.operation_id);assert.equal(unknown.state,'unknown');assert.equal(unknown.error.accepted,true);
  assert.equal(unknown.error.code,'fixture_callback_failed');assert.ok(!JSON.stringify(unknown).includes('private error text'));
  for(let n=0;n<3;n++)assert.equal((await request(f.control,'/commands',{method:'POST',value:uncertain})).value.state,'unknown');
  assert.equal(f.calls.length,1);
});

for(const [stage,expectedCode]of [['inspect','capture_shell_inspect_failed'],['native','capture_shell_native_failed'],['image','capture_shell_image_invalid'],['png','capture_shell_png_failed']])
test('capture-shell '+stage+' failure is durably rejected before storage and duplicate commands never recapture',async t=>{
  const counts={dispatch:0,inspect:0,native:0,png:0,save:0};
  const privateError=Object.assign(Error('UnknownVizError PRIVATE_CAPTURE_DETAIL C:/private-user/capture'),{code:'PRIVATE_CAPTURE_CODE'});
  const image=captureImage({isEmpty:()=>stage==='image',toPNG:()=>{counts.png++;return stage==='png'?Buffer.alloc(0):capturePNG;}});
  const f=await fixture(t,{dispatch:async action=>{
    counts.dispatch++;assert.equal(action,'capture-shell');
    return captureShell({inspect:async()=>{counts.inspect++;if(stage==='inspect')throw privateError;return {selected:'task-original'};},
      capture:async()=>{counts.native++;if(stage==='native')throw privateError;return image;},
      save:async()=>{counts.save++;throw Error('storage must not be reached');},assertOwner:()=>{}});
  }});
  const envelope=command(f.control,'capture-'+stage+'-rejected-001',{action:'capture-shell',payload:{}});
  assert.equal((await request(f.control,'/commands',{method:'POST',value:envelope})).status,202);
  const receipt=await terminal(f.control,envelope.operation_id);
  assert.equal(receipt.state,'rejected');assert.deepEqual(receipt.error,{code:expectedCode,accepted:false});
  assert.equal(receipt.operation_id,envelope.operation_id);assert.equal(receipt.result,undefined);
  const before={...counts};assert.equal(before.dispatch,1);assert.equal(before.inspect,1);assert.equal(before.native,stage==='inspect'?0:1);
  assert.equal(before.png,stage==='png'?1:0);assert.equal(before.save,0);
  for(let duplicate=0;duplicate<3;duplicate++){
    const again=await request(f.control,'/commands',{method:'POST',value:envelope});assert.equal(again.status,200);assert.deepEqual(again.value,receipt);
  }
  assert.deepEqual(counts,before);const journal=storedJournal(f);assert.equal(journal.operations.length,1);
  assert.equal(journal.operations[0].state,'rejected');assert.deepEqual(journal.operations[0].error,receipt.error);
  assert.doesNotMatch(JSON.stringify({receipt,journal}),/UnknownVizError|PRIVATE_CAPTURE|private-user/);
  assert.equal((await fs.readdir(path.join(f.profile,'control'))).some(name=>name.endsWith('.png')),false);
});

test('capture-shell storage failure after writing retains unknown and the same operation cannot write another artifact',async t=>{
  const counts={dispatch:0,native:0,save:0};let f;
  f=await fixture(t,{dispatch:async action=>{
    counts.dispatch++;assert.equal(action,'capture-shell');
    return captureShell({inspect:async()=>({selected:'task-original'}),capture:async()=>{counts.native++;return captureImage();},assertOwner:()=>{},
      save:async bytes=>{counts.save++;await fs.writeFile(path.join(f.profile,'control','partial-capture-fixture.png'),bytes,{flag:'wx'});
        throw Object.assign(Error('PRIVATE_WRITE_FAILURE C:/private-user/artifact'),{code:'EACCES',accepted:false});}});
  }});
  const envelope=command(f.control,'capture-storage-unknown-001',{action:'capture-shell',payload:{}});
  await request(f.control,'/commands',{method:'POST',value:envelope});const receipt=await terminal(f.control,envelope.operation_id);
  assert.equal(receipt.state,'unknown');assert.deepEqual(receipt.error,{code:'capture_shell_storage_failed',accepted:true});assert.equal(receipt.result,undefined);
  assert.deepEqual(await fs.readFile(path.join(f.profile,'control','partial-capture-fixture.png')),capturePNG);
  for(let duplicate=0;duplicate<3;duplicate++)assert.deepEqual((await request(f.control,'/commands',{method:'POST',value:envelope})).value,receipt);
  assert.deepEqual(counts,{dispatch:1,native:1,save:1});const journal=storedJournal(f);assert.equal(journal.operations.length,1);
  assert.equal(journal.operations[0].state,'unknown');assert.deepEqual(journal.operations[0].error,receipt.error);
  assert.doesNotMatch(JSON.stringify({receipt,journal}),/PRIVATE_WRITE_FAILURE|private-user|EACCES/);
});

test('capture-shell completed receipt preserves exact PNG metadata and the bounded original artifact without duplicate writes',async t=>{
  const counts={dispatch:0,native:0,save:0};let f;
  f=await fixture(t,{dispatch:async action=>{
    counts.dispatch++;assert.equal(action,'capture-shell');
    return captureShell({inspect:async()=>({selected:'task-original'}),capture:async()=>{counts.native++;return captureImage();},assertOwner:()=>{},
      save:bytes=>{counts.save++;return createCaptureStore(path.join(f.profile,'control')).capture(bytes);}});
  }});
  const envelope=command(f.control,'capture-completed-001',{action:'capture-shell',payload:{}});
  await request(f.control,'/commands',{method:'POST',value:envelope});const receipt=await terminal(f.control,envelope.operation_id);
  assert.equal(receipt.state,'completed');assert.equal(receipt.error,undefined);
  assert.deepEqual(receipt.result.png,{bytes:70,sha256:'748764ddad7e60fbb1d1dc7916bd9f25f37dc35fddd34390c68265084f24b007',width:1,height:1});
  assert.equal(receipt.result.capture_retention,32);assert.equal(receipt.result.cleanup_pending,false);assert.equal(receipt.result.model_sends,0);
  assert.deepEqual(receipt.result.inspection,{selected:'task-original'});assert.deepEqual(await fs.readFile(receipt.result.path),capturePNG);
  for(let duplicate=0;duplicate<3;duplicate++)assert.deepEqual((await request(f.control,'/commands',{method:'POST',value:envelope})).value,receipt);
  assert.deepEqual(counts,{dispatch:1,native:1,save:1});
  assert.equal((await fs.readdir(path.join(f.profile,'control'))).filter(name=>name.endsWith('.png')).length,1);
  assert.deepEqual(storedJournal(f).operations[0].result,receipt.result);
});

for(const failingCheck of [2,3])test('capture-shell owner refusal '+failingCheck+' retains original identity code and artifact acceptance in the durable receipt',async t=>{
  let f,assertions=0,saves=0,native=0;
  f=await fixture(t,{dispatch:async()=>captureShell({inspect:async()=>({selected:'task-original'}),capture:async()=>{native++;return captureImage();},
    save:bytes=>{saves++;return createCaptureStore(path.join(f.profile,'control')).capture(bytes);},assertOwner:response=>{
      if(++assertions===failingCheck)throw controlError('app_control_selection_changed',409,response===true);
    }})});
  const envelope=command(f.control,'capture-owner-'+failingCheck+'-001',{action:'capture-shell',payload:{}});
  await request(f.control,'/commands',{method:'POST',value:envelope});const receipt=await terminal(f.control,envelope.operation_id);
  assert.equal(receipt.state,failingCheck===3?'unknown':'rejected');
  assert.deepEqual(receipt.error,{code:'app_control_selection_changed',accepted:failingCheck===3});
  assert.equal(native,1);assert.equal(saves,failingCheck===3?1:0);assert.equal(assertions,failingCheck);
  assert.deepEqual((await request(f.control,'/commands',{method:'POST',value:envelope})).value,receipt);
  assert.equal(native,1);assert.equal(saves,failingCheck===3?1:0);assert.equal(assertions,failingCheck);
  assert.equal((await fs.readdir(path.join(f.profile,'control'))).filter(name=>name.endsWith('.png')).length,failingCheck===3?1:0);
  assert.deepEqual(storedJournal(f).operations[0].error,receipt.error);
});

test('lost HTTP response does not replay the already accepted original operation',async t=>{
  const gate=deferred(),f=await fixture(t,{dispatch:async()=>{f.calls.push({effect:true});await gate.promise;return {ok:true};}});
  const envelope=command(f.control),url=new URL(f.control.descriptor.url);
  const received=deferred();
  const req=http.request({hostname:'127.0.0.1',port:url.port,path:'/commands',method:'POST',headers:{Authorization:'Bearer '+f.control.descriptor.token,'Content-Type':'application/json'}},res=>{
    res.destroy();req.destroy();received.resolve();
  });req.on('error',()=>{});req.end(JSON.stringify(envelope));await received.promise;
  while(!f.calls.length)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await request(f.control,'/commands',{method:'POST',value:envelope})).value.state,'running');
  gate.resolve();assert.equal((await terminal(f.control)).state,'completed');assert.equal(f.calls.length,1);
});

test('stale runtime snapshot rejects at dispatch and cannot create a side effect',async t=>{
  const f=await fixture(t);f.generation(8);
  await request(f.control,'/commands',{method:'POST',value:command(f.control)});
  const result=await terminal(f.control);assert.equal(result.state,'rejected');assert.equal(result.error.code,'fixture_generation_changed');assert.equal(f.calls.length,0);
});

test('pending journal recovery is unknown, never dispatched, and a different live owner is retained',async t=>{
  const f=await fixture(t);await f.control.close();
  await fs.unlink(path.join(f.profile,'control','app-control-operations.sqlite'));
  const envelope=command(f.control),crypto=require('node:crypto');
  function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
  await fs.writeFile(path.join(f.profile,'control','app-control-operations-fixture-instance-123.json'),JSON.stringify({version:JOURNAL_VERSION,app_instance_id:'fixture-instance-123',root:f.root,profile:f.profile,operations:[{
    operation_id:envelope.operation_id,app_instance_id:'fixture-instance-123',action:'pause',execution_reference:executionReference('fixture-instance-123',envelope.operation_id),
    request_hash:crypto.createHash('sha256').update(stable(envelope)).digest('hex'),state:'running',accepted_at:'2026-10-06T00:00:00.000Z',updated_at:'2026-10-06T00:00:00.000Z'}]}));
  const recovered=await startAppControl(f.settings);t.after(()=>recovered.close());
  const original=await request(recovered,'/operations/'+envelope.operation_id);assert.equal(original.value.state,'unknown');assert.equal(original.value.error.code,'app_control_process_restarted');
  assert.equal((await request(recovered,'/commands',{method:'POST',value:envelope})).value.state,'unknown');assert.equal(f.calls.length,0);
  await assert.rejects(startAppControl({...f.settings,instanceId:'another-live-instance'}),{code:'app_control_owner_active'});
  const descriptor=JSON.parse(await fs.readFile(path.join(f.profile,'control','app-control.json'),'utf8'));assert.equal(descriptor.app_instance_id,'fixture-instance-123');
  await recovered.close();
});

test('close cleans only its own descriptor, keeps journal, and never closes a newer owner',async t=>{
  const f=await fixture(t),envelope=command(f.control);
  await request(f.control,'/commands',{method:'POST',value:envelope});await terminal(f.control);
  await f.control.close();await assert.rejects(fs.stat(path.join(f.profile,'control','app-control.json')),{code:'ENOENT'});
  assert.ok((await fs.stat(path.join(f.profile,'control','app-control-operations.sqlite'))).isFile());
  const next=await startAppControl({...f.settings,instanceId:'next-instance-456'});t.after(()=>next.close());
  await fs.writeFile(path.join(f.profile,'control','app-control.json'),JSON.stringify({...next.descriptor,app_instance_id:'newer-owner-789',token:'newer-owner-token',url:'http://127.0.0.1:12345'}));
  await next.close();const retained=JSON.parse(await fs.readFile(path.join(f.profile,'control','app-control.json'),'utf8'));
  assert.equal(retained.app_instance_id,'newer-owner-789');assert.equal(retained.token,'newer-owner-token');
});

test('unreadable and oversized output fail closed and never expose a completed false receipt',async t=>{
  const f=await fixture(t,{snapshot:async()=>({text:'x'.repeat(1024*1024)}),dispatch:async()=>({text:'x'.repeat(129*1024)})});
  assert.equal((await request(f.control)).status,503);
  await request(f.control,'/commands',{method:'POST',value:command(f.control)});
  const result=await terminal(f.control);assert.equal(result.state,'unknown');assert.equal(result.error.code,'app_control_result_too_large');
  await f.control.close();
  await fs.writeFile(path.join(f.profile,'control','app-control-operations.sqlite'),'{');
  await assert.rejects(startAppControl(f.settings),{code:'app_control_journal_unreadable'});
});

test('thousands of HTTP operations exceed both old journal limits with bounded memory and old-key deduplication after restart',async t=>{
  const total=2300,large='a'.repeat(8*1024);
  const f=await fixture(t,{dispatch:async(action,payload,identity,operation)=>{
    f.calls.push(operation.operation_id);return {ok:true,request_id:operation.execution_reference,data:large};
  }}),original=command(f.control);
  await request(f.control,'/commands',{method:'POST',value:original});const first=await terminal(f.control);
  for(let n=1;n<total;n++){
    const id='operation-long-'+String(n).padStart(6,'0');
    assert.equal((await request(f.control,'/commands',{method:'POST',value:command(f.control,id)})).status,202);
    const result=await terminal(f.control,id);assert.equal(result.state,'completed');assert.equal(result.result.data,large);
  }
  assert.ok(total>OPERATION_LIMIT);assert.ok(total*large.length>8*1024*1024);
  const stats=await f.control.storageStats();assert.equal(stats.operations,total);assert.ok(stats.memory_receipts<=RECEIPT_CACHE_LIMIT);
  assert.equal(stats.pending_results,0);assert.equal(f.calls.length,total);
  const capabilities=await request(f.control,'/capabilities');assert.equal(capabilities.value.limits.operations,null);
  const old=await request(f.control,'/commands',{method:'POST',value:original});assert.equal(old.status,200);assert.deepEqual(old.value,first);
  assert.equal(f.calls.length,total);await f.control.close();
  const reopened=await startAppControl(f.settings);t.after(()=>reopened.close());
  const after=await request(reopened,'/commands',{method:'POST',value:original});assert.deepEqual(after.value,first);
  assert.equal(f.calls.length,total);assert.equal((await reopened.storageStats()).operations,total);
  const next=command(reopened,'operation-after-restart-001');await request(reopened,'/commands',{method:'POST',value:next});
  assert.equal((await terminal(reopened,next.operation_id)).state,'completed');assert.equal(f.calls.length,total+1);
  await reopened.close();
});

test('terminal flush failure preserves observed Host result and durable deterministic execution reference',async t=>{
  for(const failure of ['terminal-only','terminal-and-fallback']){
    let f,observed=false;const snapshots=[];
    f=await fixture(t,{createStore:async options=>{
      const store=await openOperationStore(options);return {...store,put:async entry=>{
        snapshots.push({operations:[JSON.parse(JSON.stringify(entry))]});
        if(entry?.state==='completed'||failure==='terminal-and-fallback'&&observed)
          throw Object.assign(Error('fixture terminal flush denied'),{code:'EACCES'});
        return store.put(entry);
      }};
    },dispatch:async(action,payload,identity,operation)=>{
      const journal=storedJournal(f);
      assert.equal(journal.operations[0].state,'running');assert.equal(journal.operations[0].execution_reference,operation.execution_reference);
      f.calls.push(operation);observed=true;
      return {state:'queued',operation_id:operation.execution_reference,request_id:operation.execution_reference,objective:'PRIVATE HOST PROMPT'};
    }});
    const envelope=command(f.control),expected=executionReference(f.control.descriptor.app_instance_id,envelope.operation_id);
    const accepted=await request(f.control,'/commands',{method:'POST',value:envelope});
    assert.equal(accepted.value.execution_reference,expected);assert.match(expected,/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const result=await terminal(f.control);assert.equal(result.state,'unknown');assert.equal(result.result_observed,true);
    assert.equal(result.execution_reference,expected);assert.equal(result.result.operation_id,expected);assert.equal(result.result.request_id,expected);
    assert.equal(result.error.accepted,true);
    for(let n=0;n<3;n++){
      const repeated=await request(f.control,'/commands',{method:'POST',value:envelope});
      assert.equal(repeated.value.state,'unknown');assert.equal(repeated.value.result.request_id,expected);
    }
    assert.equal(f.calls.length,1);assert.equal(snapshots[0].operations[0].state,'accepted');
    assert.equal(snapshots[0].operations[0].execution_reference,expected);
    const persisted=storedJournal(f);
    if(failure==='terminal-only'){
      assert.equal(persisted.operations[0].state,'unknown');assert.equal(persisted.operations[0].result_observed,true);
      assert.equal(persisted.operations[0].result.request_id,expected);assert.equal(persisted.operations[0].result.objective,'[private]');
    }else{
      assert.equal(persisted.operations[0].state,'running');assert.equal(persisted.operations[0].execution_reference,expected);
    }
    await f.control.close();
  }
});

test('an observed result stays readable until the original receipt is repaired, then survives cache eviction and restart',async t=>{
  let broken=true,f;
  f=await fixture(t,{createStore:async options=>{
    const store=await openOperationStore(options);return {...store,put:async entry=>{
      if(broken&&entry.result_observed)throw Object.assign(Error('temporary disk failure'),{code:'EIO'});
      return store.put(entry);
    }};
  },dispatch:async(action,payload,identity,operation)=>{f.calls.push(operation.operation_id);return {request_id:operation.execution_reference};}});
  const original=command(f.control);await request(f.control,'/commands',{method:'POST',value:original});
  const observed=await terminal(f.control);assert.equal(observed.state,'unknown');assert.equal(observed.result_observed,true);
  assert.equal((await f.control.storageStats()).pending_results,1);
  const refused=await request(f.control,'/commands',{method:'POST',value:command(f.control,'operation-during-disk-failure')});
  assert.equal(refused.status,503);assert.equal(f.calls.length,1);
  assert.equal((await request(f.control,'/operations/'+original.operation_id)).value.result.request_id,observed.execution_reference);
  broken=false;
  for(let n=0;n<RECEIPT_CACHE_LIMIT+3;n++){
    const id='operation-after-storage-'+String(n).padStart(4,'0');
    assert.equal((await request(f.control,'/commands',{method:'POST',value:command(f.control,id)})).status,202);
    await terminal(f.control,id);
  }
  assert.equal((await f.control.storageStats()).pending_results,0);
  const repaired=await request(f.control,'/operations/'+original.operation_id);
  assert.equal(repaired.value.state,'unknown');assert.equal(repaired.value.result_observed,true);
  assert.equal(repaired.value.result.request_id,observed.execution_reference);
  const count=f.calls.length;await f.control.close();
  const reopened=await startAppControl(f.settings);t.after(()=>reopened.close());
  const old=await request(reopened,'/commands',{method:'POST',value:original});
  assert.equal(old.value.state,'unknown');assert.equal(old.value.result.request_id,observed.execution_reference);assert.equal(f.calls.length,count);
  await reopened.close();
});

test('a new installed code root uses the same physical data and reads original-instance receipts without accepting old commands',async t=>{
  const f=await fixture(t),original=command(f.control);
  await request(f.control,'/commands',{method:'POST',value:original});const receipt=await terminal(f.control);await f.control.close();
  const nextRoot=path.join(f.root,'next-version');await fs.mkdir(nextRoot);
  const nextProfile=path.join(nextRoot,'profile');await fs.symlink(f.profile,nextProfile,'junction');
  const next=await startAppControl({...f.settings,root:nextRoot,profile:nextProfile,instanceId:'next-version-instance-001'});t.after(()=>next.close());
  const historical=await request(next,'/operations/'+original.operation_id+'?original_instance_id=fixture-instance-123');
  assert.equal(historical.status,200);assert.equal(historical.value.app_instance_id,'next-version-instance-001');
  assert.equal(historical.value.original_identity.root,f.root);assert.equal(historical.value.original_identity.profile,f.profile);
  assert.deepEqual(historical.value.operation,receipt);
  assert.equal((await request(next,'/commands',{method:'POST',value:original})).value.error.code,'app_control_instance_mismatch');
  assert.equal(f.calls.length,1);assert.equal((await request(next,'/operations/'+original.operation_id)).status,404);
  assert.equal((await request(next,'/operations/'+original.operation_id+'?original_instance_id=missing-instance-001')).status,404);
  for(const query of ['original_instance_id=fixture-instance-123&extra=1','original_instance_id=..','original_instance_id=fixture-instance-123&original_instance_id=next-version-instance-001'])
    assert.equal((await request(next,'/operations/'+original.operation_id+'?'+query)).status,404);
  assert.equal((await request(next,'/operations/'+original.operation_id+'?original_instance_id=fixture-instance-123',{method:'POST',value:{}})).status,405);
  await next.close();
});

test('an upgrade imports previous-instance JSON observed unknown receipts once and preserves the original file and operation',async t=>{
  const f=await fixture(t);await f.control.close();
  const oldInstance='previous-json-instance-001',id='previous-observed-operation-001',reference=executionReference(oldInstance,id);
  const original={operation_id:id,app_instance_id:oldInstance,action:'pause',execution_reference:reference,
    request_hash:'a'.repeat(64),state:'unknown',accepted_at:'2026-10-06T00:00:00.000Z',updated_at:'2026-10-06T00:00:01.000Z',
    result_observed:true,result:{request_id:reference,operation_id:reference},error:{code:'app_control_journal_unavailable',accepted:true}};
  const file=path.join(f.profile,'control','app-control-operations-'+oldInstance+'.json');
  const bytes=JSON.stringify({version:JOURNAL_VERSION,app_instance_id:oldInstance,root:f.root,profile:f.profile,operations:[original]})+'\n';
  await fs.writeFile(file,bytes);
  async function verify(instanceId){
    const next=await startAppControl({...f.settings,instanceId});
    try{
      const history=await request(next,'/operations/'+id+'?original_instance_id='+oldInstance);
      const {request_hash,...expected}=original;
      assert.equal(history.status,200);assert.equal(history.value.app_instance_id,instanceId);assert.deepEqual(history.value.operation,expected);
      assert.equal(history.value.original_identity.app_instance_id,oldInstance);
      assert.equal(await fs.readFile(file,'utf8'),bytes);assert.equal(f.calls.length,0);
      const old=command(next,id,{expected_identity:{...command(next).expected_identity,app_instance_id:oldInstance}});
      assert.equal((await request(next,'/commands',{method:'POST',value:old})).value.error.code,'app_control_instance_mismatch');
      assert.equal((await next.storageStats()).results,1);
    }finally{await next.close();}
  }
  await verify('upgrade-import-instance-001');await verify('upgrade-import-instance-002');
});

test('a real process interruption preserves committed running identity and a new-instance restart only reads its original operation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'clw-control-process-restart-')),profile=path.join(root,'profile'),script=path.join(root,'actor.cjs');
  const actors=[];
  t.after(async()=>{
    for(const actor of actors)if(actor.exitCode===null&&actor.signalCode===null){const exited=once(actor,'exit');actor.kill();await exited;}
    assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});
  });
  await fs.writeFile(script,`const fs=require('node:fs'),path=require('node:path');
const {startAppControl}=require(${JSON.stringify(path.resolve(__dirname,'../app-control.cjs'))});
const root=${JSON.stringify(root)},profile=${JSON.stringify(profile)},phase=process.argv[2],instanceId=phase==='hang'?'process-original-instance':'process-restarted-instance';
let control;startAppControl({root,profile,instanceId,capabilities:['pause'],snapshot:async()=>({runtime_generation:7}),dispatch:async(action,payload,identity,operation)=>{
 fs.appendFileSync(path.join(root,'effects.log'),operation.execution_reference+'\\n');process.send({entered:true,execution_reference:operation.execution_reference});
 if(phase==='hang')await new Promise(()=>{});return {request_id:operation.execution_reference};
}}).then(value=>{control=value;process.send({ready:true});}).catch(error=>{process.send({error:error.code||error.message});process.exit(1);});
process.on('message',async message=>{if(message==='close'){await control.close();process.exit(0);}});`);
  async function launch(phase){
    const actor=fork(script,[phase],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[],windowsHide:true});actors.push(actor);
    let stderr='';actor.stderr.on('data',data=>{stderr=(stderr+data).slice(-8192);});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('fixture actor startup timeout: '+stderr)),15000);
      actor.on('message',function ready(message){if(message.ready){clearTimeout(timer);actor.off('message',ready);resolve();}else if(message.error){clearTimeout(timer);reject(Error(message.error));}});
      actor.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('fixture actor exited '+code+': '+stderr));});
    });
    const descriptor=JSON.parse(await fs.readFile(path.join(profile,'control','app-control.json'),'utf8'));return {actor,descriptor};
  }
  const first=await launch('hang'),envelope=command(first),entered=new Promise(resolve=>first.actor.once('message',resolve));
  assert.equal((await request(first,'/commands',{method:'POST',value:envelope})).status,202);
  const begun=await entered;assert.equal(begun.entered,true);
  const running=await request(first,'/operations/'+envelope.operation_id);assert.equal(running.value.state,'running');
  const killed=once(first.actor,'exit');first.actor.kill();await killed;
  const next=await launch('restart');
  const history=await request(next,'/operations/'+envelope.operation_id+'?original_instance_id=process-original-instance');
  assert.equal(history.status,200);assert.equal(history.value.app_instance_id,'process-restarted-instance');
  assert.equal(history.value.operation.state,'unknown');assert.equal(history.value.operation.execution_reference,begun.execution_reference);
  assert.equal(history.value.operation.error.code,'app_control_process_restarted');
  for(let n=0;n<3;n++){
    assert.equal((await request(next,'/commands',{method:'POST',value:envelope})).value.error.code,'app_control_instance_mismatch');
    assert.equal((await request(next,'/operations/'+envelope.operation_id+'?original_instance_id=process-original-instance')).value.operation.state,'unknown');
  }
  assert.deepEqual((await fs.readFile(path.join(root,'effects.log'),'utf8')).trim().split('\n'),[begun.execution_reference]);
  const fresh=command(next,'operation-after-process-restart');await request(next,'/commands',{method:'POST',value:fresh});
  assert.equal((await terminal(next,fresh.operation_id)).state,'completed');
  assert.equal((await fs.readFile(path.join(root,'effects.log'),'utf8')).trim().split('\n').length,2);
  const exited=once(next.actor,'exit');next.actor.send('close');await exited;assert.equal(next.actor.exitCode,0);
});

test('a living reused PID with a proven different creation identity permits only the stale private descriptor replacement',async t=>{
  const f=await fixture(t),previous={...f.control.descriptor,process_identity:{...f.control.descriptor.process_identity}};
  await f.control.close();
  if(previous.process_identity.kind==='windows-filetime')previous.process_identity.creation_filetime=(BigInt(previous.process_identity.creation_filetime)-1n).toString();
  else if(previous.process_identity.kind==='linux-proc')previous.process_identity.start_ticks=(BigInt(previous.process_identity.start_ticks)+1n).toString();
  else previous.process_identity.lifetime_token=require('node:crypto').randomUUID();
  const descriptorPath=path.join(f.profile,'control','app-control.json');await fs.writeFile(descriptorPath,JSON.stringify(previous));
  assert.doesNotThrow(()=>process.kill(previous.pid,0));
  const replacement=await startAppControl({...f.settings,instanceId:'replacement-instance-789'});t.after(()=>replacement.close());
  const actual=JSON.parse(await fs.readFile(descriptorPath,'utf8'));
  assert.equal(actual.app_instance_id,'replacement-instance-789');assert.deepEqual(actual.process_identity,f.control.descriptor.process_identity);
  assert.equal(f.calls.length,0);await replacement.close();
});

test('unknown, missing and malformed live owner identity stays refused without probing the old HTTP URL',async t=>{
  const f=await fixture(t),descriptorPath=path.join(f.profile,'control','app-control.json');await f.control.close();
  const original={...f.control.descriptor};
  const cases=[{record:original,processIdentity:async()=>({state:'unknown',reason:'fixture_access_denied'})},
    {record:{...original,process_identity:undefined}},
    {record:{...original,process_identity:{...original.process_identity,creation_filetime:'invalid',start_ticks:'invalid'}}}];
  for(const item of cases){
    await fs.writeFile(descriptorPath,JSON.stringify(item.record));const before=await fs.readFile(descriptorPath,'utf8');
    await assert.rejects(startAppControl({...f.settings,instanceId:'owner-query-instance-789',...(item.processIdentity?{processIdentity:item.processIdentity}:{})}),{code:'app_control_owner_unknown'});
    assert.equal(await fs.readFile(descriptorPath,'utf8'),before);
  }
  assert.equal(f.calls.length,0);
});
