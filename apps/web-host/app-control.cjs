'use strict';

const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {protectControlDirectory,readControlProcessIdentity}=require('./app-control-private.cjs');
const {openOperationStore,RECEIPT_CACHE_LIMIT}=require('./app-control-store.cjs');

const VERSION=1;
const JOURNAL_VERSION=2;
const BODY_LIMIT=64*1024;
const RESPONSE_LIMIT=1024*1024;
const RECEIPT_LIMIT=128*1024;
// Bounds for reading the previous JSON format and publishing the descriptor.
// The indexed SQLite operation store has no cumulative operation/byte cap.
const JOURNAL_LIMIT=8*1024*1024;
const OPERATION_LIMIT=512;
const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const INSTANCE_PATTERN=/^[A-Za-z0-9_-]{8,128}$/;
const ACTION_PATTERN=/^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_KEYS=new Set(['__proto__','prototype','constructor']);
const PRIVATE_RECEIPT_KEY=/^(?:token|authorization|cookie|cookies|password|secret|prompt|objective|text|body|content|draft|html)$/i;
let temporarySequence=0;

function controlError(code,status=409,accepted=false){
  return Object.assign(new Error(code),{code,status,accepted});
}
function safeCode(error,fallback){
  return typeof error?.code==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(error.code)?error.code:fallback;
}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function validProcessIdentity(value,pid){
  if(!object(value)||value.pid!==pid||typeof value.executable!=='string'||!path.isAbsolute(value.executable)||value.executable.includes('\0'))return false;
  const keys=Object.keys(value).sort().join(',');
  if(value.kind==='windows-filetime')return keys==='creation_filetime,executable,kind,pid'&&typeof value.creation_filetime==='string'&&/^\d{16,20}$/.test(value.creation_filetime);
  if(value.kind==='linux-proc')return keys==='boot_id,executable,kind,pid,start_ticks'&&typeof value.start_ticks==='string'&&/^\d+$/.test(value.start_ticks)
    &&typeof value.boot_id==='string'&&/^[a-f0-9-]{36}$/.test(value.boot_id);
  return value.kind==='current-process-token'&&keys==='executable,kind,lifetime_token,pid'&&typeof value.lifetime_token==='string'
    &&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.lifetime_token);
}
function assertJSON(value,depth=0){
  if(depth>32)throw controlError('app_control_json_depth',400);
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'&&Number.isFinite(value))return;
  if(Array.isArray(value)){for(const child of value)assertJSON(child,depth+1);return;}
  if(object(value)){
    for(const [key,child]of Object.entries(value)){
      if(RESERVED_KEYS.has(key))throw controlError('app_control_json_key',400);
      assertJSON(child,depth+1);
    }
    return;
  }
  throw controlError('app_control_json_value',400);
}
function stableJSON(value){
  if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableJSON(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function executionReference(instanceId,operationId){
  const bytes=crypto.createHash('sha256').update(instanceId+'\0'+operationId).digest().subarray(0,16);
  bytes[6]=(bytes[6]&0x0f)|0x80;bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
function cloneBounded(value,limit=RECEIPT_LIMIT){
  const json=JSON.stringify(value===undefined?null:value);
  if(Buffer.byteLength(json)>limit)throw controlError('app_control_result_too_large',503,true);
  return JSON.parse(json);
}
function privateReceipt(value,depth=0){
  if(depth>32)return '[omitted]';
  if(Array.isArray(value))return value.map(child=>privateReceipt(child,depth+1));
  if(object(value)){
    const result=Object.create(null);
    for(const [key,child]of Object.entries(value)){
      if(RESERVED_KEYS.has(key))continue;
      result[key]=PRIVATE_RECEIPT_KEY.test(key)?'[private]':privateReceipt(child,depth+1);
    }
    return result;
  }
  return value;
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

// The existing private-file contract uses mode 0600, a private directory and
// an exclusive temporary file. This variant also flushes the write-ahead log,
// but waits asynchronously when a Windows reader temporarily locks a rename.
async function writePrivateAtomic(file,value){
  const serialized=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(serialized)>JOURNAL_LIMIT)throw controlError('app_control_journal_too_large',503,true);
  const folder=path.dirname(file);
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  try{await fs.chmod(folder,0o700);}catch{}
  const temporary=file+'.tmp-'+process.pid+'-'+Date.now()+'-'+(++temporarySequence);
  let handle;
  try{
    handle=await fs.open(temporary,'wx',0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();handle=null;
    const delays=[25,50,100,150,250,350,500];
    for(let attempt=0;;attempt++){
      try{await fs.rename(temporary,file);break;}
      catch(error){
        if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES'].includes(error.code)||delays[attempt]===undefined)throw error;
        await sleep(delays[attempt]);
      }
    }
    try{await fs.chmod(file,0o600);}catch{}
  }finally{
    if(handle)try{await handle.close();}catch{}
    try{await fs.unlink(temporary);}catch{}
  }
}
async function readJSON(file){
  try{
    const info=await fs.stat(file);
    if(info.size>JOURNAL_LIMIT)throw controlError('app_control_file_too_large',503);
    return JSON.parse(await fs.readFile(file,'utf8'));
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function headerCount(req,name){let count=0;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;return count;}
function response(res,status,value){
  let json;
  try{json=JSON.stringify(value);if(Buffer.byteLength(json)>RESPONSE_LIMIT)throw Error('response size');}
  catch{status=503;json=JSON.stringify({error:{code:'app_control_response_too_large',accepted:false}});}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(json),
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});
  res.end(json);
}
async function readBody(req){
  if(headerCount(req,'content-type')!==1||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))
    throw controlError('app_control_content_type',415);
  if(req.headers['content-encoding'])throw controlError('app_control_content_encoding',415);
  const declared=req.headers['content-length'];
  if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>BODY_LIMIT))throw controlError('app_control_body_too_large',413);
  let size=0;const chunks=[];
  await new Promise((resolve,reject)=>{
    function clean(){req.removeListener('data',data);req.removeListener('end',done);req.removeListener('error',failed);req.removeListener('aborted',aborted);}
    function data(chunk){
      size+=chunk.length;
      if(size>BODY_LIMIT){clean();reject(controlError('app_control_body_too_large',413));return;}
      chunks.push(chunk);
    }
    function done(){clean();resolve();}
    function failed(){clean();reject(controlError('app_control_request_interrupted',400));}
    function aborted(){failed();}
    req.on('data',data);req.on('end',done);req.on('error',failed);req.on('aborted',aborted);
  });
  let value;
  try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw controlError('app_control_json_invalid',400);}
  assertJSON(value);return value;
}
function receipt(entry,durable=true){
  if(durable&&entry.published)return entry.published;
  const result={operation_id:entry.operation_id,app_instance_id:entry.app_instance_id,action:entry.action,
    execution_reference:entry.execution_reference,state:entry.state,accepted_at:entry.accepted_at,updated_at:entry.updated_at};
  if(entry.result!==undefined)result.result=entry.result;
  if(entry.result_observed===true)result.result_observed=true;
  if(entry.error)result.error=entry.error;
  return result;
}

async function startAppControl({root,profile,instanceId,pid=process.pid,snapshot,dispatch,capabilities=[],
  protectDirectory=protectControlDirectory,writeAtomic=writePrivateAtomic,processIdentity=readControlProcessIdentity,
  createStore=openOperationStore}={}){
  if(typeof root!=='string'||!path.isAbsolute(root)||typeof profile!=='string'||!path.isAbsolute(profile))throw controlError('app_control_paths_invalid',400);
  if(typeof instanceId!=='string'||!INSTANCE_PATTERN.test(instanceId)||!Number.isSafeInteger(pid)||pid<1)throw controlError('app_control_identity_invalid',400);
  if(typeof snapshot!=='function'||typeof dispatch!=='function')throw controlError('app_control_callbacks_invalid',400);
  if(!Array.isArray(capabilities)||capabilities.some(action=>typeof action!=='string'||!ACTION_PATTERN.test(action))||new Set(capabilities).size!==capabilities.length)
    throw controlError('app_control_capabilities_invalid',400);
  root=path.resolve(root);profile=path.resolve(profile);
  if(typeof protectDirectory!=='function'||typeof writeAtomic!=='function'||typeof processIdentity!=='function'||typeof createStore!=='function')throw controlError('app_control_private_directory_invalid',400);
  const controlDirectory=path.join(profile,'control');
  const protection=await protectDirectory(controlDirectory);
  if(protection?.verified!==true)throw controlError('app_control_private_directory_unavailable',503);
  const allowed=new Set(capabilities),descriptorPath=path.join(controlDirectory,'app-control.json');
  let previous;
  try{previous=await readJSON(descriptorPath);}catch{throw controlError('app_control_descriptor_unreadable',503);}
  if(previous){
    if(!object(previous)||previous.version!==VERSION||!Number.isSafeInteger(previous.pid)||previous.pid<1
      ||typeof previous.app_instance_id!=='string'||!INSTANCE_PATTERN.test(previous.app_instance_id))throw controlError('app_control_owner_unknown',409);
    const original=await processIdentity(previous.pid);
    if(original?.state==='unknown'||!['alive','absent'].includes(original?.state))throw controlError('app_control_owner_unknown',409);
    if(original.state==='alive'){
      if(!validProcessIdentity(previous.process_identity,previous.pid)||!validProcessIdentity(original.identity,previous.pid))throw controlError('app_control_owner_unknown',409);
      if(stableJSON(original.identity)===stableJSON(previous.process_identity))throw controlError('app_control_owner_active',409);
      // Only an independently observed creation/source mismatch proves PID
      // reuse. Incomplete or differently shaped observations remain unknown.
      if(original.identity.kind!==previous.process_identity.kind
        ||Object.keys(original.identity).sort().join(',')!==Object.keys(previous.process_identity).sort().join(','))throw controlError('app_control_owner_unknown',409);
    }
  }
  const ownIdentity=await processIdentity(pid);
  if(ownIdentity?.state!=='alive'||!validProcessIdentity(ownIdentity.identity,pid))throw controlError('app_control_process_identity_unavailable',503);
  const entries=new Map();let inFlight=null,closed=false,persistence=Promise.resolve(),execution=null,store;
  const token=crypto.randomBytes(32).toString('base64url'),tokenHash=crypto.createHash('sha256').update(token).digest();
  const startedAt=new Date().toISOString();
  const descriptor={version:VERSION,root,profile,control_directory:controlDirectory,protection,
    pid,process_identity:ownIdentity.identity,app_instance_id:instanceId,started_at:startedAt,url:null,token};

  function touch(entry){
    entries.delete(entry.operation_id);entries.set(entry.operation_id,entry);
    for(const [id,item] of entries){
      if(entries.size<=RECEIPT_CACHE_LIMIT)break;
      if(id!==inFlight&&!item.dirty&&!['accepted','running'].includes(item.state))entries.delete(id);
    }
    return entry;
  }
  function persist(entry){
    const value={...receipt(entry,false),request_hash:entry.request_hash,
      ...(entry.result===undefined?{}:{result:privateReceipt(entry.result)})};
    const pending=persistence.catch(()=>{}).then(()=>store.put(value)).then(()=>{entry.dirty=false;},error=>{entry.dirty=true;throw error;});
    persistence=pending;return pending;
  }
  function validateSavedRow(row,originalInstanceId=instanceId){
        if(!object(row)||!ID_PATTERN.test(row.operation_id)||row.app_instance_id!==originalInstanceId||!ACTION_PATTERN.test(row.action)
          ||typeof row.request_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.request_hash)
          ||row.execution_reference!==executionReference(originalInstanceId,row.operation_id)
          ||!['accepted','running','completed','rejected','unknown'].includes(row.state)
          ||Object.keys(row).some(key=>!['operation_id','app_instance_id','action','execution_reference','request_hash','state','accepted_at','updated_at','result','result_observed','error'].includes(key))
          ||typeof row.accepted_at!=='string'||!Number.isFinite(Date.parse(row.accepted_at))
          ||typeof row.updated_at!=='string'||!Number.isFinite(Date.parse(row.updated_at)))throw Error('journal operation');
        assertJSON(row);
        if(row.result_observed!==undefined&&(row.result_observed!==true||row.result===undefined))throw Error('journal observed result');
        if(row.result!==undefined)cloneBounded(row.result);
        if(row.error!==undefined&&(!object(row.error)||typeof row.error.code!=='string'||typeof row.error.accepted!=='boolean'
          ||Object.keys(row.error).sort().join(',')!=='accepted,code'))throw Error('journal error');
    return {...row};
  }
  async function lookup(id){
    let entry=entries.get(id);
    if(entry)return touch(entry);
    const saved=await store.get(id);
    entry=entries.get(id);if(entry)return touch(entry);
    if(!saved)return null;
    entry=validateSavedRow(saved);entry.published=receipt(entry,false);return touch(entry);
  }
  try{
    store=await createStore({file:path.join(controlDirectory,'app-control-operations.sqlite'),root,profile,instanceId});
    const imported=new Set(await store.importedInstances());
    const legacyNames=(await fs.readdir(controlDirectory)).filter(name=>/^app-control-operations-[A-Za-z0-9_-]{8,128}\.json$/.test(name));
    for(const name of legacyNames){
      const originalInstanceId=name.slice('app-control-operations-'.length,-'.json'.length);
      if(imported.has(originalInstanceId))continue;
      const saved=await readJSON(path.join(controlDirectory,name)),rows=[];
      if(saved){
        if(saved.version!==JOURNAL_VERSION||saved.app_instance_id!==originalInstanceId
          ||typeof saved.root!=='string'||!path.isAbsolute(saved.root)||typeof saved.profile!=='string'||!path.isAbsolute(saved.profile)
          ||!Array.isArray(saved.operations)||saved.operations.length>OPERATION_LIMIT)
          throw Error('journal identity');
        if(originalInstanceId===instanceId&&(saved.root!==root||saved.profile!==profile))throw Error('journal current identity');
        const ids=new Set();
        for(const row of saved.operations){
          if(ids.has(row?.operation_id))throw Error('journal duplicate');
          const entry=validateSavedRow(row,originalInstanceId);ids.add(entry.operation_id);rows.push({...entry,
            ...(entry.result===undefined?{}:{result:privateReceipt(entry.result)})});
        }
      }
      if(saved)await store.migrate({instanceId:originalInstanceId,root:saved.root,profile:saved.profile,rows});
    }
    if(store.needsMigration&&!imported.has(instanceId))await store.migrate({rows:[]});
    await store.recover(startedAt);
  }catch{
    if(store)await store.close().catch(()=>{});
    throw controlError('app_control_journal_unreadable',503);
  }

  async function run(entry,envelope){
    if(entry.state!=='accepted'||closed)return;
    entry.state='running';entry.updated_at=new Date().toISOString();
    try{
      await persist(entry);
      entry.published=receipt(entry,false);
      const result=await dispatch(envelope.action,envelope.payload,envelope.expected_identity,
        {operation_id:entry.operation_id,app_instance_id:instanceId,execution_reference:entry.execution_reference});
      entry.result=cloneBounded(result);
      entry.result_observed=true;
      entry.state='completed';entry.updated_at=new Date().toISOString();
      // A terminal receipt is advertised only after its exact write completes.
      await persist(entry);
      entry.published=receipt(entry,false);
    }catch(error){
      // An observed Host/business receipt remains useful even when its terminal
      // log flush fails. Keep its original linkage; never turn it into permission
      // to redispatch, or publish it as a durably completed outer operation.
      entry.state=entry.result_observed===true?'unknown':error?.accepted===false?'rejected':'unknown';
      entry.updated_at=new Date().toISOString();
      entry.error={code:safeCode(error,'app_control_dispatch_unknown'),accepted:entry.result_observed===true||error?.accepted!==false};
      try{await persist(entry);entry.published=receipt(entry,false);}
      catch{entry.state='unknown';entry.error={code:'app_control_journal_unavailable',accepted:true};entry.published=receipt(entry,false);}
    }finally{if(inFlight===entry.operation_id)inFlight=null;touch(entry);}
  }
  function validateEnvelope(value){
    if(!object(value)||Object.keys(value).sort().join(',')!=='action,expected_identity,operation_id,payload')throw controlError('app_control_command_envelope',400);
    if(typeof value.operation_id!=='string'||!ID_PATTERN.test(value.operation_id))throw controlError('app_control_operation_id',400);
    if(typeof value.action!=='string'||!allowed.has(value.action))throw controlError('app_control_action_forbidden',403);
    if(!object(value.payload)||!object(value.expected_identity))throw controlError('app_control_command_shape',400);
    if(value.expected_identity.app_instance_id!==instanceId)throw controlError('app_control_instance_mismatch',409);
    if(!Number.isSafeInteger(value.expected_identity.runtime_generation)||value.expected_identity.runtime_generation<0)throw controlError('app_control_runtime_generation',400);
  }
  async function submit(value){
    if(closed)throw controlError('app_control_closed',503);
    validateEnvelope(value);
    const requestHash=crypto.createHash('sha256').update(stableJSON(value)).digest('hex');
    const existing=await lookup(value.operation_id);
    if(existing){
      if(existing.request_hash!==requestHash)throw controlError('app_control_operation_conflict',409);
      if(existing.acceptance)await existing.acceptance.catch(()=>{});
      return receipt(existing);
    }
    if(inFlight)throw controlError('app_control_operation_in_flight',409);
    // Repair only original receipts, never their business actions. An observed
    // result remains resident until stored, even after a temporary disk failure.
    for(const entry of entries.values())if(entry.dirty){
      try{await persist(entry);}catch{throw controlError('app_control_journal_unavailable',503);}
    }
    // The lookup/repair awaits can overlap another command's admission.
    const admitted=entries.get(value.operation_id);
    if(admitted){
      if(admitted.request_hash!==requestHash)throw controlError('app_control_operation_conflict',409);
      if(admitted.acceptance)await admitted.acceptance.catch(()=>{});
      return receipt(admitted);
    }
    if(inFlight)throw controlError('app_control_operation_in_flight',409);
    const at=new Date().toISOString(),entry={operation_id:value.operation_id,app_instance_id:instanceId,action:value.action,
      execution_reference:executionReference(instanceId,value.operation_id),request_hash:requestHash,state:'accepted',accepted_at:at,updated_at:at};
    entries.set(entry.operation_id,entry);inFlight=entry.operation_id;
    entry.acceptance=persist(entry);
    try{await entry.acceptance;}
    catch{
      entry.state='rejected';entry.updated_at=new Date().toISOString();entry.error={code:'app_control_journal_unavailable',accepted:false};
      entry.published=receipt(entry,false);
      inFlight=null;throw controlError('app_control_journal_unavailable',503);
    }
    entry.published=receipt(entry,false);
    setImmediate(()=>{execution=run(entry,value);void execution;});
    return receipt(entry);
  }
  async function command(value,res){const result=await submit(value);response(res,['accepted','running'].includes(result.state)?202:200,result);}
  const server=http.createServer({maxHeaderSize:8192,requestTimeout:5000,headersTimeout:5000},async(req,res)=>{
    try{
      if(closed)throw controlError('app_control_closed',503);
      if(req.socket.remoteAddress!=='127.0.0.1'||headerCount(req,'host')!==1||req.headers.host!==descriptor.url.slice('http://'.length))
        throw controlError('app_control_host_forbidden',403);
      if(req.headers.origin!==undefined||Object.keys(req.headers).some(key=>key.startsWith('sec-fetch-')))
        throw controlError('app_control_browser_forbidden',403);
      const authorization=req.headers.authorization||'',candidate=authorization.startsWith('Bearer ')?authorization.slice(7):'';
      const suppliedHash=crypto.createHash('sha256').update(candidate).digest();
      if(headerCount(req,'authorization')!==1||!crypto.timingSafeEqual(suppliedHash,tokenHash))throw controlError('app_control_unauthorized',401);
      if(req.url==='/state'&&req.method==='GET'){
        const state=cloneBounded(await snapshot(),RESPONSE_LIMIT-1024);
        response(res,200,{version:VERSION,app_instance_id:instanceId,state});return;
      }
      if(req.url==='/capabilities'&&req.method==='GET'){
        response(res,200,{version:VERSION,app_instance_id:instanceId,capabilities:[...allowed],
          limits:{body_bytes:BODY_LIMIT,operation_receipt_bytes:RECEIPT_LIMIT,journal_bytes:null,operations:null,
            receipt_cache:RECEIPT_CACHE_LIMIT,storage:'sqlite-worker'},
          operation_contract:'Original operation IDs are never dispatched again; unknown receipts require inspection.'});return;
      }
      const operationMatch=/^\/operations\/([A-Za-z0-9][A-Za-z0-9_.:-]{7,127})(?:\?original_instance_id=([A-Za-z0-9_-]{8,128}))?$/.exec(req.url||'');
      if(operationMatch&&req.method==='GET'){
        if(operationMatch[2]){
          const original=await store.historical(operationMatch[1],operationMatch[2]);
          if(!original)throw controlError('app_control_operation_missing',404);
          const entry=validateSavedRow(original.entry,operationMatch[2]);
          response(res,200,{version:VERSION,app_instance_id:instanceId,original_identity:original.identity,
            operation:receipt(entry,false)});return;
        }
        const entry=await lookup(operationMatch[1]);
        if(!entry)throw controlError('app_control_operation_missing',404);
        if(entry.acceptance)await entry.acceptance.catch(()=>{});
        response(res,200,receipt(entry));return;
      }
      if(req.url==='/commands'&&req.method==='POST'){await command(await readBody(req),res);return;}
      if(['/state','/capabilities','/commands'].includes(req.url)||operationMatch)throw controlError('app_control_method_forbidden',405);
      throw controlError('app_control_route_missing',404);
    }catch(error){
      req.resume();
      if(!res.headersSent&&!res.destroyed)response(res,Number.isInteger(error.status)?error.status:503,
        {error:{code:safeCode(error,'app_control_request_failed'),accepted:error?.accepted===true}});
    }
  });
  server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
    descriptor.url='http://127.0.0.1:'+server.address().port;
    await writeAtomic(descriptorPath,descriptor);
  }catch(error){server.close();await store.close().catch(()=>{});throw error;}
  let closing;
  async function close(){
    if(closing)return closing;
    closed=true;
    closing=(async()=>{
      const stopped=new Promise(resolve=>server.close(()=>resolve()));
      server.closeAllConnections();await stopped;
      if(execution)await execution.catch(()=>{});
      await persistence.catch(()=>{});
      await store.close();
      try{
        const current=await readJSON(descriptorPath);
        if(current?.app_instance_id===instanceId&&current.token===token&&current.url===descriptor.url&&current.pid===pid
          &&stableJSON(current.process_identity)===stableJSON(descriptor.process_identity))await fs.unlink(descriptorPath);
      }catch(error){if(error.code!=='ENOENT')throw error;}
    })();
    return closing;
  }
  return {descriptor:Object.freeze({...descriptor}),server,close,
    async submit(value){return cloneBounded(await submit(value),RECEIPT_LIMIT+4096);},
    async operation(id){const entry=await lookup(id);return entry?cloneBounded(receipt(entry),RECEIPT_LIMIT+4096):null;},
    async storageStats(){return {...await store.stats(),memory_receipts:entries.size,
      pending_results:[...entries.values()].filter(entry=>entry.dirty).length};}};
}

module.exports={startAppControl,controlError,executionReference,writePrivateAtomic,VERSION,JOURNAL_VERSION,BODY_LIMIT,OPERATION_LIMIT};
