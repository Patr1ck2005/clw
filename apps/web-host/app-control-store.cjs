'use strict';

const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
const STORE_VERSION=1,RECEIPT_CACHE_LIMIT=64,MAX_PENDING=128;

if(isMainThread){
  async function openOperationStore({file,root,profile,instanceId}){
    const worker=new Worker(__filename,{workerData:{file,root,profile,instanceId},execArgv:[],
      resourceLimits:{maxOldGenerationSizeMb:64}});
    let sequence=0,closed=false,failed=null,readyResolve,readyReject;
    const pending=new Map(),ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    function unavailable(code='app_control_storage_unavailable'){
      return Object.assign(new Error(code),{code});
    }
    function fail(error){
      failed=unavailable(error?.code);readyReject(failed);
      for(const item of pending.values())item.reject(failed);pending.clear();
    }
    worker.on('error',fail);
    worker.on('exit',code=>{if(!closed)fail({code:'app_control_storage_worker_exited'});});
    worker.on('message',message=>{
      if(message.ready){readyResolve(message.value);return;}
      if(message.fatal){fail(message.error);return;}
      const item=pending.get(message.id);if(!item)return;pending.delete(message.id);
      if(message.error)item.reject(unavailable(message.error.code));else item.resolve(message.value);
    });
    function request(action,value){
      if(closed||failed)return Promise.reject(failed||unavailable('app_control_storage_closed'));
      if(pending.size>=MAX_PENDING)return Promise.reject(unavailable('app_control_storage_busy'));
      const id=++sequence;
      return new Promise((resolve,reject)=>{
        pending.set(id,{resolve,reject});
        try{worker.postMessage({id,action,value});}catch(error){pending.delete(id);reject(error);}
      });
    }
    let information;
    try{information=await ready;}catch(error){closed=true;await worker.terminate();throw error;}
    let closing;
    return {file,needsMigration:information.needsMigration,
      get:id=>request('get',{id,instanceId}),historical:(id,originalInstanceId)=>request('historical',{id,instanceId:originalInstanceId}),
      importedInstances:()=>request('imported-instances'),put:entry=>request('put',entry),
      migrate:rows=>request('migrate',rows),recover:at=>request('recover',at),stats:()=>request('stats'),
      close(){
        if(closing)return closing;
        closing=(async()=>{try{if(!failed)await request('close');}finally{closed=true;await worker.terminate();}})();return closing;
      }};
  }
  module.exports={openOperationStore,STORE_VERSION,RECEIPT_CACHE_LIMIT};
}else{
  const fs=require('node:fs'),crypto=require('node:crypto'),zlib=require('node:zlib');
  const {DatabaseSync}=require('node:sqlite');
  let db,count=0;
  function error(code){return Object.assign(new Error(code),{code});}
  function transaction(callback){
    db.exec('BEGIN IMMEDIATE');
    try{const value=callback();db.exec('COMMIT');return value;}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  function start(){
    db=new DatabaseSync(workerData.file);
    try{fs.chmodSync(workerData.file,0o600);}catch{}
    db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1500;PRAGMA wal_autocheckpoint=128;PRAGMA foreign_keys=ON;');
    db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instances (instance_id TEXT PRIMARY KEY,root TEXT NOT NULL,profile TEXT NOT NULL,migrated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results (sha256 TEXT PRIMARY KEY,codec TEXT NOT NULL,data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (instance_id TEXT NOT NULL,operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,execution_reference TEXT NOT NULL,state TEXT NOT NULL,
        entry_json TEXT NOT NULL,result_sha256 TEXT REFERENCES results(sha256),
        PRIMARY KEY(instance_id,operation_id));
      CREATE INDEX IF NOT EXISTS pending_operations ON operations(state)
        WHERE state IN ('accepted','running');`);
    // Installed versions share their physical data directory. The code root
    // changes on upgrade; each instance retains its own original code identity.
    const identity=JSON.stringify({version:STORE_VERSION,profile:fs.realpathSync(workerData.profile)});
    const old=db.prepare('SELECT value FROM metadata WHERE key=?').get('identity');
    if(old&&old.value!==identity)throw error('app_control_store_identity_mismatch');
    if(!old){
      if(db.prepare('SELECT count(*) AS count FROM operations').get().count!==0)throw error('app_control_store_identity_missing');
      db.prepare('INSERT INTO metadata VALUES(?,?)').run('identity',identity);
    }
    db.prepare('INSERT OR IGNORE INTO instances VALUES(?,?,?,0)').run(workerData.instanceId,workerData.root,workerData.profile);
    const instance=db.prepare('SELECT root,profile,migrated FROM instances WHERE instance_id=?').get(workerData.instanceId);
    if(instance.root!==workerData.root||instance.profile!==workerData.profile)throw error('app_control_store_instance_identity_mismatch');
    count=db.prepare('SELECT count(*) AS count FROM operations WHERE instance_id=?').get(workerData.instanceId).count;
    return {needsMigration:instance.migrated!==1};
  }
  function save(entry,instanceId=workerData.instanceId){
    if(entry.app_instance_id!==instanceId)throw error('app_control_store_instance_mismatch');
    const old=db.prepare('SELECT request_hash,execution_reference FROM operations WHERE instance_id=? AND operation_id=?').get(instanceId,entry.operation_id);
    if(old&&(old.request_hash!==entry.request_hash||old.execution_reference!==entry.execution_reference))throw error('app_control_operation_conflict');
    let hash=null;const metadata={...entry};
    if(entry.result!==undefined){
      const raw=Buffer.from(JSON.stringify(entry.result));
      if(raw.length>128*1024)throw error('app_control_result_too_large');
      hash=crypto.createHash('sha256').update(raw).digest('hex');
      if(!db.prepare('SELECT 1 FROM results WHERE sha256=?').get(hash)){
        const compressed=raw.length>1024?zlib.deflateRawSync(raw):raw;
        const compact=compressed.length<raw.length;
        db.prepare('INSERT INTO results VALUES(?,?,?)').run(hash,compact?'deflate':'json',compact?compressed:raw);
      }
      delete metadata.result;
    }
    db.prepare(`INSERT INTO operations VALUES(?,?,?,?,?,?,?) ON CONFLICT(instance_id,operation_id)
      DO UPDATE SET state=excluded.state,entry_json=excluded.entry_json,result_sha256=excluded.result_sha256`).run(
        instanceId,entry.operation_id,entry.request_hash,entry.execution_reference,entry.state,JSON.stringify(metadata),hash);
    return old?0:1;
  }
  function get(id,instanceId=workerData.instanceId){
    const row=db.prepare(`SELECT entry_json,codec,data,results.sha256 AS result_sha256 FROM operations LEFT JOIN results ON results.sha256=operations.result_sha256
      WHERE instance_id=? AND operation_id=?`).get(instanceId,id);
    if(!row)return null;
    const entry=JSON.parse(row.entry_json);
    if(row.codec){
      const raw=row.codec==='deflate'?zlib.inflateRawSync(row.data,{maxOutputLength:128*1024}):Buffer.from(row.data);
      if(crypto.createHash('sha256').update(raw).digest('hex')!==row.result_sha256)throw error('app_control_stored_result_corrupt');
      entry.result=JSON.parse(raw.toString('utf8'));
    }
    return entry;
  }
  function handle(action,value){
    if(action==='get')return get(value.id,value.instanceId);
    if(action==='historical'){
      const identity=db.prepare('SELECT root,profile FROM instances WHERE instance_id=?').get(value.instanceId);
      if(!identity)return null;
      const entry=get(value.id,value.instanceId);return entry?{entry,identity:{app_instance_id:value.instanceId,...identity}}:null;
    }
    if(action==='imported-instances')return db.prepare('SELECT instance_id FROM instances WHERE migrated=1').all().map(row=>row.instance_id);
    if(action==='put'){const added=transaction(()=>save(value));count+=added;return true;}
    if(action==='migrate'){
      const added=transaction(()=>{
        const instanceId=value.instanceId||workerData.instanceId;
        const originalRoot=value.root||workerData.root,originalProfile=value.profile||workerData.profile;
        db.prepare('INSERT OR IGNORE INTO instances VALUES(?,?,?,0)').run(instanceId,originalRoot,originalProfile);
        const instance=db.prepare('SELECT root,profile,migrated FROM instances WHERE instance_id=?').get(instanceId);
        if(instance.root!==originalRoot||instance.profile!==originalProfile)throw error('app_control_store_instance_identity_mismatch');
        if(instance.migrated===1)return 0;
        let added=0;for(const row of value.rows)added+=save(row,instanceId);
        db.prepare('UPDATE instances SET migrated=1 WHERE instance_id=?').run(instanceId);return added;
      });if(!value.instanceId||value.instanceId===workerData.instanceId)count+=added;return true;
    }
    if(action==='recover')return transaction(()=>db.prepare(`UPDATE operations SET state='unknown',
      entry_json=json_set(entry_json,'$.state','unknown','$.updated_at',?,'$.error',json(?))
      WHERE state IN ('accepted','running')`).run(value,
        JSON.stringify({code:'app_control_process_restarted',accepted:true})).changes);
    if(action==='stats')return {operations:count,results:db.prepare('SELECT count(*) AS count FROM results').get().count,
      database_bytes:fs.statSync(workerData.file).size};
    if(action==='close'){db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();return true;}
    throw error('app_control_store_action_invalid');
  }
  try{parentPort.postMessage({ready:true,value:start()});}
  catch(error){parentPort.postMessage({fatal:true,error:{code:error.code||'app_control_store_open_failed'}});parentPort.close();}
  parentPort.on('message',message=>{
    try{
      const value=handle(message.action,message.value);parentPort.postMessage({id:message.id,value});
      if(message.action==='close')parentPort.close();
    }catch(error){parentPort.postMessage({id:message.id,error:{code:error.code||'app_control_store_failed'}});}
  });
}
