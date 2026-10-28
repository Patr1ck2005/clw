'use strict';
// Transport fault fixture, never a production service or a model endpoint.
const fs=require('node:fs'),path=require('node:path');
const {createInterface}=require('node:readline');
const {writePrivateFileAtomic}=require('../../../codex-web-bridge/upstream/launcher/electron/atomic-file.cjs');
const folder=process.argv[2],file=path.join(folder,'receipt.json');
const output=value=>process.stdout.write('CLW_MANAGED '+JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const {id,op,payload}=JSON.parse(line);
 if(op==='shutdown')return process.exit(0);
 if(op==='start'){
  if(fs.existsSync(file))throw Error('duplicate side effect');
  writePrivateFileAtomic(file,JSON.stringify({operation_id:payload.operation_id,objective:payload.objective,effects:1}),{flush:true});
  // The action committed but the response was lost with the original process.
  return process.exit(2);
 }
 if(op==='receipt'){
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  if(saved.operation_id!==payload.operation_id)throw Error('foreign receipt');
  output({id,ok:true,result:{state:'completed',result:{state:'queued_for_web_host',request_id:saved.operation_id}}});
 }
}).on('close',()=>process.exit(0));
process.stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'isolated-ledger'})+'\n');
