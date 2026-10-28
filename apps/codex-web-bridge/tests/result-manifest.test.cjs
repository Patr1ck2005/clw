'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {adaptManifest,manifestArguments,resultTool,contract,localContract}=require('../union-manifest.cjs');
const native={name:'codex_exec',inputSchema:{type:'object',required:['turn_token']},annotations:{readOnlyHint:false}};
function missing(name=resultTool.name,flag={isError:true}){
  return {jsonrpc:'2.0',id:'original-manifest',result:{...flag,resultType:'complete',
    content:[{type:'text',text:'unknown tool'}],structuredContent:{success:false,error:'unknown tool',
      error_code:'INVALID_ARGUMENT',error_data:{original:true},output:{code:'unknown_tool_manifest_tool',tool_name:name}}}};
}
function discovery(output){
  return {jsonrpc:'2.0',id:'original-manifest',result:{isError:false,content:[{type:'text',text:'upstream discovery'}],
    structuredContent:{success:true,error:null,output}}};
}
const adapted=(envelope,args)=>adaptManifest(envelope,args,[native],[resultTool]);

test('retained-result catalog exposes bounded opaque reads with no native turn authority',()=>{
  assert.equal(resultTool.name,'clw_read_result');
  assert.deepEqual(resultTool.inputSchema.required,['result_id']);
  assert.equal(resultTool.inputSchema.additionalProperties,false);
  assert.equal(resultTool.inputSchema.properties.result_id.type,'string');
  assert.equal(resultTool.inputSchema.properties.offset.minimum,0);
  assert.equal(resultTool.inputSchema.properties.offset.default,0);
  assert.equal(resultTool.inputSchema.properties.max_bytes.minimum,4);
  assert.equal(resultTool.inputSchema.properties.max_bytes.maximum,524288);
  assert.equal(resultTool.inputSchema.properties.max_bytes.default,65536);
  assert.deepEqual(resultTool.inputSchema.properties.format.enum,['text','base64']);
  assert.equal(resultTool.inputSchema.properties.format.default,'text');
  assert.equal(resultTool.inputSchema.properties.turn_token,undefined);
  assert.deepEqual(resultTool.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  const metadata=localContract(resultTool);
  assert.equal(metadata.authority.context,'mcp_retained_result');
  assert.equal(metadata.authority.credential,'original_mcp_authorization_and_result_id');
  assert.match(metadata.authority.note,/does not process Workflow Session sidecars, ACK messages, resolve requests, or replay/);
  assert.deepEqual(metadata.route,{mode:'direct',name:'clw_read_result',gateway:{name:'call_runtime_tool',arguments:{tool:'clw_read_result'}}});
});

test('direct and gateway manifest requests return the identical local result contract',()=>{
  for(const request of [
    {name:'tool_manifest',arguments:{tool_name:resultTool.name}},
    {name:'call_runtime_tool',arguments:{tool:'tool_manifest',arguments:{tool_name:resultTool.name}}}
  ]){
    const original=missing(),snapshot=JSON.stringify(original);
    const result=adapted(original,manifestArguments(request)).result;
    assert.equal(result.isError,false);
    assert.equal(result.resultType,'complete');
    assert.equal(result.structuredContent.success,true);
    assert.equal(result.structuredContent.error,null);
    assert.equal(result.structuredContent.error_code,undefined);
    assert.equal(result.structuredContent.error_data,undefined);
    assert.deepEqual(result.structuredContent.output,localContract(resultTool));
    assert.deepEqual(result.content,[{type:'text',text:JSON.stringify(localContract(resultTool))}]);
    assert.equal(JSON.stringify(original),snapshot,'do not mutate the original response');
  }
});

test('only exact local missing-name business failures are adapted regardless of transport hint',()=>{
  for(const flag of [{},{isError:false},{isError:true}]){
    const result=adapted(missing(resultTool.name,flag),{tool_name:resultTool.name}).result;
    assert.equal(result.structuredContent.success,true);
    assert.equal(result.structuredContent.output.name,resultTool.name);
  }
  const wrongName=missing('another_missing_tool');
  assert.equal(adapted(wrongName,{tool_name:resultTool.name}),wrongName);
  const ordinarySuccess=discovery({name:resultTool.name,input_schema:{original:true}});
  assert.equal(adapted(ordinarySuccess,{tool_name:resultTool.name}),ordinarySuccess);
  const undeclared=missing();
  assert.equal(adaptManifest(undeclared,{tool_name:resultTool.name},[native]),undeclared);
});

test('permission, platform, validation, and session-sidecar errors are never converted to local success',()=>{
  for(const code of ['permission_denied','platform_safety_refusal','invalid_arguments','session_not_found','session_sidecars_invalid']){
    const envelope=missing();envelope.result.structuredContent.output.code=code;
    assert.equal(adapted(envelope,{tool_name:resultTool.name}),envelope);
  }
  const rpcDenied={...missing(),error:{code:-32000,message:'authorization revoked'}};
  assert.equal(adapted(rpcDenied,{tool_name:resultTool.name}),rpcDenied);
  const malformed={result:{isError:true,structuredContent:{success:false,error:'validation failed'}}};
  assert.equal(adapted(malformed,{tool_name:resultTool.name}),malformed);
  const conflicting=missing();conflicting.result.structuredContent.error_code='PERMISSION_DENIED';
  assert.equal(adapted(conflicting,{tool_name:resultTool.name}),conflicting,'conflicting explicit error classification remains a failure');
});

test('upstream-validated Workflow sidecars remain distinct from native metadata authority',()=>{
  for(const key of ['recording_session_id','ack_session_message_ids','context_request','session_message_resolution']){
    const request={name:'call_runtime_tool',arguments:{tool:'tool_manifest',arguments:{tool_name:resultTool.name},[key]:'original-sidecar'}};
    const args=manifestArguments(request);
    assert.equal(args[key],'original-sidecar');
    const localResult=adapted(missing(),args).result.structuredContent;
    assert.equal(localResult.success,true);
    assert.match(localResult.output.authority.note,/does not process Workflow Session sidecars/);
    assert.match(localResult.output.authority.note,/Use the original Workflow Session tools/);
    const nativeResult=adapted(missing(native.name),{...args,tool_name:native.name}).result.structuredContent;
    assert.equal(nativeResult.success,false);
    assert.equal(nativeResult.output.code,'native_manifest_sidecars_unsupported');
  }
  assert.equal(manifestArguments({name:resultTool.name,arguments:{result_id:'opaque'}}),null);
  assert.equal(manifestArguments({name:'call_runtime_tool',arguments:{tool:resultTool.name,arguments:{result_id:'opaque'}}}),null);
});

test('broad manifest includes results without duplicates or lost upstream/native categories',()=>{
  const original=discovery({categories:{file:['read_files'],results:['read_job_logs']},tool_count:2,risk_summary:{read_only:2}});
  const result=adapted(original,{}).result;
  assert.deepEqual(result.structuredContent.output.categories,{file:['read_files'],results:['read_job_logs',resultTool.name],codex_native:[native.name]});
  assert.equal(result.structuredContent.output.tool_count,4);
  assert.deepEqual(result.structuredContent.output.native_tools,[contract(native,false)]);
  assert.deepEqual(result.structuredContent.output.local_tools,[localContract(resultTool,false)]);
  assert.equal(result.content[0].text,'upstream discovery');
  const second=adapted({...original,result},{});
  assert.equal(second.result,result,'already advertised results are not duplicated');
  assert.deepEqual(original.result.structuredContent.output.categories,{file:['read_files'],results:['read_job_logs']});
});

test('existing native broad metadata does not suppress newly available result metadata',()=>{
  const original=discovery({categories:{codex_native:[native.name],file:['read_files']},tool_count:2,native_tools:[contract(native,false)]});
  const output=adapted(original,{}).result.structuredContent.output;
  assert.deepEqual(output.categories.codex_native,[native.name]);
  assert.deepEqual(output.categories.results,[resultTool.name]);
  assert.equal(output.tool_count,3);
  assert.deepEqual(output.native_tools,original.result.structuredContent.output.native_tools);
  const namedElsewhere=discovery({categories:{codex_native:[native.name],existing:[resultTool.name]},tool_count:2});
  const listed=adapted(namedElsewhere,{}).result.structuredContent.output;
  assert.equal(listed.tool_count,2,'count catalog names once even when referenced by several categories');
  assert.deepEqual(listed.categories.results,[resultTool.name]);
});

test('result/resilience and coding/discovery filters expose relevant local summary only once',()=>{
  for(const args of [{category:'results'},{category:'resilience'},{intent:'coding'},{intent:'discovery'}]){
    const original=discovery({tools:[{name:'upstream_tool',description:'retain me'}]});
    const output=adapted(original,args).result.structuredContent.output;
    assert.deepEqual(output.tools[0],original.result.structuredContent.output.tools[0]);
    assert.equal(output.tools.filter(t=>t.name===resultTool.name).length,1);
    assert.equal(output.tools.find(t=>t.name===resultTool.name).input_schema,undefined,'filtered catalog is a summary');
    assert.equal(output.tools.some(t=>t.name===native.name),Boolean(args.intent));
    const repeated=adapted(discovery(output),args).result.structuredContent.output;
    assert.deepEqual(repeated.tools,output.tools);
  }
  for(const args of [{category:'file'},{category:'native'},{category:'codex_native'}]){
    const output=adapted(discovery({tools:[]}),args).result.structuredContent.output;
    assert.equal(output.tools.some(t=>t.name===resultTool.name),false);
  }
});

test('failed discovery and undeclared local tools retain the exact upstream response',()=>{
  for(const args of [{},{category:'results'},{category:'resilience'},{intent:'discovery'}]){
    const denied=missing();delete denied.result.structuredContent.output.tool_name;
    assert.equal(adapted(denied,args),denied);
    const flagDenied=discovery({tools:[]});flagDenied.result.isError=true;
    assert.equal(adapted(flagDenied,args),flagDenied);
  }
  const ordinary=discovery({tools:[]});
  assert.equal(adaptManifest(ordinary,{category:'results'},[native]),ordinary);
});
