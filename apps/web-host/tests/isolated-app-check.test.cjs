'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {prepareIsolatedCheck,FLAG}=require('../isolated-app-check.cjs');
function fixture(t){
  const top=fs.mkdtempSync(path.join(os.tmpdir(),'clw-isolated-check-')),build='20261006T000000Z-aaaaaaaaaaaa-bbbbbbbb',
    code=path.join(top,'versions',build),data=path.join(top,'data');
  t.after(()=>{assert.equal(path.dirname(top),fs.realpathSync(os.tmpdir()));fs.rmSync(top,{recursive:true,force:true});});
  fs.mkdirSync(path.join(code,'apps/web-host'),{recursive:true});fs.mkdirSync(data);fs.symlinkSync(data,path.join(code,'.local'),'junction');
  const files={};for(const name of ['main.cjs','isolated-app-check.cjs']){
    const source=Buffer.from(name);fs.writeFileSync(path.join(code,'apps/web-host',name),source);
    files['apps/web-host/'+name]={bytes:source.length,sha256:crypto.createHash('sha256').update(source).digest('hex')};
  }
  const manifest={schema:1,product:'clw-web-workspace',build_id:build,files},manifestFile=path.join(code,'_clw_web_release.json');
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));const hash=crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex');
  fs.writeFileSync(path.join(top,'installation.json'),JSON.stringify({schema:1,product:'clw-web-workspace',root:top,installation_id:'a'.repeat(32)}));
  fs.writeFileSync(path.join(top,'active.json'),JSON.stringify({build_id:build,installation_id:'a'.repeat(32),manifest_sha256:hash}));
  return {top,code,data,manifestFile};
}
function addManifestFile(f,name,source){
  const file=path.join(f.code,...name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);
  const manifest=JSON.parse(fs.readFileSync(f.manifestFile,'utf8'));
  manifest.files[name]={bytes:source.length,sha256:crypto.createHash('sha256').update(source).digest('hex')};
  fs.writeFileSync(f.manifestFile,JSON.stringify(manifest));
  const activeFile=path.join(f.top,'active.json'),active=JSON.parse(fs.readFileSync(activeFile,'utf8'));
  active.manifest_sha256=crypto.createHash('sha256').update(fs.readFileSync(f.manifestFile)).digest('hex');fs.writeFileSync(activeFile,JSON.stringify(active));
}
function electronProbe(t,f){
  const executable=require('electron'),probe=fs.mkdtempSync(path.join(os.tmpdir(),'clw-isolated-electron-meta-')),
    script=path.join(probe,'probe.cjs'),moduleFile=path.resolve(__dirname,'../isolated-app-check.cjs');
  t.after(()=>{assert.equal(path.dirname(probe),fs.realpathSync(os.tmpdir()));fs.rmSync(probe,{recursive:true,force:true});});
  fs.writeFileSync(script,`'use strict';
const virtual=require('node:fs'),physical=require('original-fs'),path=require('node:path'),crypto=require('node:crypto'),{app}=require('electron');
const code=${JSON.stringify(f.code)},data=${JSON.stringify(f.data)},archive=path.join(code,'apps/web-host/release.asar');
const virtualStat=virtual.statSync(archive),physicalStat=physical.statSync(archive);
let accepted=false,error=null;
try{accepted=require(${JSON.stringify(moduleFile)}).prepareIsolatedCheck(code,[${JSON.stringify(FLAG)}]);}catch(e){error=e.message;}
const result={electron:process.versions.electron,virtual:{bytes:virtualStat.size,isFile:virtualStat.isFile(),isDirectory:virtualStat.isDirectory()},physical:{bytes:physicalStat.size,isFile:physicalStat.isFile(),isDirectory:physicalStat.isDirectory(),sha256:crypto.createHash('sha256').update(physical.readFileSync(archive)).digest('hex')},accepted,error,receiptExists:physical.existsSync(path.join(data,'.isolated-app-check.json')),noWindow:true,noClwMainLoaded:true};
process.stdout.write(JSON.stringify(result),()=>app.exit(0));`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const reply=spawnSync(executable,[script],{encoding:'utf8',env,windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  assert.ifError(reply.error);assert.equal(reply.status,0,reply.stderr);return JSON.parse(reply.stdout);
}
test('ordinary startup stays on its normal route and never needs a release manifest',()=>{
  assert.equal(prepareIsolatedCheck('unused',['electron']),false);
  assert.throws(()=>prepareIsolatedCheck('unused',[FLAG+'=true']),/flag_invalid/);
});
test('only a fresh verified fixed installation gets one explicit isolated check',t=>{
  const f=fixture(t);assert.equal(prepareIsolatedCheck(f.code,[FLAG]),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data,'.isolated-app-check.json'),'utf8')).host_port,0);
  assert.throws(()=>prepareIsolatedCheck(f.code,[FLAG]),/fresh_empty_data/);
});
for(const name of ['web-host','harness','control-center','codex-web-bridge','web-user-authorization.json'])
  test('existing '+name+' cannot be adopted as empty isolated application data',t=>{
    const f=fixture(t);fs.writeFileSync(path.join(f.data,name),'original data');
    assert.throws(()=>prepareIsolatedCheck(f.code,[FLAG]),/fresh_empty_data/);
    assert.equal(fs.existsSync(path.join(f.data,'.isolated-app-check.json')),false);
  });
test('changed manifest or frozen source cannot start an isolated app',t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.code,'apps/web-host/main.cjs'),'changed');
  assert.throws(()=>prepareIsolatedCheck(f.code,[FLAG]),/source_not_frozen/);
  fs.appendFileSync(f.manifestFile,' ');
  assert.throws(()=>prepareIsolatedCheck(f.code,[FLAG]),/manifest_changed/);
});

function freshPreview(f){
  const native={cli:'runtime/native/webcodex.exe',server:'runtime/native/webcodex-server.exe',runner:'runtime/native/webcodex-runner.exe',tunnel:'runtime/native/tunnel-client.exe'};
  const release=JSON.parse(fs.readFileSync(f.manifestFile,'utf8'));release.runtime_contract={native};
  fs.writeFileSync(f.manifestFile,JSON.stringify(release));
  const activeFile=path.join(f.top,'active.json'),active=JSON.parse(fs.readFileSync(activeFile,'utf8'));
  active.manifest_sha256=crypto.createHash('sha256').update(fs.readFileSync(f.manifestFile)).digest('hex');fs.writeFileSync(activeFile,JSON.stringify(active));
  const settings={schema:1,installation_id:'11111111-1111-4111-8111-111111111111',backend:{mode:'owned',origin:'http://127.0.0.1:40000'},network:{mode:'system'},accounts:[{id:'A'}],projectRoots:[],auto_connect:true,binaries:Object.fromEntries(Object.entries(native).map(([key,name])=>[key,path.join(f.code,...name.split('/'))]))};
  fs.mkdirSync(path.join(f.data,'preview-private'));fs.writeFileSync(path.join(f.data,'preview-installation.lock'),'0');
  fs.writeFileSync(path.join(f.data,'preview-installation.json'),JSON.stringify(settings));return settings;
}

test('fresh installed preview metadata can be checked without importing an existing account',t=>{
  const f=fixture(t);freshPreview(f);assert.equal(prepareIsolatedCheck(f.code,[FLAG]),true);
});

for(const change of ['credentials','roots','backend'])test('isolated preview refuses existing '+change,t=>{
  const f=fixture(t),settings=freshPreview(f);
  if(change==='credentials')fs.writeFileSync(path.join(f.data,'preview-private/account-A.bin'),'existing credential');
  if(change==='roots')settings.projectRoots=[f.top];
  if(change==='backend')settings.backend.mode='external';
  fs.writeFileSync(path.join(f.data,'preview-installation.json'),JSON.stringify(settings));
  assert.throws(()=>prepareIsolatedCheck(f.code,[FLAG]),/fresh_empty_data/);
});
test('a same-size source change still fails the complete byte hash check',t=>{
  const f=fixture(t),file=path.join(f.code,'apps/web-host/main.cjs'),source=fs.readFileSync(file);
  source[0]^=1;fs.writeFileSync(file,source);
  assert.throws(()=>prepareIsolatedCheck(f.code,[FLAG]),/source_not_frozen/);
  assert.equal(fs.existsSync(path.join(f.data,'.isolated-app-check.json')),false);
});
test('a source directory reparse cannot substitute matching frozen bytes',t=>{
  const f=fixture(t),original=path.join(f.code,'apps/web-host'),target=path.join(f.top,'reparsed-source');
  fs.renameSync(original,target);fs.symlinkSync(target,original,'junction');
  assert.throws(()=>prepareIsolatedCheck(f.code,[FLAG]),/source_not_frozen/);
  assert.equal(fs.existsSync(path.join(f.data,'.isolated-app-check.json')),false);
});
test('a directory cannot substitute a zero-byte physical release file',t=>{
  const f=fixture(t),name='apps/web-host/empty.cjs';addManifestFile(f,name,Buffer.alloc(0));
  fs.unlinkSync(path.join(f.code,...name.split('/')));fs.mkdirSync(path.join(f.code,...name.split('/')));
  assert.throws(()=>prepareIsolatedCheck(f.code,[FLAG]),/source_not_frozen/);
  assert.equal(fs.existsSync(path.join(f.data,'.isolated-app-check.json')),false);
});
test('real Electron verifies physical ASAR bytes while its ordinary fs presents a directory',t=>{
  const f=fixture(t),archive=fs.readFileSync(path.join(path.dirname(require('electron')),'resources/default_app.asar'));
  addManifestFile(f,'apps/web-host/release.asar',archive);const result=electronProbe(t,f);
  assert.ok(result.electron);assert.equal(result.virtual.isFile,false);assert.equal(result.virtual.isDirectory,true);assert.equal(result.virtual.bytes,0);
  assert.equal(result.physical.isFile,true);assert.equal(result.physical.isDirectory,false);assert.equal(result.physical.bytes,archive.length);
  assert.equal(result.physical.sha256,crypto.createHash('sha256').update(archive).digest('hex'));
  assert.equal(result.accepted,true);assert.equal(result.error,null);assert.equal(result.receiptExists,true);
});
test('real Electron rejects a same-size changed ASAR instead of bypassing its manifest hash',t=>{
  const f=fixture(t),archive=fs.readFileSync(path.join(path.dirname(require('electron')),'resources/default_app.asar'));
  addManifestFile(f,'apps/web-host/release.asar',archive);const file=path.join(f.code,'apps/web-host/release.asar');
  const changed=Buffer.from(archive);changed[changed.length-1]^=1;fs.writeFileSync(file,changed);
  const result=electronProbe(t,f);
  assert.equal(result.physical.bytes,archive.length);assert.notEqual(result.physical.sha256,crypto.createHash('sha256').update(archive).digest('hex'));
  assert.equal(result.accepted,false);assert.equal(result.error,'isolated_app_check_source_not_frozen');assert.equal(result.receiptExists,false);
});
