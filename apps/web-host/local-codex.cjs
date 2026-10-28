'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function directory(value){return typeof value==='string'&&path.isAbsolute(value)&&fs.statSync(value,{throwIfNoEntry:false})?.isDirectory();}
function findCodex(environment=process.env){
  // Resolve known executable names only. Never inspect profiles, auth, or
  // evaluate an npm wrapper while discovering this local entry.
  for(const folder of (environment.PATH||environment.Path||'').split(path.delimiter).filter(Boolean)){
    for(const name of process.platform==='win32'?['codex.exe','codex.cmd','codex.ps1']:['codex']){
      const candidate=path.join(folder.replace(/^"|"$/g,''),name);
      if(fs.statSync(candidate,{throwIfNoEntry:false})?.isFile())return candidate;
    }
  }
  return null;
}
function powershellFor(root){
  const bundled=path.join(root,'runtime','powershell','pwsh.exe');
  if(fs.statSync(bundled,{throwIfNoEntry:false})?.isFile())return bundled;
  if(fs.existsSync(path.join(root,'.local','preview-installation.json')))throw Error('local_codex_private_shell_unavailable');
  return 'powershell.exe';
}
function launchArguments(root,payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!['workingDirectory','resume'].includes(k)))throw Error('local_codex_request_invalid');
  if(!directory(payload.workingDirectory))throw Error('请选择存在的工作目录。');
  const resume=payload.resume??false;
  if(typeof resume!=='boolean'&&!uuid(resume))throw Error('请选择原 Codex 任务，或填写有效的任务标识。');
  return ['-NoProfile','-NoExit','-File',path.join(root,'scripts','start_local_codex.ps1'),
    '-WorkingDirectory',payload.workingDirectory,...(resume?['-Resume',resume===true?'pick':resume]:[])];
}
function createLocalCodex(root,{spawnProcess=spawn,resolveCommand=()=>findCodex(),platform=process.platform,getEnvironment=null}={}){
  let lastOpened=null,pending=null,command=resolveCommand();
  const snapshot=()=>({available:platform==='win32'&&!!command,state:lastOpened?'opened':command?'available':'unavailable',
    protocol:'installed-codex-cli',capabilities:['launch','resume'],modelSource:'installed_codex_configuration',
    loginVerified:false,modelCalled:false,...(lastOpened?{lastOpened}:{} )});
  async function launch(payload){
    if(pending)throw Error('本地 Codex 正在打开，请等待原入口。');
    command=resolveCommand();
    if(platform!=='win32'||!command)throw Error('未找到本机 Codex；请先完成原生客户端安装。');
    const args=launchArguments(root,payload);
    // A user-requested interactive terminal. All values remain separate argv;
    // the normal CLI keeps its own login, model, approvals and sandbox settings.
    pending=new Promise((resolve,reject)=>{
      let child;
      try{child=spawnProcess(powershellFor(root),args,{cwd:payload.workingDirectory,detached:true,stdio:'ignore',windowsHide:false,
        ...(getEnvironment?{env:getEnvironment()}: {})});}
      catch(error){reject(error);return;}
      child.once('error',reject);child.once('spawn',()=>{child.unref();resolve(child.pid);});
    });
    try{
      const pid=await pending;
      lastOpened={pid,workingDirectory:payload.workingDirectory,resume:payload.resume||false,at:new Date().toISOString()};
      return {opened:true,pid,route:'local-codex',protocol:'installed-codex-cli',modelSends:0,loginVerified:false};
    }finally{pending=null;}
  }
  return {snapshot,launch};
}
module.exports={createLocalCodex,launchArguments,findCodex,powershellFor};
