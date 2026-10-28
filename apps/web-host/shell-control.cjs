'use strict';
const {randomUUID}=require('node:crypto');
class ShellControl {
  constructor({contents,isCurrent=()=>true,timeoutMs=5000}){
    Object.assign(this,{contents,isCurrent,timeoutMs});this.pending=new Map();
  }
  request(action,payload={}){
    const contents=this.contents();
    if(!contents||contents.isDestroyed()||!this.isCurrent())return Promise.reject(Error('app_shell_unavailable'));
    const id=randomUUID(),generation=contents.getURL();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('app_shell_response_unknown'));},this.timeoutMs);
      this.pending.set(id,{contents,generation,resolve,reject,timer});
      try{contents.send('clw-ui-control',{id,action,payload});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  respond(event,message){
    const item=this.pending.get(message?.id);
    if(!item||item.contents!==event.sender)return false;
    clearTimeout(item.timer);this.pending.delete(message.id);
    if(!this.isCurrent()||this.contents()!==item.contents||item.contents.isDestroyed()||item.contents.getURL()!==item.generation){
      item.reject(Error('app_shell_owner_changed'));return false;
    }
    if(message.ok===true)item.resolve(message.result);
    else item.reject(Object.assign(Error(typeof message.code==='string'?message.code:'app_shell_control_rejected'),{accepted:false}));
    return true;
  }
  invalidate(){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('app_shell_owner_changed'));}this.pending.clear();}
}
module.exports={ShellControl};
