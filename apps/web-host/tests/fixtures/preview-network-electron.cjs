'use strict';
// Standalone private Electron probe: no CLW main, window, account, remote fetch,
// model, service, or existing browser session. Destination must be a fresh dir.
const {app,session,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {NetworkGuard,configureNetworkFlags}=require('../../network-guard.cjs');
const dest=path.resolve(process.argv[2]||'');
if(!process.argv[2]||fs.existsSync(path.join(dest,'profile')))throw Error('A fresh private probe directory is required.');
app.setPath('userData',path.join(dest,'profile'));configureNetworkFlags(app,{mode:'system'});
app.commandLine.appendSwitch('disable-background-networking');
const servers=[];
app.whenReady().then(async()=>{
  const result={electron:process.versions.electron,windows:BrowserWindow.getAllWindows().length,realAccount:false,modelSends:0,remoteFetches:0,modes:[]};
  for(const [mode,proxyUrl,expected] of [['system',undefined,null],['direct',undefined,'DIRECT'],
    ['proxy','http://127.0.0.1:18123','PROXY 127.0.0.1:18123'],['proxy','https://proxy.invalid','HTTPS proxy.invalid:443'],
    ['proxy','socks5://127.0.0.1:1080','SOCKS5 127.0.0.1:1080']]){
    const ses=session.fromPartition('preview-network-'+result.modes.length),guard=new NetworkGuard({mode,proxyUrl});
    let resets=0;ses.closeAllConnections=async()=>{resets++;throw Error('new policy must not reset connections');};
    ses.fetch=async()=>{throw Error('verification must not fetch a remote endpoint');};
    const state=await guard.verify(ses),route=expected?await ses.resolveProxy('https://chatgpt.com/'):null;
    if(expected)assert.equal(route,expected);assert.equal(guard.ready,true);assert.equal(resets,0);
    result.modes.push({mode,proxy:state.proxy,route,state:guard.state,resets});
  }
  let directHits=0;
  const target=http.createServer((_req,res)=>{directHits++;res.end('private loopback fixture');});servers.push(target);
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+target.address().port+'/';
  const dead=http.createServer();await new Promise(resolve=>dead.listen(0,'127.0.0.1',resolve));
  const deadPort=dead.address().port;await new Promise(resolve=>dead.close(resolve));
  const offline=session.fromPartition('preview-network-offline'),guard=new NetworkGuard({mode:'proxy',proxyUrl:'http://127.0.0.1:'+deadPort});
  await guard.verify(offline);
  // Isolate proxy routing from the guard's separate HTTPS-only request filter.
  // This override permits exactly this private loopback HTTP fixture.
  offline.webRequest.onBeforeRequest((details,callback)=>callback({cancel:details.url!==url}));
  let blocked=false;try{await offline.fetch(url,{signal:AbortSignal.timeout(5000)});}catch{blocked=true;}
  assert.equal(blocked,true);assert.equal(directHits,0);
  const direct=session.fromPartition('preview-network-direct-loopback'),directGuard=new NetworkGuard({mode:'direct'});await directGuard.verify(direct);
  direct.webRequest.onBeforeRequest((details,callback)=>callback({cancel:details.url!==url}));
  const response=await direct.fetch(url,{signal:AbortSignal.timeout(5000)});assert.equal(await response.text(),'private loopback fixture');assert.equal(directHits,1);
  Object.assign(result,{proxyFailureBlocked:blocked,proxyFailureDirectHits:0,directModeLoopbackHits:directHits,passed:true});
  for(const server of servers)await new Promise(resolve=>server.close(resolve));
  process.stdout.write(JSON.stringify(result)+'\n',()=>app.exit(0));
}).catch(async error=>{for(const server of servers)await new Promise(resolve=>server.close(resolve));console.error(error);app.exit(1);});
