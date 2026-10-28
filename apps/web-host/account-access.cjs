'use strict';
const fs=require('node:fs'),path=require('node:path');
const {writePrivateFileAtomic}=require('../codex-web-bridge/upstream/launcher/electron/atomic-file.cjs');

// Inspect visible platform notices only, never quoted conversation content.
function publicAccessLimit(){
  const visible=e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);return b.width>0&&b.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="alert"]')].filter(visible).some(e=>{
    const t=e.innerText||'';
    return /too many requests/i.test(t)&&/temporarily limited access|requests too quickly/i.test(t)
      || /请求过于频繁|请求太多|请求次数过多/.test(t)&&/暂时|稍后|几分钟/.test(t);
  });
}
class AccountAccess {
  constructor(root,account='B',{now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),navigationGapMs=3000}={}){
    if(!['A','B'].includes(account))throw Error('invalid_account');
    this.file=path.join(root,'.local','web-host','account-access-'+account+'.json');this.account=account;this.now=now;
    this.sleep=sleep;this.navigationGapMs=navigationGapMs;this.nextNavigation=0;this.navigationQueue=Promise.resolve();
  }
  read(){
    try{const s=JSON.parse(fs.readFileSync(this.file,'utf8'));if(s.version!==1||s.account!==this.account||typeof s.blocked!=='boolean'||!Number.isFinite(s.retryAfter))throw Error('invalid');return s;}
    catch(e){if(e.code==='ENOENT')return {version:1,account:this.account,blocked:false,retryAfter:0};return {version:1,account:this.account,blocked:true,retryAfter:0,reason:'account_access_state_unreadable'};}
  }
  save(s){fs.mkdirSync(path.dirname(this.file),{recursive:true});writePrivateFileAtomic(this.file,JSON.stringify(s)+'\n');return s;}
  hold(source='public_notice'){
    if(!['public_notice','user_report'].includes(source))throw Error('invalid_limit_source');
    const old=this.read();if(old.blocked)return old; // polling the same notice never renews its deadline
    const now=this.now(),episodes=old.observedAt&&now-old.observedAt<30*60_000?Math.min(4,(old.episodes||0)+1):1;
    return this.save({version:1,account:this.account,blocked:true,reason:'conversation_rate_limit',source,observedAt:now,episodes,retryAfter:now+Math.min(30,5*2**(episodes-1))*60_000});
  }
  snapshot(){const s=this.read();return {...s,recheckAllowed:s.blocked&&this.now()>=s.retryAfter,message:s.blocked?'ChatGPT 暂时限制会话访问。已停止新发送和刷新；已发送任务保留。'+(this.now()<s.retryAfter?'请等待冷却结束再检查连接。':'可检查一次连接；检查通过前不会恢复新发送。'):''};}
  assertCanStart(){const s=this.snapshot();if(s.blocked){const e=Error(s.message);e.code='account_access_cooldown';throw e;}}
  admitNavigation({checkTicket}={}){
    // Space navigation starts, not running workers. Slow pages never monopolize
    // admission and no worker-count ceiling is introduced.
    const allowed=()=>{if(!checkTicket)return this.assertCanStart();if(this.beginCheck().observedAt!==checkTicket.observedAt)this.assertCanStart();};
    const admitted=this.navigationQueue.then(async()=>{allowed();const wait=this.nextNavigation-this.now();if(wait>0)await this.sleep(wait);allowed();this.nextNavigation=this.now()+this.navigationGapMs;});
    this.navigationQueue=admitted.catch(()=>{});return admitted;
  }
  beginCheck(){const s=this.read();if(s.blocked&&this.now()<s.retryAfter)this.assertCanStart();return {observedAt:s.observedAt||0};}
  checkFailed(){const s=this.read();if(s.blocked&&this.now()>=s.retryAfter)this.save({...s,retryAfter:this.now()+5*60_000});}
  verified(ticket){
    const s=this.read();if(!s.blocked)return;
    if(s.reason==='account_access_state_unreadable'||(s.observedAt||0)!==ticket.observedAt||this.now()<s.retryAfter)this.assertCanStart();
    this.save({...s,blocked:false,verifiedAt:this.now()});
  }
}
module.exports={AccountAccess,publicAccessLimit};
