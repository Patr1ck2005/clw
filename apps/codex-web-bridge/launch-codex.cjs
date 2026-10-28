'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {WEB_MODELS}=require('./bridge-config.cjs');
const {uuid}=require('./turn-source.cjs');
function launchArguments(root,{model,workingDirectory,resume=false,account}){
  if(!WEB_MODELS.has('chatgpt-web/'+model))throw Error('请选择网页模型。');
  if(!path.isAbsolute(workingDirectory||'')||!fs.statSync(workingDirectory,{throwIfNoEntry:false})?.isDirectory())throw Error('请选择存在的工作目录。');
  if(typeof resume!=='boolean'&&!uuid(resume))throw Error('无效的接续选项。');
  if(account!==undefined&&!['A','B'].includes(account))throw Error('网页账号尚未核对。');
  return ['-NoProfile','-NoExit','-File',path.join(root,'scripts','start_codex_web.ps1'),'-Model',model,'-WorkingDirectory',workingDirectory,
    ...(account?['-Account',account]:[]),...(resume?['-Resume',resume===true?'pick':resume]:[])];
}
function resumeTurnPayload(bridge,traceId){
  let rows;
  try{rows=bridge?.turns?.();}catch{throw Error('原始工作记录暂不可用，请先核对原执行。');}
  if(!Array.isArray(rows)||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))
    throw Error('原始工作记录暂不可用，请先核对原执行。');
  const row=rows.find(r=>r?.traceId===traceId),s=row?.source;
  if(!s||!uuid(s.threadId)||!uuid(s.turnId)||!WEB_MODELS.has(s.model)||!s.workingDirectory)throw Error('来源任务未核对，请使用“接续已有任务”选择原 Codex 任务。');
  if((s.account||'B')!==(bridge.snapshot().account||'B'))throw Error('原任务属于账号 '+(s.account||'B')+'；当前网页账号不同，不能直接接续。');
  const terminal=status=>['completed','aborted','failed'].includes(status);
  const proofTerminal={completed:'task_complete_with_matching_final',failed:'task_complete_with_error',aborted:'turn_aborted'};
  const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
  const nativeTerminal=row=>{
    const native=row.nativeState,proof=native?.nativeProof,source=row.source;
    return terminal(native?.state)&&native.threadId===source?.threadId&&native.turnId===source?.turnId&&
      native.source==='native_session_canonical'&&native.threadActive===false&&native.activeTurnId===null&&
      Number.isFinite(Date.parse(native.endedAt))&&proof?.version===1&&proof.kind==='canonical_full_session'&&
      proof.threadId===source.threadId&&proof.turnId===source.turnId&&proof.terminal===proofTerminal[native.state]&&
      sha(proof.sessionSha256)&&sha(proof.eventSha256);
  };
  if(!terminal(row.status)||!terminal(row.browserStatus)||!nativeTerminal(row))throw Error('原回合仍在运行或待核对，不能另开接续。');
  if(rows.some(r=>r.source?.threadId===s.threadId&&(!terminal(r.status)||!terminal(r.browserStatus)||!nativeTerminal(r))))throw Error('同一 Codex 任务还有运行中或待核对的回合，请先核对原执行。');
  return {model:s.model.slice('chatgpt-web/'.length),workingDirectory:s.workingDirectory,resume:s.threadId,
    account:s.account||'B',sourceTraceId:traceId,sourceTurnId:s.turnId};
}
async function launchCodex(root,payload,bridge){
  const account=bridge?.snapshot().account||'B';
  if(payload.account&&payload.account!==account)throw Error('原任务的网页账号已改变，未打开接续。');
  new (require('../web-host/account-access.cjs').AccountAccess)(root,account).assertCanStart();
  if(!bridge||bridge.snapshot().state!=='ready')throw Error('Codex＋Web 正在连接。请等待连接检查通过。');
  const tools=await bridge.checkTools();if(!tools.ready)throw Error(tools.message);
  const args=launchArguments(root,{...payload,account}),health=await bridge.health();
  if(!health.accepting_turns)throw Error('网页执行服务正在停止，请等待恢复。');
  const current=bridge.snapshot();
  if((current.account||'B')!==account)throw Error('网页账号已改变，未打开任务。');
  if(current.state!=='ready')throw Error('网页连接已改变，未打开任务。');
  if(payload.sourceTraceId){
    const latest=resumeTurnPayload(bridge,payload.sourceTraceId);
    if(['account','model','workingDirectory','resume','sourceTurnId'].some(key=>latest[key]!==payload[key]))
      throw Error('原任务的来源已改变，未打开接续。');
  }
  // A user-clicked interactive console; all data is passed as argv, no shell interpolation.
  const child=spawn('powershell.exe',args,{cwd:payload.workingDirectory,detached:true,stdio:'ignore',windowsHide:false});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();return {opened:true,pid:child.pid,model:'chatgpt-web/'+payload.model,modelSends:0};
}
module.exports={launchArguments,launchCodex,resumeTurnPayload};
