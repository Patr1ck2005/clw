'use strict';
// Historical CLI imports need both the exact Session final and the CLI packet
// receipt. The shared verifier reads the Session; this wrapper keeps the
// review record's small, versioned proof shape stable.
const crypto=require('node:crypto');
const {verifyNativeTerminalReceipt}=require('./native-terminal-receipt.cjs');

function exactNativeSessionFinal(threadId,turnId,finalText,startedAt,endedAt,{sessionsRoot}={}){
  if(typeof finalText!=='string'||!finalText.trim())throw Error('review_native_identity_invalid');
  const finalSha256=crypto.createHash('sha256').update(finalText.trim(),'utf8').digest('hex');
  const receipt=verifyNativeTerminalReceipt({threadId,turnId,expectedFinalSha256:finalSha256,
    startedAt,endedAt,sessionsRoot});
  return {version:1,threadId,turnId,terminal:'task_complete_with_matching_final',
    eventSha256:receipt.receiptSha256,finalSha256};
}
module.exports={exactNativeSessionFinal};
