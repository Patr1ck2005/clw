'use strict';
// A small IPC adapter to the existing local installation controller. Credentials
// travel only on the child's stdin; neither argv nor public state contains them.
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const ACTIONS=new Set(['read','save','bootstrap','connect','check','export']);
const MAX_RESULT=1024*1024;
function createPreviewSetup(root,{python=process.env.CLW_PYTHON||'python',spawnProcess=spawn,onChange=()=>{}}={}){
  let current=null,pending=null,lastError=null,completionUnknown=null;
  const snapshot=()=>({available:fs.existsSync(path.join(root,'.local','preview-installation.json')),
    busy:pending?.action||null,completionUnknown:completionUnknown?.action||null,configuration:current,lastError});
  const changed=()=>onChange(snapshot());
  function call(action,payload={}){
    if(!ACTIONS.has(action))return Promise.reject(Error('preview_action_invalid'));
    if(completionUnknown&&!['read','check','export'].includes(action))return Promise.reject(Error('preview_previous_operation_unknown'));
    if(pending){
      if(action==='read'||action==='check')return Promise.resolve({...current,status:{...current?.status,state:'working',stage:pending.action}});
      return Promise.reject(Error('preview_operation_in_progress'));
    }
    const serialized=JSON.stringify(payload);
    if(Buffer.byteLength(serialized)>128*1024)return Promise.reject(Error('preview_request_too_large'));
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const operation={action,promise};pending=operation;lastError=null;changed();
    let child,output='',bytes=0,overflow=false,settled=false;
    const finish=(error,result)=>{
      if(settled)return;settled=true;
      if(pending===operation)pending=null;
      if(error){lastError=error.message;
        if(!['read','check','export'].includes(action)&&(['preview_controller_result_unknown','preview_controller_result_too_large'].includes(error.message)||/^preview_(?:launch|native|enrollment)_completion_unknown$/.test(error.message)))completionUnknown={action};
        reject(error);
      }else{
        if(action==='check'&&result?.operation_reconciled===true)completionUnknown=null;
        if(result&&typeof result.configured==='boolean')current=result;
        else if(current&&result?.state)current={...current,status:result};
        resolve(result);
      }
      changed();
    };
    try{
      child=spawnProcess(python,['-X','utf8','-B',path.join(root,'scripts','preview_connections.py'),'--root',root,'--action',action],
        {cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:process.env});
      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>MAX_RESULT){overflow=true;return;}output+=chunk.toString('utf8');});
      // The controller returns fixed errors in JSON. Raw native diagnostics can
      // contain private paths, so stderr is drained without exposing its text.
      child.stderr.on('data',()=>{});
      child.on('error',()=>finish(Error('preview_controller_unavailable')));
      child.on('close',code=>{
        if(overflow)return finish(Error('preview_controller_result_too_large'));
        let envelope;try{envelope=JSON.parse(output.trim());}catch{return finish(Error('preview_controller_result_unknown'));}
        if(code!==0||envelope?.ok!==true)return finish(Error(typeof envelope?.code==='string'&&/^[a-z0-9_:.\-]{1,140}$/i.test(envelope.code)?envelope.code:'preview_controller_failed'));
        finish(null,envelope.result);
      });
      child.stdin.on('error',()=>{});child.stdin.end(serialized);
    }catch{finish(Error('preview_controller_unavailable'));}
    return promise;
  }
  return {call,snapshot};
}
module.exports={createPreviewSetup,ACTIONS};
