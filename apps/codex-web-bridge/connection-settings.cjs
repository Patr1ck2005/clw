'use strict';
// Private, explicit user configuration. This module does not launch a service,
// read key contents, discover tunnels, or modify the normal Codex environment.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const cfg=require('./bridge-config.cjs');
const {writePrivateFileAtomic}=require('./upstream/launcher/electron/atomic-file.cjs');
const digest=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const fail=code=>{throw Error(code);};
function rawSettings(root){
  const file=cfg.paths(root).settings;let raw;
  try{raw=fs.readFileSync(file);}catch(error){if(error.code==='ENOENT')return {file,raw:null,etag:'absent'};throw error;}
  if(raw.length>65536)fail('connection_settings_invalid');
  let selected;try{selected=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));}catch{fail('connection_settings_invalid');}
  if(!selected||typeof selected!=='object'||Array.isArray(selected)||typeof selected.enabled!=='boolean')fail('connection_settings_invalid');
  cfg.webAccount(selected);
  cfg.connectorAppName(selected);
  if(selected.enabled||selected.transport!==undefined){
    if(!['dedicated','shared-mcp'].includes(selected.transport||'dedicated'))fail('connection_transport_invalid');
    if(!selected.tunnel||typeof selected.tunnel!=='object')fail('connection_settings_invalid');
  }
  return {file,raw,etag:digest(raw),selected};
}
function fileReference(value,name){
  if(typeof value!=='string'||value.length>32767||!path.isAbsolute(value)||/[\x00-\x1f]/.test(value))fail('connection_'+name+'_required');
  const absolute=path.resolve(value),stat=fs.statSync(absolute,{throwIfNoEntry:false});
  if(!stat?.isFile())fail('connection_'+name+'_missing');
  return fs.realpathSync(absolute);
}
function prerequisite(file){try{return fs.statSync(file,{throwIfNoEntry:false})?.isFile()===true;}catch{return false;}}
function readConnection(root){
  const current=rawSettings(root),p=cfg.paths(root),s=current.selected||{enabled:false};
  return {etag:current.etag,configured:!!current.raw,enabled:s.enabled,webAccount:cfg.webAccount(s,root),appName:cfg.connectorAppName(s,null),transport:s.transport||'dedicated',
    tunnel:{tunnelId:s.tunnel?.tunnelId||'',runtimeKeyFile:s.tunnel?.runtimeKeyFile||'',binaryPath:s.tunnel?.binaryPath||''},
    sharedExisting:!!current.raw&&s.transport==='shared-mcp',
    prerequisites:{browserHelper:prerequisite(p.helper),bun:prerequisite(p.bun)},modelSends:0,keyContentsRead:false};
}
function validatedSelection(root,input,current){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['expected_etag','enabled','webAccount','appName','transport','tunnel'].includes(k)))fail('connection_request_invalid');
  if(typeof input.enabled!=='boolean'||!['A','B'].includes(input.webAccount)||!['dedicated','shared-mcp'].includes(input.transport))fail('connection_request_invalid');
  cfg.connectorAppName(input);
  const t=input.tunnel;
  if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).some(k=>!['tunnelId','runtimeKeyFile','binaryPath'].includes(k)))fail('connection_request_invalid');
  if(input.transport==='shared-mcp'){
    // An explicit browser account or connector name selection preserves this
    // installation's exact shared Union and tunnel references.
    const s=current.selected;
    if(!s||s.transport!=='shared-mcp'||['tunnelId','runtimeKeyFile','binaryPath'].some(k=>s.tunnel?.[k]!==t[k]))fail('connection_shared_existing_only');
  }
  // A missing external file must not make it impossible to explicitly disable
  // that unchanged broken connection. It grants no new route or identity.
  const original=current.selected;
  if(!input.enabled&&original&&(input.appName===undefined||input.appName===original.appName)&&
    cfg.webAccount(original)===input.webAccount&&(original.transport||'dedicated')===input.transport&&
    ['tunnelId','runtimeKeyFile','binaryPath'].every(k=>original.tunnel?.[k]===t[k]))return {...original,enabled:false};
  if(!/^tunnel_[a-f0-9]{32}$/.test(t.tunnelId||''))fail('connection_tunnel_identity_required');
  const tunnel={tunnelId:t.tunnelId,runtimeKeyFile:fileReference(t.runtimeKeyFile,'key_file'),binaryPath:fileReference(t.binaryPath,'tunnel_binary')};
  // Keep shared references byte-for-byte so they cannot become an implicit
  // profile handoff. Dedicated references use the explicitly selected identity.
  if(input.transport==='shared-mcp')Object.assign(tunnel,t);
  cfg.validateTunnel(root,tunnel,{shared:input.transport==='shared-mcp'});
  const prerequisites=readConnection(root).prerequisites;
  if(input.enabled&&(!prerequisites.browserHelper||!prerequisites.bun))fail('connection_runtime_prerequisites_missing');
  const appName=cfg.connectorAppName(input,cfg.connectorAppName(original));
  return {enabled:input.enabled,webAccount:input.webAccount,transport:input.transport,tunnel,...(appName===undefined?{}:{appName})};
}
function assertConnectionIdle({restored=false,records=[],busy=false,pendingStarts=[],nativeTurns=[],nativeVerified=false}={}){
  if(!restored||busy||pendingStarts.length||!nativeVerified)fail('connection_original_execution_unresolved');
  if(records.some(r=>!r.paused||['sent','unknown'].includes(r.bootstrap_state)||r.ended_recovery?.state==='unknown'||r.maintenance?.state==='holding'||
    r.latest_request&& !['completed','failed','blocked','closed','needs_attention','rejected','cancelled'].includes(r.latest_request.phase)))fail('connection_original_execution_unresolved');
  if(nativeTurns.some(t=>!['completed','failed','aborted'].includes(t.status)))fail('connection_original_execution_unresolved');
}
function saveConnection(root,input,{assertIdle=()=>fail('connection_idle_proof_required'),write=writePrivateFileAtomic}={}){
  assertIdle();const before=rawSettings(root);
  if(typeof input?.expected_etag!=='string'||input.expected_etag!==before.etag)fail('connection_settings_changed');
  const selected=validatedSelection(root,input,before),home=cfg.paths(root).home;
  fs.mkdirSync(home,{recursive:true});const lock=path.join(home,'settings.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('connection_settings_busy');throw error;}
  try{
    assertIdle();if(rawSettings(root).etag!==before.etag)fail('connection_settings_changed');
    write(before.file,JSON.stringify(selected,null,2)+'\n');
    const saved=readConnection(root);
    return {state:'connection_settings_saved',settings:saved,reopenRequired:true,modelSends:0,servicesStarted:0,tunnelsClaimed:0};
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
function readSettledTurns(root){
  const home=cfg.paths(root).home,journal=path.join(home,'turns');if(!fs.existsSync(journal))return [];
  const {createTurnDisplay}=require('./turn-journal.cjs'),{readSource}=require('./turn-source.cjs');
  const display=createTurnDisplay(home).display,batch=require('./native-action-receipt.cjs').createNativeActionReadBatch();
  const names=fs.readdirSync(journal);if(names.length>20000)fail('connection_original_execution_unresolved');
  const rows=names.filter(name=>name.endsWith('.json')).map(name=>{
    const file=path.join(journal,name),before=fs.statSync(file);
    if(!before.isFile()||before.size>1024*1024)fail('connection_original_execution_unresolved');
    const row=JSON.parse(fs.readFileSync(file,'utf8')),after=fs.statSync(file);
    if(name!==row.traceId+'.json'||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('connection_original_execution_unresolved');
    return display(row,{nativeStateForSource:source=>batch.read(source),sourceForTrace:trace=>{
      const sourceFile=path.join(home,'turn-sources',trace+'.json');let stat;
      try{stat=fs.statSync(sourceFile);}catch(error){if(error.code==='ENOENT')return null;throw error;}
      const source=readSource(home,trace),later=fs.statSync(sourceFile);
      if(!source||stat.size!==later.size||stat.mtimeMs!==later.mtimeMs||stat.ctimeMs!==later.ctimeMs)fail('connection_original_execution_unresolved');return source;
    }});
  });
  require('../web-host/native-turn-reads.cjs').nativeMaintenanceTurns({turns:()=>rows});return rows;
}
function cliIdle(root){
  // The active GUI owns its live execution checks. CLI changes are permitted
  // only after it has been normally closed; stale/unknown records are retained.
  const files=[path.join(root,'.local','web-host','health.json'),cfg.paths(root).status];
  for(const file of files){let value;try{value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(error){if(error.code==='ENOENT')continue;fail('connection_original_execution_unresolved');}
    const pid=value.pid;if(!Number.isSafeInteger(pid)||pid<1)fail('connection_original_execution_unresolved');
    try{process.kill(pid,0);fail('connection_close_workspace_first');}catch(error){if(error.message==='connection_close_workspace_first')throw error;if(error.code!=='ESRCH')fail('connection_original_execution_unresolved');}
    if(file.endsWith('status.json')&&!['stopped','disabled'].includes(value.state))fail('connection_original_execution_unresolved');
  }
  // Pending native sends may outlive their GUI. Never treat an exited owner as
  // evidence that a previously accepted operation was settled.
  readSettledTurns(root);
  if(fs.existsSync(path.join(root,'.local','harness','harness.sqlite3')))fail('connection_use_workspace_execution_checks');
}
module.exports={readConnection,saveConnection,assertConnectionIdle,readSettledTurns,cliIdle};
if(require.main===module){
  try{const root=path.resolve(__dirname,'../..'),request=JSON.parse(fs.readFileSync(0,'utf8'));
    const result=request.action==='read'?readConnection(root):request.action==='save'?saveConnection(root,request.payload,{assertIdle:()=>cliIdle(root)}):fail('connection_request_invalid');
    process.stdout.write(JSON.stringify({ok:true,result})+'\n');
  }catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.message})+'\n');process.exitCode=1;}
}
