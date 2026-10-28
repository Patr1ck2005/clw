'use strict';
const fs=require('node:fs'),path=require('node:path');
const {uuid}=require('./turn-source.cjs');
// Old native receipts belong to B. Active-route selection never migrates them.
function bindThreadAccount(home,threadId,account){
  if(!uuid(threadId)||!['A','B'].includes(account))throw Error('bridge_account_binding_invalid');
  const folder=path.join(home,'thread-accounts'),file=path.join(folder,threadId+'.json');
  const verify=()=>{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.threadId!==threadId||old.account!==account)throw Error('bridge_thread_account_mismatch');};
  if(fs.existsSync(file)){verify();return;}
  const sources=path.join(home,'turn-sources');
  if(fs.existsSync(sources))for(const name of fs.readdirSync(sources).filter(n=>/^[a-f0-9]{12}\.json$/.test(n))){
    const source=path.join(sources,name);if(fs.statSync(source).size>16384)throw Error('bridge_account_history_unreadable');
    const old=JSON.parse(fs.readFileSync(source,'utf8'));
    if(old.threadId===threadId&&(old.account||'B')!==account)throw Error('bridge_thread_account_mismatch');
  }
  fs.mkdirSync(folder,{recursive:true});
  try{fs.writeFileSync(file,JSON.stringify({threadId,account})+'\n',{flag:'wx',mode:0o600});}
  catch(e){if(e.code!=='EEXIST')throw e;verify();}
}
module.exports={bindThreadAccount};
