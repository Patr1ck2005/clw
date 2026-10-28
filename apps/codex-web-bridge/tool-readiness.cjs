'use strict';
// Read-only local admission check. A connector badge is not proof that its
// discovery contract exposes the native tools. No model, tool execution, or
// Workflow Session side effects are involved here.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const messages={
  checking:'正在核对本机工具服务；不会发送网页消息。',
  ready:'本机工具目录与查询合同一致。',
  unavailable:'本机工具服务暂不可用，已暂停新发送；原任务和在途执行保留。',
  discovery_mismatch:'本机工具查询尚未就绪，需要更新工具服务。新任务尚未发送；刷新网页或重新登录不能修复此问题。',
  owner_changed:'本机工具服务归属发生变化，需先核对原服务；没有创建替代入口。'
};
function localJson(url,{method='GET',headers={},body}={}){
  const u=new URL(url);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password)throw Error('local_only');
  return new Promise((resolve,reject)=>{
    const raw=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    const req=http.request(u,{method,headers:{...headers,...(raw?{'content-type':'application/json','content-length':raw.length}:{})},timeout:5000},res=>{
      const chunks=[];let length=0;
      res.on('data',chunk=>{length+=chunk.length;if(length>2097152){req.destroy(Error('response_too_large'));return;}chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{try{if(res.statusCode!==200)throw Error('local_http_error');resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){reject(e);}});
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('local_timeout')));req.end(raw);
  });
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
const outcome=(code,extra={})=>({ready:code==='ready',code,message:messages[code],checkedAt:new Date().toISOString(),...extra});
function startupUnavailable(root){
  const result=outcome('unavailable');
  try{
    const saved=JSON.parse(fs.readFileSync(path.join(root,'.local','web-host','shared-entry-start.json'),'utf8'));
    const reasons={
      backend_server_not_ready:'后台服务启动尚未就绪',backend_runner_exited:'后台执行服务启动后退出',
      backend_launch_manifest_missing:'后台服务启动配置缺失',backend_manifest_version_invalid:'后台服务配置版本不匹配',
      backend_process_identity_unknown:'后台服务归属尚未确认',backend_endpoint_has_unverified_owner:'后台服务端口归属尚未确认',
      startup_shell_missing:'启动所需的 PowerShell 7 不可用',startup_owner_unverified:'隧道归属尚未确认',
      startup_jobs_not_idle:'原服务仍有执行或尚未确认空闲',startup_config_unavailable:'原隧道配置不可用',
      startup_union_not_ready:'共享工具服务启动尚未就绪',startup_timeout:'启动检查超时，完成状态待核对',
      startup_script_failed:'原隧道启动检查未通过',startup_metadata_invalid:'启动状态或配置无法读取',
      startup_unavailable:'启动检查暂不可用',
    };
    if(saved.state==='needs_attention'&&Object.hasOwn(reasons,saved.reason)){
      result.startupReason=saved.reason;result.message+=' 启动检查：'+reasons[saved.reason]+'。';
    }
  }catch{}
  return result;
}
async function probe(root,{request=localJson}={}){
  try{
    const home=path.join(root,'.local','codex-web-bridge');
    const config=JSON.parse(fs.readFileSync(path.join(home,'union-config.json'),'utf8'));
    const owner=JSON.parse(fs.readFileSync(path.join(home,'shared-entry.json'),'utf8'));
    if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||!path.isAbsolute(config.authorizationFile||''))return outcome('unavailable');
    const base='http://127.0.0.1:'+config.port;
    const health=await request(base+'/healthz');
    if(health.service!=='clw-mcp-union'||!Number.isInteger(health.pid)||health.pid!==owner.unionPid||owner.url!==base+'/mcp')return outcome('owner_changed');
    // Existing credentials stay in memory and only go to the verified loopback
    // entry. Never include them (or error bodies) in the public result.
    const authorization=fs.readFileSync(config.authorizationFile,'utf8').trim();
    if(!authorization)return outcome('unavailable');
    const rpc=async(method,params)=>request(base+'/mcp',{method:'POST',headers:{authorization,'mcp-protocol-version':'2026-07-28','mcp-method':method,...(params.name?{'mcp-name':params.name}:{})},
      body:{jsonrpc:'2.0',id:'clw-discovery-'+randomUUID(),method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}}});
    const catalog=await rpc('tools/list',{});
    const native=catalog.result?.tools?.find(t=>t.name==='codex_tool_call');
    if(catalog.error||catalog.result?.nextCursor||!native?.inputSchema)return outcome('discovery_mismatch',{servicePid:health.pid});
    const args={tool_name:'codex_tool_call',include_recommended_flows:false};
    // The advertised gateway is also used by the real ChatGPT tool resolver.
    // A direct-only probe can otherwise say ready while the same lookup fails.
    for(const params of [{name:'tool_manifest',arguments:args},{name:'call_runtime_tool',arguments:{tool:'tool_manifest',arguments:args}}]){
      const manifest=await rpc('tools/call',params),result=manifest.result,contract=result?.structuredContent;
      if(manifest.error||result?.isError||contract?.success!==true||contract.error||contract.error_code||contract.output?.name!==native.name||
        JSON.stringify(canonical(contract.output.input_schema))!==JSON.stringify(canonical(native.inputSchema)))return outcome('discovery_mismatch',{servicePid:health.pid});
    }
    return outcome('ready',{servicePid:health.pid,nativeToolCount:catalog.result.tools.filter(t=>t.name.startsWith('codex_')).length});
  }catch{return startupUnavailable(root);}
}
function createToolCheck(root,{transport,check=probe,now=Date.now,ttlMs=30000}={}){
  let value=transport==='shared-mcp'?{ready:false,code:'checking',message:messages.checking}:outcome('ready',{notRequired:true});
  let pending,last=-Infinity;
  return {snapshot:()=>({...value}),check:({fresh=false}={})=>{
    if(transport!=='shared-mcp')return Promise.resolve({...value});
    if(pending)return pending;
    if(!fresh&&now()-last<ttlMs)return Promise.resolve({...value});
    pending=Promise.resolve().then(()=>check(root)).catch(()=>outcome('unavailable')).then(result=>{value=result;last=now();return {...value};}).finally(()=>{pending=null;});return pending;
  }};
}
module.exports={probe,createToolCheck,localJson};
