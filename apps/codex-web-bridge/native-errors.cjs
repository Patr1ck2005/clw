'use strict';
// Classify only an actual failed MCP result, never a model's explanation.
// Return a fixed code; do not copy error text or capabilities into telemetry.
function nativeResultCode(result){
  if(result?.isError!==true)return undefined;
  const texts=(Array.isArray(result.content)?result.content:[])
    .filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text.slice(0,4096));
  if(texts.some(text=>/\bturn token is invalid, expired, or revoked\b/i.test(text)
    ||/This turn_token was issued for [^\n]{1,160}, which has already finished\./.test(text)))return 'native_turn_authority_ended';
  return undefined;
}
module.exports={nativeResultCode};
