'use strict';
const fs=require('node:fs'),path=require('node:path');
const {writePrivateFileAtomic}=require('../codex-web-bridge/upstream/launcher/electron/atomic-file.cjs');
const {sanitizeUsage}=require('./chat-history-usage.cjs');
const MODELS={'latest-pro':'Pro · 最新','gpt-5.6-pro':'GPT-5.6 Sol Pro'};
// Optional display metadata only. Never authorizes dispatch, changes a model,
// reads account history, or treats a local Send as an official billed message.
function usageAttempt(value,account){
  if(!value)return null;
  const clean=sanitizeUsage({...value,account,source:'chat_history_reconstruction',
    completedProResponses:0,proConversations:0,allCompletedResponses:0,
    totalConversations:value.coverage?.conversationsRead||0,byDay:[],byModel:[]},account);
  return {accountIdentity:clean.accountIdentity,checkedAt:clean.checkedAt,window:clean.window,coverage:clean.coverage};
}
class AccountQuota {
  constructor(root,account,{now=Date.now}={}){
    if(!['A','B'].includes(account))throw Error('quota_account_invalid');
    this.account=account;this.now=now;this.file=path.join(root,'.local','web-host','account-quota-'+account+'.json');
  }
  read(){
    try{const s=JSON.parse(fs.readFileSync(this.file,'utf8'));if(s.version!==1||s.account!==this.account||!s.models)throw Error('invalid');return s;}
    catch(e){return {version:1,account:this.account,models:{},readFailed:e.code!=='ENOENT'};}
  }
  save(s){fs.mkdirSync(path.dirname(this.file),{recursive:true});writePrivateFileAtomic(this.file,JSON.stringify(s)+'\n');}
  report(model,{exhausted,resetText=''}={}){
    if(!Object.hasOwn(MODELS,model)||typeof exhausted!=='boolean'||typeof resetText!=='string'||resetText.length>120)throw Error('quota_report_invalid');
    const s=this.read();if(s.readFailed)throw Error('quota_record_unreadable');
    s.models[model]={...s.models[model],report:{exhausted,resetText:resetText.trim(),at:this.now()}};this.save(s);return this.snapshot();
  }
  observe(menu){
    const selection=menu?.selection||[],model=selection.some(x=>/Sol/i.test(x))?'gpt-5.6-pro':selection.some(x=>/^(最新|Latest)$/i.test(x))?'latest-pro':null;
    const option=menu?.options?.find(x=>/^Pro$/i.test(x.name));
    if(!model||typeof option?.available!=='boolean')return;
    const s=this.read();if(s.readFailed)return;
    s.models[model]={...s.models[model],observation:{available:option.available,at:this.now()}};this.save(s);
  }
  recordUsage(value){
    const clean=sanitizeUsage(value,this.account),s=this.read();
    if(s.readFailed)throw Error('quota_record_unreadable');
    const previous=s.usage||{};
    s.usage={lastGood:clean.coverage.state==='complete'?clean:previous.lastGood||null,
      lastAttempt:usageAttempt(clean,this.account)};
    this.save(s);return this.snapshot();
  }
  snapshot(){
    const s=this.read();let lastGood=null,lastAttempt=null;
    try{if(s.usage?.lastGood)lastGood=sanitizeUsage(s.usage.lastGood,this.account);}catch{}
    try{lastAttempt=usageAttempt(s.usage?.lastAttempt,this.account);}catch{}
    if(lastGood&&lastAttempt?.accountIdentity&&lastGood.accountIdentity!==lastAttempt.accountIdentity)lastGood=null;
    if(lastAttempt?.coverage.reason==='account_context_changed')lastGood=null;
    const usage={lastGood,lastAttempt,stale:!!s.readFailed||!lastGood||lastAttempt?.coverage.state!=='complete'};
    return {account:this.account,readFailed:!!s.readFailed,officialRemaining:null,usage,models:Object.entries(MODELS).map(([id,label])=>{
      const row=s.models[id]||{},o=row.observation,r=row.report;
      const observed=typeof o?.available==='boolean'&&Number.isFinite(o.at),reported=typeof r?.exhausted==='boolean'&&Number.isFinite(r.at);
      const stale=!observed||this.now()-o.at>15*60_000;
      const exhausted=reported&&r.exhausted&&!(observed&&o.available&&o.at>=r.at);
      const status=exhausted?'exhausted':!stale?(o.available?'available':'unavailable'):'unknown';
      return {id,label,status,stale,observedAt:observed?o.at:null,reportedAt:reported?r.at:null,source:exhausted?'user_report':!stale?'public_model_menu':'unknown',resetText:exhausted?r.resetText||null:null,resetSource:exhausted&&r.resetText?'user_report':null};
    })};
  }
}
module.exports={AccountQuota};
