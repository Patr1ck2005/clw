'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {authorizationPath,readUserAuthorization,isolatedEnvironment,runtimeConfig}=require('../bridge-config.cjs');
const policy=text=>({version:1,enabled:true,text,recover_ended_turns:true,auto_approve_returned_files:true});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-consent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,write(relative,value){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));return file;}};}
test('fresh CLW confirms tools and files by default without enabling recovery or creating a policy file',t=>{
 const f=fixture(t),file=path.join(f.root,'.local/web-user-authorization.json');assert.equal(authorizationPath(f.root),file);
 assert.equal(isolatedEnvironment(f.root,{}).CLW_WEB_AUTHORIZATION_FILE,file);
 const value=readUserAuthorization(f.root);assert.equal(value.enabled,true);assert.equal(value.auto_approve_tools,true);assert.equal(value.auto_approve_returned_files,true);
 assert.equal(value.recover_ended_turns,false);assert.ok(value.text.length>0&&value.text.length<100);assert.deepEqual(fs.readdirSync(f.root),[]);
 value.auto_approve_tools=false;assert.equal(readUserAuthorization(f.root).auto_approve_tools,true);
});
test('legacy development policy is retained until explicit private data policy replaces it',t=>{
 const f=fixture(t),legacy=f.write('config/web-user-authorization.json',policy('Legacy'));
 assert.equal(authorizationPath(f.root),legacy);assert.equal(readUserAuthorization(f.root).text,'Legacy');
 const current=f.write('.local/web-user-authorization.json',{version:1,enabled:false});
 assert.equal(authorizationPath(f.root),current);assert.equal(isolatedEnvironment(f.root,{}).CLW_WEB_AUTHORIZATION_FILE,current);
 assert.equal(readUserAuthorization(f.root).enabled,false);
});
test('missing optional confirmation flags default on while explicit false and original text remain unchanged',t=>{
 const f=fixture(t),file=f.write('config/web-user-authorization.json',{...policy('Original'),auto_approve_tools:false});
 const before=fs.readFileSync(file);let value=readUserAuthorization(f.root);
 assert.equal(value.auto_approve_tools,false);assert.equal(value.auto_approve_returned_files,true);assert.equal(value.text,'Original');assert.equal(value.recover_ended_turns,true);
 assert.deepEqual(fs.readFileSync(file),before);
 f.write('.local/web-user-authorization.json',{version:1,enabled:true,text:'Short original'});value=readUserAuthorization(f.root);
 assert.equal(value.auto_approve_tools,true);assert.equal(value.auto_approve_returned_files,true);assert.equal(value.recover_ended_turns,false);
});
test('malformed or unreadable private data policy never falls back to enabled legacy consent',t=>{
 const f=fixture(t);f.write('config/web-user-authorization.json',policy('Legacy'));const file=f.write('.local/web-user-authorization.json',[]);
 assert.throws(()=>readUserAuthorization(f.root),/web_user_authorization_invalid/);fs.writeFileSync(file,'{malformed');assert.throws(()=>readUserAuthorization(f.root));
 const original=fs.readFileSync;fs.readFileSync=function(name,...args){if(name===file)throw Object.assign(Error('denied'),{code:'EACCES'});return original.call(this,name,...args);};
 try{assert.throws(()=>readUserAuthorization(f.root),/denied/);}finally{fs.readFileSync=original;}
});
test('a present private policy with a missing read target is not replaced by the default',t=>{
 const f=fixture(t),file=f.write('.local/web-user-authorization.json',policy('Original')),original=fs.readFileSync;
 fs.readFileSync=function(name,...args){if(name===file)throw Object.assign(Error('target missing'),{code:'ENOENT'});return original.call(this,name,...args);};
 try{assert.throws(()=>readUserAuthorization(f.root),/target missing/);}finally{fs.readFileSync=original;}
});
test('native A/B runtimes use the same tool-confirmation default and preserve explicit opt-outs',t=>{
 const f=fixture(t),binary=f.write('tunnel.exe',{}),key=f.write('runtime-key',{}),tunnel={binaryPath:binary,runtimeKeyFile:key,tunnelId:'tunnel_'+'c'.repeat(32)};
 for(const account of ['A','B'])assert.equal(runtimeConfig(f.root,{tunnel,webAccount:account},18000).autoApproveToolCalls,true);
 f.write('.local/web-user-authorization.json',{...policy('Original'),auto_approve_tools:false});
 for(const account of ['A','B'])assert.equal(runtimeConfig(f.root,{tunnel,webAccount:account},18000).autoApproveToolCalls,false);
 f.write('.local/web-user-authorization.json',{version:1,enabled:false});
 assert.equal(runtimeConfig(f.root,{tunnel,webAccount:'A'},18000).autoApproveToolCalls,false);
});
test('private extra-grant fields must be real booleans and enabled policy must contain bounded text',t=>{
 const f=fixture(t);
 for(const p of [policy('') ,policy('x'.repeat(4097)),policy('Consent')&&{...policy('Consent'),recover_ended_turns:'true'}, {...policy('Consent'),auto_approve_returned_files:1}]){
  f.write('.local/web-user-authorization.json',p);assert.throws(()=>readUserAuthorization(f.root),/web_user_authorization_invalid/);
 }
});
