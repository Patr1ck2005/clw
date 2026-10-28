'use strict';
// On-demand projection of original Union call references. The caller supplies
// its existing owner/account/page activity scope; this module never discovers
// a page, changes accounts or creates another result store.
const fs=require('node:fs/promises');
const {createResultStore}=require('./result-store.cjs');
const CALL=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const RESULT=/^result_[a-f0-9]{32}$/;
function createCallDetailsReader({resultHome,authorizationFile,readActivity}){
  if(typeof authorizationFile!=='string'||typeof readActivity!=='function')throw Error('mcp_call_details_source_invalid');
  const store=createResultStore({home:resultHome});
  return async query=>{
    if(!query||!CALL.test(query.callId||'')||!['arguments','response'].includes(query.part)||
      Object.keys(query).some(key=>!['callId','part','offset','max_bytes','format'].includes(key)))throw Error('mcp_call_details_query_invalid');
    const snapshot=await readActivity();
    const event=(snapshot?.events||[]).findLast(row=>row.callId===query.callId&&
      row.event==='mcp_call_details'&&row.part===query.part);
    const resultId=event?.resultId;
    if(!RESULT.test(resultId||''))return {callId:query.callId,part:query.part,available:false,
      reason:event?.code||'original_call_details_not_recorded',originalExecutionReplayed:false};
    const principal=(await fs.readFile(authorizationFile,'utf8')).trim();
    try{
      const page=await store.read({result_id:resultId,offset:query.offset??0,max_bytes:query.max_bytes??65536,
        format:query.format??'text'},principal,{trackCoverage:false,expectedCallId:query.callId,expectedPart:query.part});
      return {callId:query.callId,part:query.part,available:true,originalExecutionReplayed:false,...page};
    }catch(error){
      if(error.code==='RESULT_NOT_FOUND')return {callId:query.callId,part:query.part,available:false,
        reason:'original_call_details_unavailable',originalExecutionReplayed:false};
      throw error;
    }
  };
}
module.exports={createCallDetailsReader};
