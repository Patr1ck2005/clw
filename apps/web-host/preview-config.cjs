'use strict';
const fs=require('node:fs'),path=require('node:path');
const {normalizeNetworkOptions,DEFAULT_PROXY}=require('./network-guard.cjs');
function invalid(code,message){const error=Error(message);error.code=code;return error;}
function legacyConfig(){return {schema:1,legacy:true,network:{mode:'legacy',proxy_url:DEFAULT_PROXY}};}
function readManifest(root){
  const file=path.join(root,'.local','preview-installation.json');let raw;
  try{raw=fs.readFileSync(file,'utf8');}catch(error){
    if(error.code==='ENOENT'){
      // A dangling manifest link is damaged configuration, not an old install.
      try{fs.lstatSync(file);}catch(check){if(check.code==='ENOENT')return null;}
    }
    throw invalid('preview_installation_unreadable','无法读取本安装的网络设置；请修复预览安装配置后重新打开。');
  }
  let value;try{value=JSON.parse(raw.replace(/^\uFEFF/,''));}catch{throw invalid('preview_installation_invalid','预览安装配置损坏；网络设置未更改，请修复配置后重新打开。');}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!==1)
    throw invalid('preview_installation_invalid','预览安装配置版本无效，请修复配置后重新打开。');
  return value;
}
function readPreviewConfig(root){
  const value=readManifest(root);if(!value)return legacyConfig();
  if(!value.network||typeof value.network!=='object'||Array.isArray(value.network)||!['system','direct','proxy'].includes(value.network.mode))
    throw invalid('preview_installation_invalid','预览安装的网络设置无效，请检查配置版本及网络模式。');
  const {mode,proxy_url}=value.network;
  if(mode!=='proxy'&&proxy_url!==undefined&&proxy_url!==null&&proxy_url!=='')
    throw invalid('preview_installation_invalid','系统网络或直连模式不能同时指定代理地址，请修复配置后重新打开。');
  let options;try{options=normalizeNetworkOptions({mode,proxyUrl:proxy_url});}catch(error){throw invalid('preview_installation_invalid',error.message);}
  // Return only installation/network metadata. Other manifest fields and any
  // unrelated account or credential files are deliberately not read or exposed.
  return {schema:1,legacy:false,network:{mode,proxy_url:options.proxyUrl||''}};
}
function networkOptions(root){
  const config=readPreviewConfig(root),{mode,proxy_url}=config.network;
  return mode==='proxy'||mode==='legacy'?{mode,proxyUrl:proxy_url}:{mode};
}
function defaultAccount(root){
  const value=readManifest(root);if(!value)return 'B';
  if(value.accounts===undefined)return 'A';
  if(!Array.isArray(value.accounts)||!value.accounts.length||value.accounts.length>2||
    value.accounts.some(item=>!item||typeof item!=='object'||Array.isArray(item)||!['A','B'].includes(item.id))||
    new Set(value.accounts.map(item=>item.id)).size!==value.accounts.length)
    throw invalid('preview_installation_invalid','预览安装的账号槽设置无效，请修复配置后重新打开。');
  return value.accounts[0].id;
}
function childEnvironment(root,base=process.env,options=networkOptions(root)){
  const selected=normalizeNetworkOptions(options),env={...base};
  if(selected.mode!=='legacy'){
    for(const key of Object.keys(env))if(/^(powershell_telemetry_optout|do_not_track)$/i.test(key))delete env[key];
    Object.assign(env,{POWERSHELL_TELEMETRY_OPTOUT:'1',DO_NOT_TRACK:'1'});
  }
  for(const key of Object.keys(env))if(/^(https?|all|no)_proxy$/i.test(key)&&(selected.mode!=='system'||/^no_proxy$/i.test(key)))delete env[key];
  if(['legacy','proxy'].includes(selected.mode))Object.assign(env,{HTTP_PROXY:selected.proxyUrl,HTTPS_PROXY:selected.proxyUrl,ALL_PROXY:selected.proxyUrl});
  env.NO_PROXY='127.0.0.1,localhost,::1';return env;
}
module.exports={readPreviewConfig,networkOptions,defaultAccount,childEnvironment};
