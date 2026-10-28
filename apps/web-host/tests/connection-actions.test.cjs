'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const connectionSettings=require('../../codex-web-bridge/connection-settings.cjs');
const execution=require('../../codex-web-bridge/connection-execution.cjs');
const {nativeMaintenanceTurns}=require('../native-turn-reads.cjs');
const main=fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),start=main.indexOf("    if(action==='connection-read')"),end=main.indexOf("    if(action==='background')",start);
assert.ok(start>0&&end>start);const source='(async function(action,payload={}){'+main.slice(start,end)+'})';
function fixture(t){
 const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'clw-connection-action-'));t.after(()=>fs.rmSync(ROOT,{recursive:true,force:true}));
 const make=name=>{const file=path.join(ROOT,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture-only');return file;};
 const key=make('key.txt'),binary=make('tunnel.exe');make('.local/runtimes/bun-1.4.0/bun.exe');make('apps/codex-web-bridge/upstream/dist/browser-helper.cjs');
 const context={ROOT,connectionSettings,connectionExecution:{...execution,readExecution:async()=>({version:1,source:'canonical_harness_readonly',idle:true,fingerprint:execution.fingerprint(ROOT)})},nativeMaintenanceTurns,workspaceRestored:true,runtimeGeneration:1,runtime:{ready:true,call:async()=>({pages:[]})},
  workspace:{tasks:new Map(),pendingStarts:{}},driver:{records:new Map(),recordsLoaded:true,busy:new Set(),pending:new Map()},nativeBridge:null,submissions:{busy:new Set()},creating:false,quitting:false,notice:'',publish(){}};
 const run=vm.runInNewContext(source,context),payload={expected_etag:'absent',enabled:true,webAccount:'A',transport:'dedicated',tunnel:{tunnelId:'tunnel_'+'a'.repeat(32),runtimeKeyFile:key,binaryPath:binary}};
 return {context,run,payload,ROOT};
}
test('fresh desktop setup saves only settings while original service identity stays unconfigured',async t=>{
 const f=fixture(t);const r=await f.run('connection-save',f.payload);assert.equal(r.state,'connection_settings_saved');assert.equal(r.modelSends,0);assert.equal(f.context.nativeBridge,null);
 assert.match(f.context.notice,/重新打开.*没有启动/);assert.equal(connectionSettings.readConnection(f.ROOT).enabled,true);
});
test('settings route reads the fresh managed ledger and refuses execution hidden by an idle display',async t=>{
 const f=fixture(t);f.context.driver.records.set('controller',{paused:true,latest_request:{phase:'completed'}});let reads=0;
 f.context.runtime.call=async action=>{assert.equal(action,'list');reads++;return {pages:[{paused:false,latest_request:{phase:'processing'}}]};};
 await assert.rejects(f.run('connection-save',f.payload),/execution_unresolved/);assert.equal(reads,1);assert.equal(connectionSettings.readConnection(f.ROOT).etag,'absent');
});
test('connection generation change during original receipt read cannot save an old account intent',async t=>{
 const f=fixture(t);f.context.driver.records.set('controller',{paused:true,latest_request:{phase:'completed'}});
 f.context.runtime.call=async()=>{f.context.runtimeGeneration++;return {pages:[]};};
 await assert.rejects(f.run('connection-save',f.payload),/execution_unresolved/);assert.equal(connectionSettings.readConnection(f.ROOT).enabled,false);
});
test('failed native canonical read and pending original operation block settings changes',async t=>{
 const f=fixture(t);let reads=0;f.context.nativeBridge={turns(){reads++;throw Error('fixture-canonical-unavailable');},snapshot(){return {state:'ready',recent:[]};}};
 await assert.rejects(f.run('connection-save',f.payload),error=>error.code==='maintenance_exit_requires_original_receipt'&&error.accepted===false);assert.equal(reads,1);
 f.context.nativeBridge=null;f.context.workspace.pendingStarts.controller={operation_id:'original-key'};
 await assert.rejects(f.run('connection-save',f.payload),/execution_unresolved/);assert.equal(connectionSettings.readConnection(f.ROOT).etag,'absent');
});
test('known canonical execution guards return their precise rejected reason without writing settings',async t=>{
 const f=fixture(t);f.context.connectionExecution.readExecution=async()=>{throw Error('connection_execution_store_unverified');};
 await assert.rejects(f.run('connection-save',f.payload),error=>error.code==='connection_execution_store_unverified'&&error.accepted===false);
 assert.equal(connectionSettings.readConnection(f.ROOT).etag,'absent');
});
test('unrestored saved tasks and startup bootstrap unknown never become permission to switch routes',async t=>{
 const f=fixture(t);f.context.workspace.tasks.set('original',{kind:'task'});f.context.runtime.ready=false;
 await assert.rejects(f.run('connection-save',f.payload),/execution_unresolved/);
 f.context.runtime.ready=true;f.context.driver.records.set('original',{paused:true,bootstrap_state:'unknown'});
 await assert.rejects(f.run('connection-save',f.payload),/execution_unresolved/);assert.equal(connectionSettings.readConnection(f.ROOT).etag,'absent');
});
test('native Session starting again during the ledger read is rechecked before any settings write',async t=>{
 const f=fixture(t);let active=false,reads=0;f.context.nativeBridge={turns(){reads++;return active?[{status:'running'}]:[];}};
 f.context.connectionExecution.readExecution=async()=>{active=true;return {version:1,source:'canonical_harness_readonly',idle:true,fingerprint:execution.fingerprint(f.ROOT)};};
 await assert.rejects(f.run('connection-save',f.payload),/original_receipt/);assert.equal(reads,2);assert.equal(connectionSettings.readConnection(f.ROOT).etag,'absent');
});
test('a different bridge initialized during the original ledger read cannot take over the saved intent',async t=>{
 const f=fixture(t);f.context.connectionExecution.readExecution=async()=>{f.context.nativeBridge={turns:()=>[]};return {version:1,source:'canonical_harness_readonly',idle:true,fingerprint:execution.fingerprint(f.ROOT)};};
 await assert.rejects(f.run('connection-save',f.payload),/execution_unresolved/);assert.equal(connectionSettings.readConnection(f.ROOT).etag,'absent');
});

test('ledger mutation during the final native Session scan is rejected before settings write',async t=>{
 const f=fixture(t);let reads=0;f.context.nativeBridge={turns(){reads++;if(reads===2){const db=path.join(f.ROOT,'.local/harness/harness.sqlite3');fs.mkdirSync(path.dirname(db),{recursive:true});fs.writeFileSync(db,'fixture-ledger-changed');}return [];}};
 await assert.rejects(f.run('connection-save',f.payload),/execution_store_changed/);assert.equal(reads,2);assert.equal(connectionSettings.readConnection(f.ROOT).etag,'absent');
});

function sharedFixture(t){
 const f=fixture(t),home=path.join(f.ROOT,'.local/codex-web-bridge'),profile=path.join(f.ROOT,'.local/account-b-tunnel/profiles/webcodex-account-b.yaml');
 fs.mkdirSync(path.dirname(profile),{recursive:true});fs.writeFileSync(profile,'tunnel_id: '+f.payload.tunnel.tunnelId);
 fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({enabled:true,webAccount:'A',appName:'Local-MCP-WKR',transport:'shared-mcp',tunnel:f.payload.tunnel}));
 f.payload={...f.payload,expected_etag:connectionSettings.readConnection(f.ROOT).etag,transport:'shared-mcp',webAccount:'B'};
 f.context.nativeBridge={snapshot:()=>({account:'A',state:'ready'}),turns:()=>{throw Error('historical-canonical-unavailable');}};
 return f;
}
test('saving only the next shared browser account leaves active native work, managed records and original claims untouched',async t=>{
 const f=sharedFixture(t),bridge=f.context.nativeBridge;
 f.context.driver.records.set('active',{paused:false,latest_request:{phase:'processing'}});
 f.context.workspace.pendingStarts.original={operation_id:'unknown-original'};
 f.context.driver.busy.add('active');f.context.submissions.busy.add('original-send');
 f.context.runtime.call=async()=>{throw Error('must-not-read-business-records');};
 f.context.connectionExecution.readExecution=async()=>{throw Error('must-not-read-global-ledger');};
 const ledger=path.join(f.ROOT,'.local/harness/harness.sqlite3');fs.mkdirSync(path.dirname(ledger),{recursive:true});fs.writeFileSync(ledger,'original terminal_pending and independent Jobs');
 const before=fs.readFileSync(ledger),result=await f.run('connection-save',f.payload);
 assert.equal(result.selectionApplies,'next_startup');assert.equal(result.nextStartupAccount,'B');assert.equal(result.activeAccount,'A');assert.equal(result.reopenRequired,true);
 assert.equal(result.modelSends,0);assert.equal(result.servicesStarted,0);assert.equal(f.context.nativeBridge,bridge);assert.equal(bridge.snapshot().account,'A');
 assert.deepEqual(fs.readFileSync(ledger),before);assert.equal(f.context.driver.records.get('active').latest_request.phase,'processing');assert.equal(f.context.workspace.pendingStarts.original.operation_id,'unknown-original');
 assert.equal(connectionSettings.readConnection(f.ROOT).webAccount,'B');assert.equal(connectionSettings.readConnection(f.ROOT).appName,'Local-MCP-WKR');
 assert.match(f.context.notice,/下次启动账号.*当前连接.*原账号.*正常退出.*重开/);
});
test('next-startup selection still rejects stale settings or changed owner generation',async t=>{
 const f=sharedFixture(t);await assert.rejects(f.run('connection-save',{...f.payload,expected_etag:'stale'}),error=>error.code==='connection_settings_changed'&&error.accepted===false);
 const actual=f.context.connectionSettings;f.context.connectionSettings={...actual,saveConnection:(root,payload,options)=>{
   options.assertIdle();f.context.runtimeGeneration++;return actual.saveConnection(root,payload,options);
 }};
 await assert.rejects(f.run('connection-save',f.payload),error=>error.code==='connection_original_execution_unresolved'&&error.accepted===false);
 assert.equal(connectionSettings.readConnection(f.ROOT).webAccount,'A');
});
test('enabled, route, tunnel and connector-name changes retain the full original execution guards',async t=>{
 const f=sharedFixture(t),original=connectionSettings.readConnection(f.ROOT);
 for(const extra of [{enabled:false},{transport:'dedicated'},{appName:'Other-Connector'},{tunnel:{...f.payload.tunnel,tunnelId:'tunnel_'+'b'.repeat(32)}}]){
   await assert.rejects(f.run('connection-save',{...f.payload,...extra}),error=>error.code==='maintenance_exit_requires_original_receipt'&&error.accepted===false);
   assert.deepEqual(connectionSettings.readConnection(f.ROOT),original);
 }
});
