'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
function fingerprint(root){
  const home=path.join(root,'.local','harness');
  const identities=['harness.sqlite3','harness.sqlite3-wal'].map(name=>{
    try{const s=fs.statSync(path.join(home,name),{bigint:true});if(!s.isFile())throw Error('connection_execution_ledger_unavailable');return [name,...['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k]))];}
    catch(error){if(error.code==='ENOENT')return [name,'absent'];throw error;}
  });
  return crypto.createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}
function assertCurrent(root,proof){
  if(proof?.version!==1||proof.source!=='canonical_harness_readonly'||proof.idle!==true||proof.fingerprint!==fingerprint(root))throw Error('connection_execution_store_changed');
}
async function readExecution(root,{expectedStore,python=process.env.CLW_PYTHON||'python',run=execFile}={}){
  const before=fingerprint(root),args=['-X','utf8','-B',path.join(root,'scripts','connection_execution_guard.py'),'--root',root,...(expectedStore?['--expected-store',expectedStore]:[])];
  const response=await new Promise((resolve,reject)=>run(python,args,{cwd:root,windowsHide:true,timeout:6000,maxBuffer:16384,encoding:'utf8'},(error,stdout)=>{
    let value;try{value=JSON.parse(stdout);}catch{return reject(Error('connection_execution_ledger_unavailable'));}
    if(!value.ok)return reject(Error(/^connection_[a-z_]+$/.test(value.code||'')?value.code:'connection_execution_ledger_unavailable'));
    if(error)return reject(Error('connection_execution_ledger_unavailable'));resolve(value.result);
  }));
  const proof={...response,fingerprint:before};assertCurrent(root,proof);return proof;
}
module.exports={readExecution,assertCurrent,fingerprint};
