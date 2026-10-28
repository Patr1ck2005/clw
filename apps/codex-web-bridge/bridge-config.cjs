'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {childEnvironment,networkOptions,defaultAccount}=require('../web-host/preview-config.cjs');
const PROXY='http://127.0.0.1:17890';
const WEB_MODELS=new Set(['chatgpt-web/light','chatgpt-web/medium','chatgpt-web/high','chatgpt-web/extra-high','chatgpt-web/pro','chatgpt-web/gpt-6-pro','chatgpt-web/gpt-5.6-pro']);
const DEFAULT_AUTHORIZATION=Object.freeze({version:1,enabled:true,text:'按用户当前任务直接使用工具，工具与文件确认自动允许。',
  auto_approve_tools:true,auto_approve_returned_files:true,recover_ended_turns:false});
function authorizationPath(root){
  const current=path.join(root,'.local','web-user-authorization.json'),legacy=path.join(root,'config','web-user-authorization.json');
  for(const file of [current,legacy])try{fs.lstatSync(file);return file;}catch(error){if(error.code!=='ENOENT')throw error;}
  return current;
}
function readUserAuthorization(root){
  const file=authorizationPath(root);let raw;
  try{raw=fs.readFileSync(file,'utf8');}catch(error){
    if(error.code!=='ENOENT')throw error;
    try{fs.lstatSync(file);}catch(check){if(check.code==='ENOENT')return {...DEFAULT_AUTHORIZATION};throw check;}
    throw error;
  }
  const p=JSON.parse(raw.replace(/^\uFEFF/,''));
  if(!p||typeof p!=='object'||Array.isArray(p)||p.version!==1||typeof p.enabled!=='boolean'||
    ['recover_ended_turns','auto_approve_returned_files','auto_approve_tools'].some(key=>Object.hasOwn(p,key)&&typeof p[key]!=='boolean')||
    p.enabled&&(typeof p.text!=='string'||!p.text.trim()||p.text.length>4096))throw Error('web_user_authorization_invalid');
  return {...DEFAULT_AUTHORIZATION,...p};
}
function webAccount(s={},root){const a=s.webAccount??(root?defaultAccount(root):'B');if(!['A','B'].includes(a))throw Error('bridge_account_invalid');return a;}
function connectorAppName(s={},fallback){
  if(s.appName===undefined)return fallback;
  if(typeof s.appName!=='string'||!s.appName.length||s.appName.length>128||s.appName!==s.appName.trim()||/[\x00-\x1f\x7f]/.test(s.appName))throw Error('bridge_app_name_invalid');
  return s.appName;
}
function paths(root){
  const home=path.join(root,'.local','codex-web-bridge'),upstream=path.join(root,'apps','codex-web-bridge','upstream');
  return {home,upstream,settings:path.join(home,'settings.json'),config:path.join(home,'config.json'),descriptor:path.join(home,'browser-host.json'),
    status:path.join(home,'status.json'),helper:path.join(upstream,'dist','browser-helper.cjs'),
    bun:path.join(root,'.local','runtimes','bun-1.4.0','bun.exe'),entry:path.join(upstream,'src','cli.ts')};
}
function isolatedEnvironment(root,base=process.env,options=networkOptions(root)){
  // One installation policy for native/helper subprocesses and their tunnel.
  const env=childEnvironment(root,base,options);
  if(options.mode==='legacy')env.NO_PROXY='127.0.0.1,localhost';
  return {...env,CODEX_CHATGPT_WEB_HOME:paths(root).home,
    CLW_WEB_AUTHORIZATION_FILE:authorizationPath(root),
    CLW_WEB_WORK_PACKAGE_FILE:path.join(root,'config','work-package-policy.json')};
}
function tunnelArguments(root,profile,options=networkOptions(root)){
  const args=['run','--profile-file',profile];
  if(['legacy','proxy'].includes(options.mode))args.push('--control-plane.http-proxy',options.proxyUrl,'--harpoon.http-proxy',options.proxyUrl);
  return args;
}
function settings(root){
  const p=paths(root);if(!fs.existsSync(p.settings))return {enabled:false};
  const s=JSON.parse(fs.readFileSync(p.settings,'utf8'));if(typeof s.enabled!=='boolean')throw Error('bridge_enabled_invalid');
  connectorAppName(s);
  return s;
}
function validateTunnel(root,t,{shared=false}={}){
  if(!t||!/^tunnel_[a-f0-9]{32}$/.test(t.tunnelId||''))throw Error('bridge_dedicated_tunnel_required');
  // A different alias for the same tunnel can still steal the active math channel.
  const old=path.join(root,'.local','account-b-tunnel','profiles','webcodex-account-b.yaml');
  const same=fs.existsSync(old)&&fs.readFileSync(old,'utf8').includes(t.tunnelId);
  const accountA=path.join(root,'.local','account-a-tunnel','profile.yaml');
  const sameA=fs.existsSync(accountA)&&fs.readFileSync(accountA,'utf8').includes(t.tunnelId);
  if((same||sameA)&&!shared)throw Error('bridge_cannot_reuse_local_mcp_tunnel');
  if(shared&&!same)throw Error('bridge_shared_tunnel_identity_changed');
  for(const k of ['binaryPath','runtimeKeyFile'])if(!path.isAbsolute(t[k]||'')||!fs.statSync(t[k],{throwIfNoEntry:false})?.isFile())throw Error('bridge_'+k+'_missing');
  const p=paths(root);return {binaryPath:t.binaryPath,runtimeKeyFile:t.runtimeKeyFile,tunnelId:t.tunnelId,
    profileDir:path.join(p.home,'tunnel','profiles'),profileName:'clw-codex-web-b',alias:'clw-codex-web-b'};
}
function runtimeConfig(root,s,port){
  const p=paths(root);if(!Number.isInteger(port)||port<1||port>65535)throw Error('bridge_port_invalid');
  const shared=s.transport==='shared-mcp',tunnel=validateTunnel(root,s.tunnel,{shared});
  const account=webAccount(s,root),appName=connectorAppName(s,shared?(account==='A'?'Local-MCP':'Local-MCP-B'):'Codex Native2');
  const authorization=readUserAuthorization(root);
  return {version:3,releaseVersion:'6.1.1',mode:'full',subagentProtocol:'compatibility-v1',host:'127.0.0.1',port,contextWindow:90000,
    appName,automaticAppName:appName,manualAppName:'Codex Zero Risk',browserHost:'launcher',browserInteractionMode:'automatic',
    browserHostDescriptorPath:p.descriptor,chromeExecutablePath:process.execPath,storageStatePath:path.join(p.home,'unused-storage.json'),
    brokerSocketPath:'\\\\.\\pipe\\clw-codex-web-'+crypto.createHash('sha256').update(p.home.toLowerCase()).digest('hex').slice(0,20),
    headed:true,solAvailable:true,extraHighAvailable:true,proAvailable:true,experimentalBiggerContext:false,experimentalSkillAttachments:false,
    experimentalFreshConversationPerTurn:false,useSavedChats:true,zeroRiskProEnabled:false,
    autoApproveToolCalls:authorization.enabled===true&&authorization.auto_approve_tools===true,
    controlToken:crypto.randomBytes(32).toString('base64url'),runtimeCommand:[p.bun,'run',p.entry],tunnel};
}
function codexArguments(endpoint,model,cwd,args=[],{includeConnectedApps=false}={}){
  const u=new URL(endpoint);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/v1'||u.username||u.password||u.search||u.hash)throw Error('bridge_local_endpoint_required');
  if(!WEB_MODELS.has(model))throw Error('bridge_explicit_web_model_required');
  if(!path.isAbsolute(cwd))throw Error('bridge_absolute_workspace_required');
  // Per-process CLI overrides: no installer, global config/auth/agent changes.
  return ['-c','model_provider="openai"','-c',`openai_base_url=${JSON.stringify(endpoint)}`,'-c',`model=${JSON.stringify(model)}`,'-c',`features.apps=${Boolean(includeConnectedApps)}`,'-c','approval_policy="never"','-c','sandbox_mode="danger-full-access"','-C',cwd,
    '-a','never','-s','danger-full-access',...args];
}
module.exports={PROXY,WEB_MODELS,paths,settings,webAccount,connectorAppName,isolatedEnvironment,tunnelArguments,validateTunnel,runtimeConfig,codexArguments,authorizationPath,readUserAuthorization};
