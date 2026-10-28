'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {publicApproval}=require('./public-approval.cjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
class ApprovalManager {
  constructor({journalFile,connectors=[],now=()=>new Date().toISOString()}){
    this.file=journalFile;this.connectors=new Set(connectors);this.now=now;this.busy=new Set();this.attempted=new Set();this.clicked=new Set();
    if(fs.existsSync(this.file))for(const line of fs.readFileSync(this.file,'utf8').trim().split('\n')){
      try{const e=JSON.parse(line);if(e.key&&e.event==='allow_once_attempted')this.attempted.add(e.key);if(e.key&&e.event==='allow_once_clicked')this.clicked.add(e.key);}catch{this.journalInvalid=true;}
    }
  }
  event(value){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.appendFileSync(this.file,JSON.stringify({at:this.now(),...value})+'\n');}
  async inspect(target){
    if(this.busy.has(target.id))return null;this.busy.add(target.id);
    try{
      const evalDom=(op,args={})=>target.evaluate(`(${publicApproval.toString()})(${JSON.stringify(op)},${JSON.stringify(args)})`);
      const s=await evalDom('inspect');
      if(!s.required)return {required:false};
      const state={required:true,kind:s.kind||'unknown',connector:s.connector||'',state:'needs_confirmation'};
      if(!s.eligible||!['returned_file','tool'].includes(s.kind)||!this.connectors.has(s.connector)||s.connector!==target.connector||s.url!==target.url||!s.userId||(target.userId&&s.userId!==target.userId)||this.journalInvalid||!target.authorized(s.kind))return state;
      const legacyKey=hash(JSON.stringify([target.id,target.requestId,s.signature]));
      const key=s.approvalIdentity?hash(JSON.stringify([target.id,target.requestId,s.approvalIdentity])):legacyKey;
      // Preserve an old unknown receipt. A confirmed old click does not consume
      // every later file message whose generic card text happens to match.
      if(this.attempted.has(key)||(key!==legacyKey&&this.attempted.has(legacyKey)&&!this.clicked.has(legacyKey)))return {...state,state:'original_confirmation_pending'};
      // Persist intent BEFORE the single click. Unknown receipts are never
      // interpreted as permission to click again, including across restart.
      this.event({event:'allow_once_attempted',key,page:target.id,request:target.requestId,connector:s.connector,kind:s.kind});this.attempted.add(key);
      if(!target.authorized(s.kind)){this.event({event:'allow_once_cancelled',key});return state;}
      try{
        await evalDom('allow-once',{signature:s.signature,url:s.url,connector:s.connector,approvalIdentity:s.approvalIdentity});
        this.event({event:'allow_once_clicked',key});this.clicked.add(key);
        return {...state,state:'allowed_once'};
      }catch{
        this.event({event:'allow_once_receipt_unknown',key});return {...state,state:'original_confirmation_pending'};
      }
    }finally{this.busy.delete(target.id);}
  }
}
module.exports={ApprovalManager};
