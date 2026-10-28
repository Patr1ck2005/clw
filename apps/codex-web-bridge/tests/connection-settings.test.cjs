'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const connection=require('../connection-settings.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-connection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const make=(name,body='fixture-only')=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);return file;};
 const key=make('external/key.txt','SECRET-FIXTURE-DO-NOT-READ'),binary=make('external/tunnel.exe');
 make('.local/runtimes/bun-1.4.0/bun.exe');make('apps/codex-web-bridge/upstream/dist/browser-helper.cjs');
 const payload=()=>({expected_etag:connection.readConnection(root).etag,enabled:true,webAccount:'A',transport:'dedicated',tunnel:{tunnelId:'tunnel_'+'a'.repeat(32),runtimeKeyFile:key,binaryPath:binary}});
 return {root,key,binary,make,payload};
}
const idle=()=>{};
test('fresh read stays disabled and creates no configuration or private key output',t=>{
 const f=fixture(t),before=fs.readFileSync(f.key);let keyReads=0,original=fs.readFileSync;
 fs.readFileSync=function(file,...args){if(path.resolve(String(file))===f.key)keyReads++;return original.call(this,file,...args);};
 try{const s=connection.readConnection(f.root);assert.equal(s.etag,'absent');assert.equal(s.enabled,false);assert.equal(s.configured,false);assert.equal(s.modelSends,0);
 assert.equal(fs.existsSync(path.join(f.root,'.local/codex-web-bridge')),false);assert.equal(keyReads,0);assert.ok(!JSON.stringify(s).includes(before.toString()));}finally{fs.readFileSync=original;}
});
test('explicit dedicated save writes only canonical references and does not read key bytes',t=>{
 const f=fixture(t),request=f.payload(),original=fs.readFileSync;let keyReads=0;
 fs.readFileSync=function(file,...args){if(path.resolve(String(file))===f.key)keyReads++;return original.call(this,file,...args);};
 try{const r=connection.saveConnection(f.root,request,{assertIdle:idle});assert.equal(r.state,'connection_settings_saved');assert.equal(r.settings.webAccount,'A');assert.equal(r.settings.enabled,true);
 assert.equal(r.modelSends,0);assert.equal(r.servicesStarted,0);assert.equal(r.tunnelsClaimed,0);assert.equal(r.reopenRequired,true);assert.equal(keyReads,0);
 const selected=JSON.parse(original(path.join(f.root,'.local/codex-web-bridge/settings.json'),'utf8'));assert.equal(selected.tunnel.runtimeKeyFile,f.key);assert.ok(!JSON.stringify(selected).includes('SECRET-FIXTURE'));
 assert.equal(fs.existsSync(path.join(f.root,'config.toml')),false);assert.equal(fs.existsSync(path.join(f.root,'.local/codex-web-bridge/settings.lock')),false);
 }finally{fs.readFileSync=original;}
});
test('stale read and overlapping writer cannot overwrite the current selection',t=>{
 const f=fixture(t),request=f.payload();connection.saveConnection(f.root,request,{assertIdle:idle});
 const file=path.join(f.root,'.local/codex-web-bridge/settings.json'),before=fs.readFileSync(file);
 assert.throws(()=>connection.saveConnection(f.root,request,{assertIdle:idle}),/settings_changed/);assert.deepEqual(fs.readFileSync(file),before);
 fs.writeFileSync(path.join(path.dirname(file),'settings.lock'),'original unresolved writer');
 assert.throws(()=>connection.saveConnection(f.root,f.payload(),{assertIdle:idle}),/settings_busy/);assert.deepEqual(fs.readFileSync(file),before);
});
test('live identity is checked again inside the original writer lock',t=>{
 const f=fixture(t);let calls=0;
 assert.throws(()=>connection.saveConnection(f.root,f.payload(),{assertIdle:()=>{if(++calls===2)throw Error('connection_original_execution_unresolved');}}),/execution_unresolved/);
 assert.equal(calls,2);assert.equal(connection.readConnection(f.root).etag,'absent');assert.equal(fs.existsSync(path.join(f.root,'.local/codex-web-bridge/settings.lock')),false);
});
test('missing files, incomplete runtime and malformed settings cannot enable a connection',t=>{
 const f=fixture(t),request=f.payload();request.tunnel.runtimeKeyFile=path.join(f.root,'missing');
 assert.throws(()=>connection.saveConnection(f.root,request,{assertIdle:idle}),/key_file_missing/);assert.equal(connection.readConnection(f.root).enabled,false);
 fs.unlinkSync(path.join(f.root,'.local/runtimes/bun-1.4.0/bun.exe'));assert.throws(()=>connection.saveConnection(f.root,f.payload(),{assertIdle:idle}),/prerequisites_missing/);
 f.make('.local/codex-web-bridge/settings.json','{malformed');assert.throws(()=>connection.readConnection(f.root),/settings_invalid/);
});
test('shared browser account can switch A/B while the original tunnel and external setup stay fixed',t=>{
 const f=fixture(t),request=f.payload();request.transport='shared-mcp';assert.throws(()=>connection.saveConnection(f.root,request,{assertIdle:idle}),/shared_existing_only/);
 f.make('.local/account-b-tunnel/profiles/webcodex-account-b.yaml','tunnel_id: '+request.tunnel.tunnelId);
 const original={enabled:true,webAccount:'A',transport:'shared-mcp',tunnel:request.tunnel};f.make('.local/codex-web-bridge/settings.json',JSON.stringify(original));
 request.expected_etag=connection.readConnection(f.root).etag;const r=connection.saveConnection(f.root,request,{assertIdle:idle});assert.deepEqual(r.settings.tunnel,original.tunnel);
 const profile=fs.readFileSync(path.join(f.root,'.local/account-b-tunnel/profiles/webcodex-account-b.yaml'));
 const changed={...request,expected_etag:r.settings.etag,webAccount:'B'},switched=connection.saveConnection(f.root,changed,{assertIdle:idle});
 assert.equal(switched.settings.webAccount,'B');assert.equal(switched.reopenRequired,true);assert.equal(switched.servicesStarted,0);assert.equal(switched.modelSends,0);
 assert.deepEqual(switched.settings.tunnel,original.tunnel);assert.deepEqual(fs.readFileSync(path.join(f.root,'.local/account-b-tunnel/profiles/webcodex-account-b.yaml')),profile);
 const returned=connection.saveConnection(f.root,{...request,expected_etag:switched.settings.etag,webAccount:'A'},{assertIdle:idle});assert.equal(returned.settings.webAccount,'A');
 for(const key of ['tunnelId','runtimeKeyFile','binaryPath']){
   const tampered={...changed,expected_etag:returned.settings.etag,tunnel:{...request.tunnel,[key]:key==='tunnelId'?'tunnel_'+'b'.repeat(32):f.make('other/'+key)}};
   assert.throws(()=>connection.saveConnection(f.root,tampered,{assertIdle:idle}),/shared_existing_only/);
 }
 const dedicated={...request,expected_etag:returned.settings.etag,transport:'dedicated'};assert.throws(()=>connection.saveConnection(f.root,dedicated,{assertIdle:idle}),/cannot_reuse_local_mcp/);
});

test('fresh connection reads use this installation default account',t=>{
 const f=fixture(t);f.make('.local/preview-installation.json',JSON.stringify({schema:1,accounts:[{id:'A'}]}));
 assert.equal(connection.readConnection(f.root).webAccount,'A');
 f.make('.local/preview-installation.json',JSON.stringify({schema:1,accounts:[{id:'B'},{id:'A'}]}));
 assert.equal(connection.readConnection(f.root).webAccount,'B');
});

test('a shared connector name changes only when explicitly selected and survives later account switches',t=>{
 const f=fixture(t),request={...f.payload(),transport:'shared-mcp'};
 f.make('.local/account-b-tunnel/profiles/webcodex-account-b.yaml','tunnel_id: '+request.tunnel.tunnelId);
 const original={enabled:true,webAccount:'A',appName:'Local-MCP-WKR',transport:'shared-mcp',tunnel:request.tunnel};
 f.make('.local/codex-web-bridge/settings.json',JSON.stringify(original));
 const before=connection.readConnection(f.root);assert.equal(before.appName,'Local-MCP-WKR');
 const result=connection.saveConnection(f.root,{...request,expected_etag:before.etag,webAccount:'B'},{assertIdle:idle});
 assert.equal(result.settings.appName,'Local-MCP-WKR');assert.equal(result.settings.webAccount,'B');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'.local/codex-web-bridge/settings.json'),'utf8')).appName,'Local-MCP-WKR');
 const profile=fs.readFileSync(path.join(f.root,'.local/account-b-tunnel/profiles/webcodex-account-b.yaml'));
 let checks=0,keyReads=0;const read=fs.readFileSync;
 fs.readFileSync=function(file,...args){if(path.resolve(String(file))===f.key)keyReads++;return read.call(this,file,...args);};
 let renamed;
 try{renamed=connection.saveConnection(f.root,{...request,expected_etag:result.settings.etag,webAccount:'B',appName:'CLW-WKR'},{assertIdle:()=>checks++});}
 finally{fs.readFileSync=read;}
 assert.equal(checks,2);assert.equal(keyReads,0);assert.equal(renamed.settings.appName,'CLW-WKR');assert.equal(renamed.settings.webAccount,'B');
 assert.deepEqual(renamed.settings.tunnel,original.tunnel);assert.equal(renamed.modelSends,0);assert.equal(renamed.servicesStarted,0);assert.equal(renamed.tunnelsClaimed,0);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'.local/account-b-tunnel/profiles/webcodex-account-b.yaml')),profile);
 for(const account of ['A','B']){
   renamed=connection.saveConnection(f.root,{...request,expected_etag:renamed.settings.etag,webAccount:account},{assertIdle:idle});
   assert.equal(renamed.settings.webAccount,account);assert.equal(renamed.settings.appName,'CLW-WKR');assert.deepEqual(renamed.settings.tunnel,original.tunnel);
 }
 const settings=path.join(f.root,'.local/codex-web-bridge/settings.json'),saved=fs.readFileSync(settings);
 for(const appName of ['',null,false,' CLW-WKR','CLW-WKR ','bad\nname','bad\x7fname','x'.repeat(129)]){
   assert.throws(()=>connection.saveConnection(f.root,{...request,expected_etag:renamed.settings.etag,appName},{assertIdle:idle}),/app_name_invalid/);
   assert.deepEqual(fs.readFileSync(settings),saved);
 }
 for(const key of ['tunnelId','runtimeKeyFile','binaryPath']){
   const tunnel={...request.tunnel,[key]:key==='tunnelId'?'tunnel_'+'b'.repeat(32):f.make('other/'+key)};
   assert.throws(()=>connection.saveConnection(f.root,{...request,expected_etag:renamed.settings.etag,appName:'CLW-WKR-new',tunnel},{assertIdle:idle}),/shared_existing_only/);
   assert.deepEqual(fs.readFileSync(settings),saved);
 }
 assert.throws(()=>connection.saveConnection(f.root,{...request,expected_etag:result.settings.etag,appName:'CLW-WKR-new'},{assertIdle:idle}),/settings_changed/);
 assert.throws(()=>connection.saveConnection(f.root,{...request,expected_etag:renamed.settings.etag,appName:'CLW-WKR-new'},{assertIdle:()=>{throw Error('connection_original_execution_unresolved');}}),/execution_unresolved/);
 let raced=0;
 assert.throws(()=>connection.saveConnection(f.root,{...request,expected_etag:renamed.settings.etag,appName:'CLW-WKR-new'},{assertIdle:()=>{if(++raced===2)throw Error('connection_original_execution_unresolved');}}),/execution_unresolved/);
 assert.equal(raced,2);assert.deepEqual(fs.readFileSync(settings),saved);
});

test('shared connector rename still validates existing profile and files, including when disabling',t=>{
 const f=fixture(t),request={...f.payload(),transport:'shared-mcp'};
 f.make('.local/codex-web-bridge/settings.json',JSON.stringify({...request,appName:'Local-MCP-WKR'}));
 let current=connection.readConnection(f.root);
 const rename=()=>({...request,expected_etag:current.etag,appName:'CLW-WKR'});
 assert.throws(()=>connection.saveConnection(f.root,rename(),{assertIdle:idle}),/shared_tunnel_identity_changed/);
 f.make('.local/account-b-tunnel/profiles/webcodex-account-b.yaml','tunnel_id: '+request.tunnel.tunnelId);
 const disabled=connection.saveConnection(f.root,{...rename(),enabled:false},{assertIdle:idle});
 assert.equal(disabled.settings.appName,'CLW-WKR');assert.equal(disabled.settings.enabled,false);
 current=disabled.settings;fs.unlinkSync(f.key);
 assert.throws(()=>connection.saveConnection(f.root,{...rename(),enabled:false,appName:'CLW-WKR-new'},{assertIdle:idle}),/key_file_missing/);
 const unchanged=connection.saveConnection(f.root,{...request,expected_etag:current.etag,enabled:false},{assertIdle:idle});
 assert.equal(unchanged.settings.appName,'CLW-WKR');assert.equal(unchanged.settings.enabled,false);
});
test('inflight, unknown, unverified and pending packages reject an account or route change',()=>{
 const safe={restored:true,records:[{paused:true,latest_request:{phase:'completed'}}],nativeVerified:true,nativeTurns:[]};connection.assertConnectionIdle(safe);
 for(const change of [{restored:false},{busy:true},{pendingStarts:['original-key']},{nativeVerified:false},{records:[{paused:false}]},{records:[{paused:true,latest_request:{phase:'suspended'}}]},{nativeTurns:[{status:'needs_reconciliation'}]}])assert.throws(()=>connection.assertConnectionIdle({...safe,...change}),/execution_unresolved/);
});
test('account A existing Local-MCP identity cannot be saved as a dedicated poller',t=>{
 const f=fixture(t),request=f.payload(),profile=f.make('.local/account-a-tunnel/profile.yaml','tunnel_id: '+request.tunnel.tunnelId);
 const original=fs.readFileSync(profile);assert.throws(()=>connection.saveConnection(f.root,request,{assertIdle:idle}),/cannot_reuse_local_mcp/);
 assert.deepEqual(fs.readFileSync(profile),original);assert.equal(connection.readConnection(f.root).etag,'absent');
});
test('CLI refuses a live owner or durable execution ledger instead of guessing from display caches',t=>{
 const f=fixture(t);connection.cliIdle(f.root);f.make('.local/web-host/health.json',JSON.stringify({pid:process.pid}));assert.throws(()=>connection.cliIdle(f.root),/close_workspace_first/);
 fs.unlinkSync(path.join(f.root,'.local/web-host/health.json'));f.make('.local/harness/harness.sqlite3');assert.throws(()=>connection.cliIdle(f.root),/workspace_execution_checks/);
});
test('write failure preserves the original configuration and releases its writer lock',t=>{
 const f=fixture(t);connection.saveConnection(f.root,f.payload(),{assertIdle:idle});const before=connection.readConnection(f.root);
 assert.throws(()=>connection.saveConnection(f.root,{...f.payload(),webAccount:'B'},{assertIdle:idle,write:()=>{throw Error('fixture-file-locked');}}),/file-locked/);
 assert.deepEqual(connection.readConnection(f.root),before);
});
test('an unchanged broken connection can be explicitly disabled without granting a new identity',t=>{
 const f=fixture(t);connection.saveConnection(f.root,f.payload(),{assertIdle:idle});const input={...f.payload(),enabled:false};fs.unlinkSync(f.key);
 const r=connection.saveConnection(f.root,input,{assertIdle:idle});assert.equal(r.settings.enabled,false);assert.equal(r.settings.webAccount,'A');assert.equal(r.servicesStarted,0);
 assert.throws(()=>connection.saveConnection(f.root,{...input,expected_etag:r.settings.etag,webAccount:'B'},{assertIdle:idle}),/key_file_missing/);
 assert.throws(()=>connection.saveConnection(f.root,{...input,expected_etag:r.settings.etag,enabled:true},{assertIdle:idle}),/key_file_missing/);
});
