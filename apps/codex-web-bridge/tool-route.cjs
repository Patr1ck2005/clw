'use strict';
// Run after model-route validation and before upstream accepts a new turn.
// Does not cancel or inspect already accepted executions.
function guardToolRoute(toolCheck){
  return async req=>{
    if(req.method!=='POST'||!['/v1/responses','/v1/responses/compact'].includes(new URL(req.url).pathname))return;
    const tools=await toolCheck.check({fresh:true});
    if(!tools.ready)return Response.json({error:{type:'service_unavailable',code:'clw_tool_discovery_not_ready',message:tools.message+' No Web message was sent.',retryable:false}},{status:503});
  };
}
module.exports={guardToolRoute};
