'use strict';
// Independent of the Electron/Responses lifecycle: ordinary Local-MCP remains
// available while CLW is closed. The existing A/B tunnels target this entry.
const path=require('node:path'),fs=require('node:fs');
const {startUnion,nativeProvider}=require('./mcp-union.cjs');
const {paths,settings,connectorAppName,isolatedEnvironment}=require('./bridge-config.cjs');
const {writePrivateFileAtomic}=require('./upstream/launcher/electron/atomic-file.cjs');
const {journal}=require('./union-journal.cjs');
const root=path.resolve(__dirname,'../..'),p=paths(root),configFile=process.argv[2];
let union,provider;
(async()=>{
 if(!configFile||!path.isAbsolute(configFile))throw Error('union_absolute_config_required');
 const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 if(!path.isAbsolute(config.authorizationFile||'')||!path.isAbsolute(config.statusFile||'')||!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw Error('union_config_invalid');
 const status=value=>writePrivateFileAtomic(config.statusFile,JSON.stringify({at:new Date().toISOString(),pid:process.pid,...value})+'\n');
 const runtime=JSON.parse(fs.readFileSync(p.config,'utf8'));
 const sharedNames=new Set(['Local-MCP','Local-MCP-B']),selected=settings(root);
 if(selected.transport==='shared-mcp'&&selected.appName!==undefined)sharedNames.add(connectorAppName(selected));
 if(!sharedNames.has(runtime.appName)||runtime.mode!=='full')throw Error('union_shared_runtime_required');
 provider=await nativeProvider({command:p.bun,args:['run',p.entry,'mcp','--contract','native','--broker-socket',runtime.brokerSocketPath],cwd:root,env:isolatedEnvironment(root)});
 union=await startUnion({target:config.target,authorizationFile:config.authorizationFile,port:config.port,native:provider,
   resultHome:path.join(p.home,'result-cache'),onEvent:journal(path.join(p.home,'mcp-activity.jsonl'))});
 status({state:'ready',url:union.url,nativeTools:provider.tools.map(t=>t.name),liveWebAcceptance:false});
 let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await union.close();status({state:'stopped'});process.exitCode=0;};
 process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
})().catch(async()=>{
 // Credentials, arguments, and tool outputs never enter a process error log.
 console.error('Unified MCP start failed; current tunnel was not changed.');
 if(union)await union.close().catch(()=>{});else await provider?.close().catch(()=>{});process.exitCode=1;
});
