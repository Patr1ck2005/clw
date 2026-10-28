'use strict';
// Isolated stdio fixture: no network, browser, model or production workspace.
const fs=require('node:fs'),path=require('node:path'),{createInterface}=require('node:readline');
const folder=process.argv[2],file=path.join(folder,'fixture-original-receipt.json');let reads=0;
const output=value=>process.stdout.write('CLW_MANAGED '+JSON.stringify(value)+'\n');
const original={page_id:'fixture-paused-page',account:'A',url:'https://chatgpt.com/c/fixture-original',phase:'bound',paused:true,
  latest_request:{id:'fixture-original-request',phase:'processing',attempt_id:'fixture-original-attempt'}};
createInterface({input:process.stdin}).on('line',line=>{
  const {id,op,payload}=JSON.parse(line);
  if(op==='shutdown')return process.exit(0);
  if(op==='start'){
    if(fs.existsSync(file))throw Error('fixture_duplicate_effect');
    fs.writeFileSync(file,JSON.stringify({operation_id:payload.operation_id,objective:payload.objective,effects:1}),{flag:'wx'});
    return process.exit(2);
  }
  if(op==='receipt'){
    const saved=JSON.parse(fs.readFileSync(file));if(payload.operation_id!==saved.operation_id)throw Error('fixture_foreign_operation');
    return output({id,ok:true,result:{state:'completed',result:{state:'queued_for_web_host',request_id:saved.operation_id}}});
  }
  if(op==='fixture-crash')return process.exit(2);
  if(op==='list'){reads++;return output({id,ok:true,result:{pages:[original],fixture_reads:reads}});}
  if(op==='pending-receipt')return output({id,ok:true,result:{state:'idle'}});
  output({id,ok:false,code:'fixture_operation_not_supported'});
}).on('close',()=>process.exit(0));
setTimeout(()=>process.stdout.write('CLW_MANAGED_READY '+JSON.stringify({protocol:'clw.managed-browser.v1',store_id:'isolated-longevity-ledger'})+'\n'),Number(process.env.CLW_FIXTURE_READY_DELAY_MS||0));
