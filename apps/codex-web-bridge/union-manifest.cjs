'use strict';
// Project discovery and native execution share one advertised MCP catalog.
// Derive native metadata from that catalog, never from a second hand-written
// schema. This adapter cannot execute a native call or grant turn authority.
const SIDECARS=['recording_session_id','ack_session_message_ids','context_request','session_message_resolution'];
function manifestArguments(params){
  if(params?.name==='tool_manifest')return params.arguments||{};
  if(params?.name!=='call_runtime_tool'||params.arguments?.tool!=='tool_manifest')return null;
  const nested=params.arguments.arguments;
  if(!nested||typeof nested!=='object'||Array.isArray(nested))return null;
  // The original gateway still validates the unchanged request. Preserve the
  // presence of outer sidecars so discovery cannot claim to process them.
  return {...nested,...Object.fromEntries(SIDECARS.filter(k=>Object.hasOwn(params.arguments,k)).map(k=>[k,params.arguments[k]]))};
}
const authority={context:'codex_native_turn',credential:'turn_token',
  note:'Execution requires the current Codex turn token and its original runtime permissions. Workflow Session credentials do not apply. Native tool inventory entries are invoked through codex_tool_call, not as additional MCP tool names.'};
const resultTool={name:'clw_read_result',
  description:'Read a bounded page of an original result retained after exceeding the response limit. Use its opaque result_id and returned next_offset until eof. Do not rerun the original tool. Text reads preserve UTF-8; base64 reads preserve binary bytes. This read-only retrieval does not acknowledge or resolve Workflow Session messages.',
  inputSchema:{type:'object',properties:{
    result_id:{type:'string',minLength:1,description:'Opaque capability returned with the original retained result; not a filesystem path.'},
    offset:{type:'integer',minimum:0,default:0,description:'Byte offset returned by the preceding page.'},
    max_bytes:{type:'integer',minimum:4,maximum:524288,default:65536,description:'Maximum original bytes to read in this page.'},
    format:{type:'string',enum:['text','base64'],default:'text'}
  },required:['result_id'],additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
function localContract(tool,full=true){
  return {name:tool.name,...(tool.description?{description:tool.description}:{}),
    ...(full?{input_schema:tool.inputSchema}:{}),...(tool.annotations?{annotations:tool.annotations}:{}),
    route:{mode:'direct',name:tool.name,gateway:{name:'call_runtime_tool',arguments:{tool:tool.name}}},
    authority:{context:'mcp_retained_result',credential:'original_mcp_authorization_and_result_id',
      note:'Requires the original MCP authorization and opaque result capability. No Codex turn_token is required or granted. This local retrieval does not process Workflow Session sidecars, ACK messages, resolve requests, or replay the original operation. Use the original Workflow Session tools for those actions.'}};
}
function contract(tool,full=true){
  return {name:tool.name,...(tool.description?{description:tool.description}:{}),
    ...(full?{input_schema:tool.inputSchema}:{}),...(tool.annotations?{annotations:tool.annotations}:{}),
    route:{mode:'direct'},authority};
}
function adaptManifest(envelope,args,tools,localTools=[]){
  const result=envelope?.result,structured=result?.structuredContent,output=structured?.output;
  if(!output||envelope.error)return envelope;
  const native=tools.find(t=>t.name===args.tool_name);
  const local=!native&&localTools.find(t=>t.name===args.tool_name);
  let next,error=null;
  if(native){
    // Only repair our upstream's specific missing-name error. Permission,
    // validation, platform or transport errors are never turned into success.
    // ChatGPT's legacy gateway may return isError:false (or omit the hint)
    // while the authoritative structured business result reports failure.
    // Match only our exact missing-name error, never the optional envelope hint.
    if(structured.success!==false||output.code!=='unknown_tool_manifest_tool'||output.tool_name!==native.name)return envelope;
    if(SIDECARS.some(k=>Object.hasOwn(args,k))){
      error='Native tool metadata does not process Workflow Session sidecars; no native call was executed.';
      next={code:'native_manifest_sidecars_unsupported',message:error,tool_name:native.name};
    }else next=contract(native);
  }else if(local){
    // Upstream validates this unchanged manifest request before we supply our
    // local contract. Repair only its exact missing-name result, never a
    // permission, validation, session-sidecar, platform, or transport error.
    if(structured.success!==false||output.code!=='unknown_tool_manifest_tool'||output.tool_name!==local.name)return envelope;
    if(structured.error_code!=null&&!['INVALID_ARGUMENT','unknown_tool_manifest_tool'].includes(structured.error_code))return envelope;
    next=localContract(local);
  }else if(!args.tool_name&&result.isError!==true&&structured.success===true){
    const summaries=tools.map(t=>contract(t,false));
    const localSummaries=localTools.map(t=>localContract(t,false));
    if(output.categories&&Number.isInteger(output.tool_count)){
      if(!Object.hasOwn(output.categories,'codex_native')){
        next={...output,categories:{...output.categories,codex_native:tools.map(t=>t.name)},tool_count:output.tool_count+tools.length,
          native_tools:summaries,risk_summary_scope:'webcodex; native risks retain their published annotations'};
      }
      if(localTools.length&&(!Object.hasOwn(output.categories,'results')||Array.isArray(output.categories.results))){
        const prior=next||output,categories=prior.categories;
        const names=new Set(Object.values(categories).flatMap(value=>Array.isArray(value)?value:[]));
        const additions=localTools.filter(t=>!names.has(t.name));
        const resultNames=[...new Set([...(categories.results||[]),...localTools.map(t=>t.name)])];
        const metadata=Array.isArray(prior.local_tools)?prior.local_tools:[];
        const known=new Set(metadata.map(t=>t.name));
        const missing=localSummaries.filter(t=>!known.has(t.name));
        if(additions.length||missing.length||resultNames.length!==(categories.results||[]).length){
          next={...prior,categories:{...categories,results:resultNames},tool_count:prior.tool_count+additions.length,
            local_tools:[...metadata,...missing]};
        }
      }
    }else if(Array.isArray(output.tools)){
      const selected=[...((['native','codex_native'].includes(args.category)||['coding','discovery'].includes(args.intent))?summaries:[]),
        ...((['results','resilience'].includes(args.category)||['coding','discovery'].includes(args.intent))?localSummaries:[])];
      const names=new Set(output.tools.map(t=>t.name));
      if(selected.length)next={...output,tools:[...output.tools,...selected.filter(t=>!names.has(t.name))]};
    }
  }
  if(!next)return envelope;
  const updated={...structured,error,success:!error,output:next};
  // Only an exact missing-name result is repaired. Its old error
  // classification must not survive alongside a now-successful contract.
  if((native||local)&&!error){delete updated.error_code;delete updated.error_data;}
  return {...envelope,result:{...result,isError:!!error,
    content:[...(!native&&!local?result.content||[]:[]),{type:'text',text:error||JSON.stringify(next)}],
    structuredContent:updated}};
}
module.exports={adaptManifest,contract,localContract,manifestArguments,resultTool};
