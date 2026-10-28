'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {freePort,createListenerSupervisor,createRuntimeFailureState}=require('../electron-host.cjs');
const {createPublicListener}=require('../public-listener.cjs');
const {installTurnJournal}=require('../turn-journal.cjs');

const bridge=path.resolve(__dirname,'..');
const upstream=path.join(bridge,'upstream');
const bun=path.resolve(bridge,'../../.local/runtimes/bun-1.4.0/bun.exe');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function until(check,timeoutMs=15000){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){const found=await check();if(found)return found;await delay(30);}
  throw Error('offline_owner_wait_timeout');
}
function request(port,{method='GET',url='/healthz',body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,method,path:url,timeout:3000,
      headers:body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
      res.on('error',reject);
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('offline_owner_request_timeout')));
    req.end(body);
  });
}
function isolatedConfig(home,ownerPort){
  const key=path.join(home,'fixture-key.txt');fs.writeFileSync(key,'offline-only');
  const pipe='\\\\.\\pipe\\clw-owner-death-'+crypto.randomBytes(8).toString('hex');
  return {version:3,releaseVersion:'6.1.1',mode:'full',subagentProtocol:'compatibility-v1',
    host:'127.0.0.1',port:ownerPort,contextWindow:90000,appName:'Offline Owner Fixture',
    automaticAppName:'Offline Owner Fixture',manualAppName:'Codex Zero Risk',
    browserHost:'managed-chrome',browserInteractionMode:'automatic',
    chromeExecutablePath:bun,storageStatePath:path.join(home,'unused-browser-state.json'),
    brokerSocketPath:process.platform==='win32'?pipe:path.join(home,'broker.sock'),
    headed:false,solAvailable:false,extraHighAvailable:false,proAvailable:false,
    autoApproveToolCalls:false,controlToken:crypto.randomBytes(32).toString('base64url'),
    runtimeCommand:[bun,'run',path.join(upstream,'src','cli.ts')],
    tunnel:{binaryPath:bun,tunnelId:'tunnel_'+'a'.repeat(32),runtimeKeyFile:key,
      profileDir:home,profileName:'offline-owner',alias:'offline-owner'}};
}
function runningJournal(home){
  const contents={getURL:()=> 'https://chatgpt.com/c/offline-owner-task',on(){}};
  const tab={id:'tab-one',traceId:'offline-owner-trace',view:{webContents:contents}};
  const host={turnTabs:new Map([['tab-one',tab]]),beginTurn:async()=>({tabId:'tab-one'}),endTurn:async()=>{}};
  const journal=installTurnJournal(host,home);
  return host.beginTurn().then(()=>journal);
}
async function stopChild(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('offline_owner_shutdown_timeout')),5000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
  });
  child.kill();await exited;
}

test('real isolated serve.ts death leaves the published listener closed to new work and the original task requiring reconciliation',{timeout:30000},async()=>{
  assert.ok(fs.existsSync(bun),'Pinned Bun is required for the isolated serve.ts fixture');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'clw-owner-death-'));
  let owner,listener,reusedPort;
  try{
    const ownerPort=await freePort();let publicPort=await freePort();
    while(publicPort===ownerPort)publicPort=await freePort();
    fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(isolatedConfig(home,ownerPort)));
    const journal=await runningJournal(home);
    const taskFile=path.join(home,'turns','offline-owner-trace.json');
    assert.equal(JSON.parse(fs.readFileSync(taskFile,'utf8')).status,'running');

    const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/_proxy$/i.test(name))),CODEX_CHATGPT_WEB_HOME:home,
      HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',
      NO_PROXY:'127.0.0.1,localhost'};
    owner=spawn(bun,['run',path.join(bridge,'serve.ts')],
      {cwd:upstream,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let diagnostics='';owner.stdout.on('data',chunk=>{diagnostics+=chunk.toString();});
    owner.stderr.on('data',chunk=>{diagnostics+=chunk.toString();});
    await until(async()=>{
      if(owner.exitCode!==null)throw Error('Isolated serve.ts exited during startup: '+diagnostics.slice(-1000));
      try{const health=await request(ownerPort);return health.status===200&&JSON.parse(health.body).pid===owner.pid;}
      catch{return false;}
    });

    const failure=createRuntimeFailureState(()=>journal.ownerClosed('native_owner_closed'));
    failure.watch(owner);
    listener=createListenerSupervisor({executable:bun,script:path.join(bridge,'public-listener.cjs'),
      publicPort,ownerPort,ownerPid:owner.pid,cwd:upstream,env,restartDelays:[30,60]});
    await listener.start();
    const listenerPid=listener.snapshot().pid;
    const before=await request(publicPort);
    assert.equal(before.status,200);
    assert.equal(JSON.parse(before.body).pid,owner.pid);
    assert.equal(failure.apply({state:'ready'}).state,'ready');

    await stopChild(owner);
    await until(()=>failure.failed);
    assert.equal(failure.apply({state:'ready',listenerState:'ready'}).state,'runtime_stopped');
    assert.equal(failure.apply({state:'ready'}).automaticReplay,false);
    assert.equal(failure.apply({state:'ready'}).lastError,'bridge_owner_unavailable');
    const original=JSON.parse(fs.readFileSync(taskFile,'utf8'));
    assert.equal(original.status,'needs_reconciliation');
    assert.equal(original.automaticReplay,false);
    assert.equal(original.traceId,'offline-owner-trace');
    assert.equal(original.reason,'native_owner_closed');

    for(const options of [{},{method:'POST',url:'/v1/responses',body:'{"model":"chatgpt-web/high"}'}]){
      const denied=await request(publicPort,options);
      assert.equal(denied.status,502);
      assert.equal(denied.body,'bridge_owner_unavailable\n');
      assert.equal(denied.headers['cache-control'],'no-store');
    }
    assert.equal(listener.snapshot().pid,listenerPid);
    assert.equal(listener.snapshot().state,'ready');

    // Even if a different local process claims the old port, the listener
    // remains tied to the exited owner and does not forward the original call.
    let forwarded=0;
    reusedPort=http.createServer((_req,res)=>{forwarded++;res.end('wrong owner');});
    await new Promise(resolve=>reusedPort.listen(ownerPort,'127.0.0.1',resolve));
    const afterReuse=await request(publicPort,{method:'POST',url:'/v1/responses',body:'{"model":"chatgpt-web/high"}'});
    assert.equal(afterReuse.status,502);
    assert.equal(afterReuse.body,'bridge_owner_unavailable\n');
    assert.equal(forwarded,0);
    await delay(150); // Longer than both configured listener restart delays.
    assert.ok(owner.exitCode!==null||owner.signalCode!==null);
    assert.equal(listener.snapshot().pid,listenerPid);
    assert.equal(listener.snapshot().state,'ready');
    assert.deepEqual(JSON.parse(fs.readFileSync(taskFile,'utf8')),original);
  }finally{
    if(reusedPort?.listening)await new Promise(resolve=>reusedPort.close(resolve));
    await listener?.stop();await stopChild(owner);
    assert.equal(path.dirname(path.resolve(home)),path.resolve(os.tmpdir()));
    fs.rmSync(home,{recursive:true,force:true});
  }
});

test('owner death after private response arrival is checked again before forwarding headers',{timeout:15000},async()=>{
  const script="const http=require('node:http');const server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({pid:process.pid}));});server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));";
  const owner=spawn(process.execPath,['-e',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let listener,pending,release;
  try{
    let output='',ownerPort;
    owner.stdout.on('data',chunk=>{output+=chunk.toString();const match=/^([0-9]+)\r?\n/.exec(output);if(match)ownerPort=Number(match[1]);});
    await until(()=>ownerPort,5000);
    let publicPort=await freePort();while(publicPort===ownerPort)publicPort=await freePort();
    let responseArrived=false;
    const pause=new Promise(resolve=>{release=resolve;});
    listener=createPublicListener(publicPort,ownerPort,owner.pid,
      {beforeOwnerResponse:()=>{responseArrived=true;return pause;}});
    await new Promise(resolve=>listener.listen(publicPort,'127.0.0.1',resolve));
    pending=request(publicPort);
    await until(()=>responseArrived,5000);
    await stopChild(owner); // Between initial PID check and forwarding the owner's HTTP 200.
    release();
    const result=await pending;
    assert.equal(result.status,502);
    assert.equal(result.body,'bridge_owner_unavailable\n');
    assert.equal(result.headers['cache-control'],'no-store');
  }finally{
    release?.();
    if(pending)await pending.catch(()=>{});
    if(listener?.listening)await new Promise(resolve=>listener.close(resolve));
    await stopChild(owner);
  }
});
