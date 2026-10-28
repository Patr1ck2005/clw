'use strict';
// Retry only incomplete public UI observation on the same owned empty surface.
// Identity, login, access and policy failures never select another connector.
const DELAYS=[1500,4000];
function retryable(error){
 const message=String(error?.message||'');
 if(/account_access_cooldown|login_required|account_load_failed|connector_surface_closed|owner_unavailable|not_available|duplicate|no row named|production requires|isolated DEV|migration|cancelled|aborted|denied|policy|permission/i.test(message))return false;
 return /bridge_connector_surface_not_ready|(?:locator\.[\w.]+: )?Timeout \d+ms exceeded|Browser helper.*timed out|bridge_surface_probe_timeout|(?:ECONNRESET|ETIMEDOUT)/i.test(message);
}
async function verifyWithRecovery(operation,{delay=ms=>new Promise(r=>setTimeout(r,ms)),stopped=()=>false,onRetry=()=>{}}={}){
 for(let attempt=0;;attempt++){
  if(stopped())throw Error('bridge_not_available');
  try{return await operation();}
  catch(error){
   if(attempt>=DELAYS.length||stopped()||!retryable(error))throw error;
   onRetry({attempt:attempt+2,limit:DELAYS.length+1,delayMs:DELAYS[attempt]});
   await delay(DELAYS[attempt]);
  }
 }
}
module.exports={retryable,verifyWithRecovery};
