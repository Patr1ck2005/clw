'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto'),{crc32}=require('node:zlib');
const {performance}=require('node:perf_hooks');
const {captureShell,codes,PREPARATION_TIMEOUT_MS,STORAGE_TIMEOUT_MS}=require('../control-shell-capture.cjs');
const {createCaptureStore}=require('../control-captures.cjs');
const {startAppControl}=require('../app-control.cjs');
const http=require('node:http');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg4RD4DwABTAEc6BPG4AAAAABJRU5ErkJggg==','base64');
function fixture(changes={}){
 const calls=[],image={isEmpty:()=>{calls.push('image-empty');return false;},getSize:()=>{calls.push('image-size');return {width:1,height:1};},toPNG:()=>{calls.push('toPNG');return png;}};
 return {calls,image,options:{inspect:async()=>{calls.push('inspect');return {selected:'original-task'};},capture:async()=>{calls.push('capture');return image;},save:async bytes=>{calls.push('save');return {path:'private/capture-fixture.png',capture_retention:32,cleanup_pending:false};},assertOwner:response=>calls.push(response?'owner-after-storage':'owner'),...changes}};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const nextTask=()=>new Promise(resolve=>setImmediate(resolve));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('one validated native capture is saved by the unchanged bounded store and returns exact PNG metadata',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clw-shell-capture-'));t.after(async()=>{assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
 const f=fixture(),store=createCaptureStore(directory);f.options.save=bytes=>{f.calls.push('save');return store.capture(bytes);};
 const result=await captureShell(f.options);assert.deepEqual(await fs.readFile(result.path),png);
 assert.deepEqual(result.png,{bytes:70,sha256:createHash('sha256').update(png).digest('hex'),width:1,height:1});
 assert.deepEqual(result.inspection,{selected:'original-task'});assert.equal(result.model_sends,0);assert.equal(result.capture_retention,32);
 assert.deepEqual(f.calls,['inspect','owner','capture','owner','image-empty','image-size','toPNG','save','owner-after-storage']);
});
for(const [name,code,operation]of [['inspect',codes.inspect,'inspect'],['native',codes.native,'capture'],['png',codes.png,'toPNG'],['storage',codes.storage,'save']])
test(name+' failure retains its exact local cause and exposes only a fixed acceptance-aware stage code',async()=>{
 const original=Object.assign(Error('PRIVATE page / secret-user-path / raw native details'),{code:'PRIVATE_NATIVE_DETAIL'}),f=fixture();
 if(operation==='toPNG')f.image.toPNG=()=>{f.calls.push('toPNG');throw original;};
 else f.options[operation]=async()=>{f.calls.push(operation);throw original;};
 await assert.rejects(captureShell(f.options),error=>{
  assert.equal(error.code,code);assert.equal(error.stage,name);assert.equal(error.accepted,name==='storage');assert.equal(error.cause,original);
  assert.equal(error.message,code);assert.doesNotMatch(JSON.stringify(error),/PRIVATE|secret-user-path|raw native/);return true;
 });
 if(name!=='storage')assert.equal(f.calls.includes('save'),false);
});
const invalidImages=[
 ['missing',null],['empty',{isEmpty:()=>true,getSize:()=>({width:1,height:1}),toPNG:()=>png}],
 ...[{width:0,height:1},{width:1,height:0},{width:-1,height:1},{width:1.5,height:1},{width:NaN,height:1},{width:1,height:Infinity}].map((size,i)=>['dimensions-'+i,{isEmpty:()=>false,getSize:()=>size,toPNG:()=>png}])
];
for(const [name,image]of invalidImages)test('invalid native image '+name+' is rejected before encoding or storage',async()=>{
 const f=fixture({capture:async()=>image});await assert.rejects(captureShell(f.options),{code:codes.image,accepted:false});assert.equal(f.calls.includes('save'),false);
});
test('a native image getter exception is classified as image validation, not as storage uncertainty',async()=>{
 const original=Error('image getter failed'),f=fixture();f.image.getSize=()=>{throw original;};
 await assert.rejects(captureShell(f.options),error=>error.code===codes.image&&error.accepted===false&&error.cause===original);assert.equal(f.calls.includes('save'),false);
});
function changedHeader(change){const value=Buffer.from(png);change(value);value.writeUInt32BE(crc32(value.subarray(12,29)),29);return value;}
const invalidPNGs=[
 ['empty',Buffer.alloc(0)],['non-buffer',new Uint8Array(png)],['bad-signature',Buffer.from('not a PNG')],
 ['header-only',png.subarray(0,33)],['truncated-chunk',png.subarray(0,png.length-1)],['trailing-data',Buffer.concat([png,Buffer.from('extra')])],
 ['wrong-dimensions',changedHeader(value=>value.writeUInt32BE(2,16))],['wrong-depth',changedHeader(value=>{value[24]=3;})],
 ['bad-checksum',(()=>{const value=Buffer.from(png);value[44]^=1;return value;})()],
 ['missing-image-data',Buffer.concat([png.subarray(0,33),png.subarray(-12)])]
];
for(const [name,bytes]of invalidPNGs)test('invalid PNG '+name+' cannot be completed or written',async()=>{
 const f=fixture();f.image.toPNG=()=>bytes;await assert.rejects(captureShell(f.options),{code:codes.png,accepted:false});assert.equal(f.calls.includes('save'),false);
});
for(const check of [1,2,3])test('owner assertion '+check+' retains its original identity refusal without stage wrapping',async()=>{
 const original=Object.assign(Error('app_control_selection_changed'),{code:'app_control_selection_changed',accepted:check===3}),f=fixture();let assertions=0;
 f.options.assertOwner=response=>{if(++assertions===check){assert.equal(!!response,check===3);throw original;}};
 await assert.rejects(captureShell(f.options),error=>error===original);assert.equal(f.calls.includes('save'),check===3);
});

test('the default preparation deadline is finite and shorter than the shell IPC timeout',()=>{
 assert.equal(PREPARATION_TIMEOUT_MS,3000);assert.equal(STORAGE_TIMEOUT_MS,3000);
});
for(const timeoutMs of [0,-1,NaN,Infinity,3001])test('invalid private preparation timeout '+timeoutMs+' does not start reads',async()=>{
 const f=fixture({timeoutMs});await assert.rejects(captureShell(f.options),{code:codes.options,accepted:false});assert.deepEqual(f.calls,[]);
});
for(const storageTimeoutMs of [0,-1,NaN,Infinity,3001])test('invalid private storage timeout '+storageTimeoutMs+' does not start reads',async()=>{
 const f=fixture({storageTimeoutMs});await assert.rejects(captureShell(f.options),{code:codes.options,accepted:false});assert.deepEqual(f.calls,[]);
});

test('never-settling inspection ends control waiting and prevents native capture even after its late reply',async()=>{
 const original=deferred(),owner={},f=fixture({nativeOwner:owner,timeoutMs:20,inspect:()=>original.promise});
 const started=performance.now();await assert.rejects(captureShell(f.options),{code:codes.inspectTimeout,stage:'inspect',accepted:false});
 assert.ok(performance.now()-started<1000);assert.deepEqual(f.calls,[]);
 const second=fixture({nativeOwner:owner});await assert.rejects(captureShell(second.options),{code:codes.inspectPending,accepted:false});assert.deepEqual(second.calls,[]);
 original.resolve({late:true});await nextTask();assert.deepEqual(f.calls,[]);
 assert.equal((await captureShell(second.options)).png.bytes,70);
});

test('never-settling native capture times out without image access or output and blocks fresh closures for the same contents',async()=>{
 const original=deferred(),owner={},f=fixture({nativeOwner:owner,timeoutMs:20,capture:()=>{f.calls.push('capture');return original.promise;}});
 const started=performance.now();await assert.rejects(captureShell(f.options),{code:codes.nativeTimeout,stage:'native',accepted:false});
 assert.ok(performance.now()-started<1000);assert.deepEqual(f.calls,['inspect','owner','capture']);
 for(let i=0;i<3;i++){
  const second=fixture({nativeOwner:owner});await assert.rejects(captureShell(second.options),{code:codes.nativePending,accepted:false});assert.deepEqual(second.calls,[]);
 }
 // Property access itself would be a late continuation, before toPNG or save.
 original.resolve(new Proxy(f.image,{get(){throw Error('late image must remain untouched');}}));await nextTask();
 assert.deepEqual(f.calls,['inspect','owner','capture']);assert.equal((await captureShell(fixture({nativeOwner:owner}).options)).png.bytes,70);
});

test('a late native rejection is observed only for slot cleanup and cannot become an unhandled failure or storage attempt',async()=>{
 const original=deferred(),owner={},f=fixture({nativeOwner:owner,timeoutMs:20,capture:()=>original.promise});
 await assert.rejects(captureShell(f.options),{code:codes.nativeTimeout,accepted:false});
 original.reject(Error('late PRIVATE native detail'));await nextTask();
 assert.deepEqual(f.calls,['inspect','owner']);assert.equal((await captureShell(fixture({nativeOwner:owner}).options)).png.bytes,70);
});

test('concurrent calls reserve one exact contents owner; another contents can complete without waiting',async()=>{
 const read=deferred(),entered=deferred(),owner={},f=fixture({nativeOwner:owner,capture:()=>{entered.resolve();return read.promise;}});
 const first=captureShell(f.options);await entered.promise;
 const other=fixture({nativeOwner:owner});await assert.rejects(captureShell(other.options),{code:codes.nativePending,accepted:false});assert.deepEqual(other.calls,[]);
 assert.equal((await captureShell(fixture({nativeOwner:{}}).options)).png.bytes,70);
 read.resolve(f.image);await first;assert.equal((await captureShell(other.options)).png.bytes,70);
});

test('late resolution cannot release a newer owner slot after the first raw read settles',async()=>{
 const owner={},old=deferred(),f=fixture({nativeOwner:owner,timeoutMs:20,capture:()=>old.promise});
 await assert.rejects(captureShell(f.options),{code:codes.nativeTimeout});old.resolve(f.image);await nextTask();
 const current=deferred(),entered=deferred(),fresh=fixture({nativeOwner:owner,capture:()=>{entered.resolve();return current.promise;}});
 const operation=captureShell(fresh.options);await entered.promise;old.resolve(f.image);await nextTask();
 const duplicate=fixture({nativeOwner:owner});await assert.rejects(captureShell(duplicate.options),{code:codes.nativePending});assert.deepEqual(duplicate.calls,[]);
 current.resolve(fresh.image);await operation;
});

test('inspection and native capture share the preparation budget instead of receiving two full timeouts',async()=>{
 const never=deferred(),f=fixture({nativeOwner:{},timeoutMs:100,inspect:async()=>{await sleep(70);return {ok:true};},capture:()=>never.promise});
 const started=performance.now();await assert.rejects(captureShell(f.options),{code:codes.nativeTimeout,accepted:false});
 const elapsed=performance.now()-started;assert.ok(elapsed>=90&&elapsed<155,'one preparation deadline: '+elapsed);
 assert.equal(f.calls.includes('toPNG'),false);assert.equal(f.calls.includes('save'),false);never.resolve(f.image);await nextTask();
});

test('a native result settling beyond the deadline is rejected even before a delayed timeout callback can run',async()=>{
 const f=fixture({nativeOwner:{},timeoutMs:10,capture:()=>{
  const until=performance.now()+20;while(performance.now()<until){}return f.image;
 }});
 await assert.rejects(captureShell(f.options),{code:codes.nativeTimeout,accepted:false});assert.deepEqual(f.calls,['inspect','owner']);
});

test('an owner change while native capture waits retains its exact refusal and never encodes or writes',async()=>{
 const read=deferred(),entered=deferred(),original=Object.assign(Error('app_control_owner_changed'),{code:'app_control_owner_changed',accepted:false});
 let current=true;const f=fixture({nativeOwner:{},capture:()=>{entered.resolve();return read.promise;},assertOwner:()=>{if(!current)throw original;}});
 const operation=captureShell(f.options);await entered.promise;current=false;read.resolve(f.image);
 await assert.rejects(operation,error=>error===original);assert.deepEqual(f.calls,['inspect']);
});

test('once storage starts its late failure retains unknown acceptance and is never relabelled as a read timeout',async()=>{
 const write=deferred(),entered=deferred(),original=Error('storage after partial write'),f=fixture({nativeOwner:{},timeoutMs:20,save:()=>{entered.resolve();return write.promise;}});
 const operation=captureShell(f.options);const rejection=assert.rejects(operation,error=>error.code===codes.storage&&error.accepted===true&&error.cause===original);
 await entered.promise;await sleep(30);write.reject(original);await rejection;
});

test('falsy native rejections still retain the fixed failure classification and release their owner slot',async()=>{
 const f=fixture({nativeOwner:{},capture:()=>Promise.reject(undefined)});
 await assert.rejects(captureShell(f.options),error=>error.code===codes.native&&error.accepted===false&&error.cause===undefined);
 assert.equal(f.calls.includes('save'),false);assert.equal((await captureShell({...f.options,capture:async()=>f.image})).png.bytes,70);
});

test('storage timeout retains both exact owner and shared store until raw settlement without consuming late metadata',async()=>{
 const raw=deferred(),entered=deferred(),owner={},store={},f=fixture({nativeOwner:owner,storageOwner:store,storageTimeoutMs:20,save:()=>{f.calls.push('save');entered.resolve();return raw.promise;}});
 const operation=captureShell(f.options);await entered.promise;
 await assert.rejects(operation,{code:codes.storageTimeout,stage:'storage',accepted:true});
 for(const keys of [{nativeOwner:owner,storageOwner:{}},{nativeOwner:{},storageOwner:store}]){
  const second=fixture(keys);await assert.rejects(captureShell(second.options),{code:codes.storagePending,accepted:false});assert.deepEqual(second.calls,[]);
 }
 raw.resolve(new Proxy({path:'late-original.png'},{get(){throw Error('late saved metadata must not be consumed');}}));await nextTask();
 assert.equal(f.calls.filter(call=>call==='save').length,1);assert.equal(f.calls.includes('owner-after-storage'),false);
 assert.equal((await captureShell(fixture({nativeOwner:owner,storageOwner:store}).options)).png.bytes,70);
});

test('late storage rejection cannot change the unknown timeout or poison a subsequent settled-owner capture',async()=>{
 const raw=deferred(),owner={},store={},f=fixture({nativeOwner:owner,storageOwner:store,storageTimeoutMs:20,save:()=>raw.promise});
 let observed;try{await captureShell(f.options);}catch(error){observed=error;}
 assert.equal(observed.code,codes.storageTimeout);assert.equal(observed.accepted,true);
 raw.reject(Error('late PRIVATE original write failure'));await nextTask();
 assert.equal(observed.code,codes.storageTimeout);assert.equal(observed.accepted,true);
 assert.equal((await captureShell(fixture({nativeOwner:owner,storageOwner:store}).options)).png.bytes,70);
});

test('two different contents preparing concurrently recheck one shared store before saving and never enqueue a second write',async()=>{
 const store={},aRead=deferred(),bRead=deferred(),aEntered=deferred(),bEntered=deferred(),saved=deferred(),saveEntered=deferred();let writes=0;
 const a=fixture({nativeOwner:{},storageOwner:store,capture:()=>{aEntered.resolve();return aRead.promise;},save:()=>{writes++;saveEntered.resolve();return saved.promise;}});
 const b=fixture({nativeOwner:{},storageOwner:store,capture:()=>{bEntered.resolve();return bRead.promise;},save:()=>{writes++;return {path:'unexpected-second.png'};}});
 const first=captureShell(a.options),second=captureShell(b.options);await Promise.all([aEntered.promise,bEntered.promise]);
 aRead.resolve(a.image);await saveEntered.promise;
 const refused=assert.rejects(second,{code:codes.storagePending,accepted:false});bRead.resolve(b.image);await refused;
 assert.equal(writes,1);saved.resolve({path:'original-only.png'});assert.equal((await first).path,'original-only.png');
});

for(const phase of ['writeFile','readdir','lstat','unlink'])test('actual store tail pending in '+phase+' is bounded without a second capture or write',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clw-store-deadline-')),gate=deferred(),entered=deferred();let blocked=false,writes=0,originalSave;
 const old=path.join(directory,'capture-00000000-0000-0000-0000-000000000000.png');
 if(phase==='unlink')await fs.writeFile(old,png);
 const io={...fs,writeFile:async(...args)=>{writes++;if(phase==='writeFile'){blocked=true;entered.resolve();await gate.promise;}return fs.writeFile(...args);}};
 if(phase!=='writeFile')io[phase]=async(...args)=>{blocked=true;entered.resolve();await gate.promise;return fs[phase](...args);};
 const store=createCaptureStore(directory,{limit:1,io}),f=fixture({nativeOwner:{},storageOwner:store,storageTimeoutMs:30,save:bytes=>{originalSave=store.capture(bytes);return originalSave;}});
 t.after(async()=>{gate.resolve();await originalSave?.catch(()=>{});assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
 const operation=captureShell(f.options),unknown=assert.rejects(operation,{code:codes.storageTimeout,accepted:true});await entered.promise;await unknown;
 assert.equal(blocked,true);const second=fixture({nativeOwner:{},storageOwner:store});await assert.rejects(captureShell(second.options),{code:codes.storagePending,accepted:false});assert.deepEqual(second.calls,[]);
 gate.resolve();await originalSave;await nextTask();assert.equal(writes,1);assert.equal(f.calls.includes('owner-after-storage'),false);
 const files=(await fs.readdir(directory)).filter(name=>name.endsWith('.png'));assert.equal(files.length,1);assert.deepEqual(await fs.readFile(path.join(directory,files[0])),png);
});

function controlRequest(control,route,{method='GET',value}={}){
 const url=new URL(control.descriptor.url),raw=value===undefined?undefined:JSON.stringify(value);
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:url.port,path:route,method,headers:{Authorization:'Bearer '+control.descriptor.token,...(raw===undefined?{}:{'Content-Type':'application/json'})}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch(error){reject(error);}});
  });req.on('error',reject);req.end(raw);
 });
}
function controlCommand(control,id,action='capture-shell'){
 return {operation_id:id,action,payload:{},expected_identity:{app_instance_id:control.descriptor.app_instance_id,runtime_generation:7}};
}
async function controlTerminal(control,id){
 for(let i=0;i<200;i++){
  const receipt=await controlRequest(control,'/operations/'+id);if(receipt.status===200&&!['accepted','running'].includes(receipt.value.state))return receipt.value;
  await sleep(5);
 }throw Error('capture receipt did not reach a bounded terminal state');
}

test('actual AppControl releases global flight after native timeout, keeps same-key receipt, and admits quit without another native call',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'clw-capture-flight-')),profile=path.join(root,'profile'),store=createCaptureStore(path.join(profile,'control'));
 const owner={},raw=deferred(),entered=deferred();let nativeCalls=0,inspectCalls=0,encodings=0,saves=0,quitCalls=0;
 const image={isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>{encodings++;return png;}};
 const control=await startAppControl({root,profile,instanceId:'capture-timeout-fixture',capabilities:['capture-shell','quit'],snapshot:async()=>({runtime_generation:7}),dispatch:async action=>{
  if(action==='quit'){quitCalls++;return {quit:true,model_sends:0};}
  return captureShell({nativeOwner:owner,timeoutMs:30,inspect:async()=>{inspectCalls++;return {selected:'original'};},capture:()=>{nativeCalls++;entered.resolve();return raw.promise;},save:bytes=>{saves++;return store.capture(bytes);},assertOwner:()=>{}});
 }});
 t.after(async()=>{await control.close();assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
 const first=controlCommand(control,'capture-never-original');
 assert.equal((await controlRequest(control,'/commands',{method:'POST',value:first})).status,202);await entered.promise;
 // The original 30ms timeout may settle before this duplicate arrives under
 // concurrent suite load. Both receipts must refer to that same execution.
 const repeated=await controlRequest(control,'/commands',{method:'POST',value:first});
 assert.ok([200,202].includes(repeated.status));assert.equal(nativeCalls,1);
 const receipt=await controlTerminal(control,first.operation_id);
 assert.equal(receipt.state,'rejected');assert.deepEqual(receipt.error,{code:codes.nativeTimeout,accepted:false});assert.equal(receipt.result,undefined);
 assert.equal(repeated.value.execution_reference,receipt.execution_reference);
 const duplicate=await controlRequest(control,'/commands',{method:'POST',value:first});assert.equal(duplicate.status,200);
 assert.equal(duplicate.value.state,'rejected');assert.equal(duplicate.value.execution_reference,receipt.execution_reference);assert.deepEqual(duplicate.value.error,receipt.error);
 const pending=controlCommand(control,'capture-never-second');assert.equal((await controlRequest(control,'/commands',{method:'POST',value:pending})).status,202);
 const pendingReceipt=await controlTerminal(control,pending.operation_id);assert.equal(pendingReceipt.state,'rejected');assert.deepEqual(pendingReceipt.error,{code:codes.nativePending,accepted:false});
 const quit=controlCommand(control,'quit-after-capture-timeout','quit');assert.equal((await controlRequest(control,'/commands',{method:'POST',value:quit})).status,202);
 assert.equal((await controlTerminal(control,quit.operation_id)).state,'completed');assert.equal(quitCalls,1);assert.equal(nativeCalls,1);assert.equal(inspectCalls,1);
 raw.resolve(image);await nextTask();assert.equal(encodings,0);assert.equal(saves,0);
 assert.deepEqual((await fs.readdir(path.join(profile,'control'))).filter(name=>name.endsWith('.png')),[]);
 assert.deepEqual((await controlRequest(control,'/operations/'+first.operation_id)).value.error,receipt.error);
});

for(const late of ['resolve','reject'])test('actual AppControl keeps storage timeout unknown, admits quit, and discards late '+late+' without replaying original store IO',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'clw-store-flight-')),profile=path.join(root,'profile'),directory=path.join(profile,'control');
 const gate=deferred(),entered=deferred();let nativeCalls=0,inspectCalls=0,writes=0,quitCalls=0,originalSave;
 const store=createCaptureStore(directory,{io:{...fs,writeFile:async(...args)=>{writes++;entered.resolve();await gate.promise;return fs.writeFile(...args);}}});
 const control=await startAppControl({root,profile,instanceId:'storage-timeout-fixture-'+late,capabilities:['capture-shell','quit'],snapshot:async()=>({runtime_generation:7}),dispatch:async action=>{
  if(action==='quit'){quitCalls++;return {quit:true,model_sends:0};}
  const f=fixture({nativeOwner:{},storageOwner:store,storageTimeoutMs:30,inspect:async()=>{inspectCalls++;return {selected:'original'};},capture:async()=>{nativeCalls++;return f.image;},save:bytes=>{originalSave=store.capture(bytes);return originalSave;}});
  return captureShell(f.options);
 }});
 t.after(async()=>{gate.resolve();await originalSave?.catch(()=>{});await control.close();assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
 const first=controlCommand(control,'storage-never-original-'+late);
 assert.equal((await controlRequest(control,'/commands',{method:'POST',value:first})).status,202);await entered.promise;
 const receipt=await controlTerminal(control,first.operation_id);assert.equal(receipt.state,'unknown');assert.deepEqual(receipt.error,{code:codes.storageTimeout,accepted:true});assert.equal(receipt.result,undefined);
 const duplicate=await controlRequest(control,'/commands',{method:'POST',value:first});assert.equal(duplicate.status,200);assert.equal(duplicate.value.state,'unknown');assert.equal(duplicate.value.execution_reference,receipt.execution_reference);
 const pending=controlCommand(control,'storage-pending-second-'+late);assert.equal((await controlRequest(control,'/commands',{method:'POST',value:pending})).status,202);
 const pendingReceipt=await controlTerminal(control,pending.operation_id);assert.equal(pendingReceipt.state,'rejected');assert.deepEqual(pendingReceipt.error,{code:codes.storagePending,accepted:false});
 const quit=controlCommand(control,'quit-after-storage-timeout-'+late,'quit');assert.equal((await controlRequest(control,'/commands',{method:'POST',value:quit})).status,202);assert.equal((await controlTerminal(control,quit.operation_id)).state,'completed');
 assert.equal(quitCalls,1);assert.equal(nativeCalls,1);assert.equal(inspectCalls,1);assert.equal(writes,1);
 if(late==='resolve')gate.resolve();else gate.reject(Error('late original IO failure'));await originalSave.catch(()=>{});await nextTask();
 const after=(await controlRequest(control,'/operations/'+first.operation_id)).value;assert.equal(after.state,'unknown');assert.equal(after.execution_reference,receipt.execution_reference);assert.deepEqual(after.error,receipt.error);assert.equal(after.result,undefined);
 const replay=await controlRequest(control,'/commands',{method:'POST',value:first});assert.equal(replay.status,200);assert.equal(replay.value.state,'unknown');assert.equal(nativeCalls,1);assert.equal(writes,1);
 const files=(await fs.readdir(directory)).filter(name=>name.endsWith('.png'));assert.equal(files.length,late==='resolve'?1:0);
 if(files.length)assert.deepEqual(await fs.readFile(path.join(directory,files[0])),png);
});
