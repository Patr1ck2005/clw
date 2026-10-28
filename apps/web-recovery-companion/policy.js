/* Pure conservative UI policy. Does not inspect cookies/network or infer failure from time. */
(() => {
 'use strict';
 const chat=/^https:\/\/chatgpt\.com\/(?:g\/[A-Za-z0-9_-]+\/)?c\/[A-Za-z0-9-]{16,128}$/;
 const errors=new Map([['无法思考','cannot_think'],['Unable to think','cannot_think'],['Something went wrong while generating the response','generation_failed'],['生成回复时出错','generation_failed']]);
 function classify(x){
  if(!chat.test(x.url)||x.url!==x.boundUrl)return 'unsupported';
  if(x.stopped)return 'user_stopped';
  if(x.newUserInput)return 'new_user_input';
  if(x.login)return 'login_required';
  if(x.limited)return 'rate_limited';
  if(x.safety)return 'safety_denied';
  if(!x.visible)return 'hidden';
  if(x.generating)return 'generating';
  if(x.draft||x.composing)return 'draft';
  if(!x.controlsKnown)return 'unsupported';
  if(x.terminalMarker&&x.assistantTurnId&&x.userTurnId&&!x.inQuotedContent)return errors.get(x.errorLabel)||'unsupported';
  return 'idle';
 }
 globalThis.CLWRecoveryPolicy=Object.freeze({classify,isChat:url=>chat.test(url),errors:[...errors.keys()]});
})();
