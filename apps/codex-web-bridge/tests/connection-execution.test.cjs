'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const guard=require('../connection-execution.cjs'),settings=require('../connection-settings.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-execution-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'scripts'));fs.copyFileSync(path.join(__dirname,'../../../scripts/connection_execution_guard.py'),path.join(root,'scripts/connection_execution_guard.py'));
 return root;
}
function createLedger(root,extra=''){
 const testFile=fs.readFileSync(path.join(__dirname,'../../../tests/test_connection_execution_guard.py'),'utf8'),schema=testFile.match(/SCHEMA='''([\s\S]*?)'''/)[1];
 const file=path.join(root,'.local/harness/harness.sqlite3');fs.mkdirSync(path.dirname(file),{recursive:true});
 execFileSync('python',['-X','utf8','-B','-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()',file,schema+extra],{windowsHide:true});return file;
}
test('real private Python reader accepts fresh missing or matching fully settled ledger without changing bytes',async t=>{
 const root=fixture(t),fresh=await guard.readExecution(root);assert.equal(fresh.database,'absent');guard.assertCurrent(root,fresh);
 const file=createLedger(root),before=fs.readFileSync(file),proof=await guard.readExecution(root,{expectedStore:'fixture-store'});
 assert.equal(proof.storeVerified,true);guard.assertCurrent(root,proof);assert.deepEqual(fs.readFileSync(file),before);
});
test('actual terminal-pending claim and foreign store cannot masquerade as an idle completed session',async t=>{
 const root=fixture(t);createLedger(root,"INSERT INTO native_work_claims VALUES('original','terminal_pending');");
 await assert.rejects(guard.readExecution(root,{expectedStore:'fixture-store'}),/original_execution_unresolved/);
 await assert.rejects(guard.readExecution(root,{expectedStore:'other-store'}),/store_changed/);
 await assert.rejects(guard.readExecution(root),/store_unverified/);
});
test('a changed SQLite/WAL identity while awaiting readback invalidates that exact proof',async t=>{
 const root=fixture(t);createLedger(root);
 const run=(_python,_args,_options,callback)=>{fs.writeFileSync(path.join(root,'.local/harness/harness.sqlite3-wal'),'new original write');callback(null,JSON.stringify({ok:true,result:{version:1,source:'canonical_harness_readonly',idle:true}}));};
 await assert.rejects(guard.readExecution(root,{expectedStore:'fixture-store',run}),/store_changed/);
});
test('atomic settings writer rechecks the original ledger immediately before writing',async t=>{
 const root=fixture(t),file=createLedger(root),proof=await guard.readExecution(root,{expectedStore:'fixture-store'});
 const make=name=>{const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'fixture-only');return target;};
 const key=make('key.txt'),binary=make('tunnel.exe');make('.local/runtimes/bun-1.4.0/bun.exe');make('apps/codex-web-bridge/upstream/dist/browser-helper.cjs');
 const input={expected_etag:'absent',enabled:true,webAccount:'A',transport:'dedicated',tunnel:{tunnelId:'tunnel_'+'a'.repeat(32),runtimeKeyFile:key,binaryPath:binary}};let checks=0;
 assert.throws(()=>settings.saveConnection(root,input,{assertIdle(){if(++checks===2)fs.appendFileSync(file,'another original operation');guard.assertCurrent(root,proof);}}),/store_changed/);
 assert.equal(checks,2);assert.equal(settings.readConnection(root).enabled,false);assert.equal(fs.existsSync(path.join(root,'.local/codex-web-bridge/settings.lock')),false);
});
