'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {freePort,createListenerSupervisor}=require('../electron-host.cjs');

const listenerFile=path.join(__dirname,'..','public-listener.cjs');
const bunFile=path.resolve(__dirname,'../../..','.local','runtimes','bun-1.4.0','bun.exe');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const {randomUUID}=require('node:crypto');
async function waitFor(check,timeoutMs=5000){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){const value=check();if(value)return value;await delay(20);}
  throw Error('offline_listener_wait_timeout');
}
function request(port,{method='GET',path='/',headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,method,path,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
      res.on('error',reject);
    });
    req.on('error',reject);req.end(body);
  });
}
async function fixture(handler){
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,port:server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('public listener passes binary requests, SSE bytes, owner health and admin auth unchanged',async()=>{
  const posted=Buffer.from([0,1,2,13,10,255,128,65]);
  const frames=[Buffer.from('event: response.created\r\ndata: {"id":"one"}\r\n\r\n'),
    Buffer.from('event: response.output_text.delta\r\ndata: {"delta":"中文 ☀"}\r\n\r\n'),
    Buffer.from('event: response.completed\r\ndata: {"id":"one"}\r\n\r\n')];
  let seen;
  const owner=await fixture((req,res)=>{
    if(req.url==='/healthz')return res.setHeader('Content-Type','application/json').end(JSON.stringify({pid:process.pid,status:'ok'}));
    if(req.url==='/binary')return res.writeHead(206,{'Content-Type':'application/octet-stream'}).end(Buffer.from([0,255,128,13,10]));
    if(req.url==='/admin/drain'){
      if(req.headers.authorization!=='Bearer offline-secret')return res.writeHead(401).end('Unauthorized');
      return res.writeHead(200,{'Content-Type':'application/json'}).end('{"accepting_turns":false}');
    }
    const chunks=[];req.on('data',part=>chunks.push(part));req.on('end',()=>{
      seen={method:req.method,path:req.url,authorization:req.headers.authorization,
        custom:req.headers['x-case-check'],body:Buffer.concat(chunks)};
      res.writeHead(201,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Owner':'kept'});
      res.write(frames[0]);setTimeout(()=>{res.write(frames[1]);res.end(frames[2]);},15);
    });
  });
  let publicPort=await freePort();while(publicPort===owner.port)publicPort=await freePort();
  const supervisor=createListenerSupervisor({executable:fs.existsSync(bunFile)?bunFile:process.execPath,script:listenerFile,
    publicPort,ownerPort:owner.port,cwd:__dirname,env:process.env,restartDelays:[30,60]});
  try{
    await supervisor.start();
    const health=await request(publicPort,{path:'/healthz'});
    assert.equal(health.status,200);assert.equal(JSON.parse(health.body).pid,process.pid);
    const binary=await request(publicPort,{path:'/binary'});
    assert.equal(binary.status,206);assert.deepEqual(binary.body,Buffer.from([0,255,128,13,10]));
    assert.equal((await request(publicPort,{method:'POST',path:'/admin/drain'})).status,401);
    const admin=await request(publicPort,{method:'POST',path:'/admin/drain',headers:{Authorization:'Bearer offline-secret'}});
    assert.equal(admin.status,200);assert.equal(admin.body.toString(),'{"accepting_turns":false}');
    const response=await request(publicPort,{method:'POST',path:'/v1/responses?raw=%2f%2B',
      headers:{Authorization:'Bearer original-token','X-Case-Check':'preserved','Content-Type':'application/octet-stream',
        'Content-Length':posted.length},body:posted});
    assert.equal(response.status,201);
    assert.equal(response.headers['content-type'],'text/event-stream; charset=utf-8');
    assert.equal(response.headers['x-owner'],'kept');
    assert.deepEqual(response.body,Buffer.concat(frames));
    assert.deepEqual(seen,{method:'POST',path:'/v1/responses?raw=%2f%2B',authorization:'Bearer original-token',
      custom:'preserved',body:posted});
  }finally{await supervisor.stop();await owner.close();}
});

test('listener death restarts only the listener, with owner state and original endpoint intact',async()=>{
  let sends=0,session='same-owner-session';
  const owner=await fixture((req,res)=>{
    if(req.url==='/healthz')return res.setHeader('Content-Type','application/json').end(JSON.stringify({pid:process.pid,session,sends}));
    if(req.url==='/v1/responses'){
      sends++;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('event: response.created\ndata: {"id":"held"}\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  let publicPort=await freePort();while(publicPort===owner.port)publicPort=await freePort();
  const supervisor=createListenerSupervisor({executable:process.execPath,script:listenerFile,
    publicPort,ownerPort:owner.port,cwd:__dirname,env:process.env,restartDelays:[30,60],stableAfterMs:1000});
  try{
    await supervisor.start();
    const firstListenerPid=supervisor.snapshot().pid;
    await new Promise((resolve,reject)=>{
      let interrupted=false;
      const req=http.request({hostname:'127.0.0.1',port:publicPort,method:'POST',path:'/v1/responses'},res=>{
        res.once('data',()=>{interrupted=true;process.kill(firstListenerPid);});
        res.once('close',()=>interrupted?resolve():reject(Error('stream_closed_before_listener_kill')));
        res.once('error',error=>interrupted?resolve():reject(error));
      });
      req.once('error',error=>interrupted?resolve():reject(error));req.end(Buffer.from('one physical send'));
    });
    const newListenerPid=await waitFor(()=>{
      const current=supervisor.snapshot();return current.state==='ready'&&current.pid!==firstListenerPid&&current.pid;
    });
    assert.notEqual(newListenerPid,firstListenerPid);
    const health=await request(publicPort,{path:'/healthz'});
    assert.equal(health.status,200);
    assert.deepEqual(JSON.parse(health.body),{pid:process.pid,session,sends:1});
    await owner.close();
    const stoppedOwner=await request(publicPort,{path:'/healthz'});
    assert.equal(stoppedOwner.status,502);
    assert.equal(stoppedOwner.body.toString(),'bridge_owner_unavailable\n');
    assert.equal(supervisor.snapshot().pid,newListenerPid);
    assert.equal(sends,1);
  }finally{await supervisor.stop();if(owner.server.listening)await owner.close();}
});

test('listener supervisor stops after its bounded crash budget and explicit quit prevents respawn',async()=>{
  const publicPort=await freePort();
  let ownerPort=await freePort();while(ownerPort===publicPort)ownerPort=await freePort();
  const supervisor=createListenerSupervisor({executable:process.execPath,script:listenerFile,
    publicPort,ownerPort,cwd:__dirname,env:process.env,restartDelays:[20,40],stableAfterMs:10000});
  try{
    await supervisor.start();
    for(let attempt=0;attempt<3;attempt++){
      const previous=supervisor.snapshot().pid;
      process.kill(previous);
      if(attempt<2)await waitFor(()=>{
        const next=supervisor.snapshot();return next.state==='ready'&&next.pid!==previous&&next.pid;
      });
    }
    await waitFor(()=>supervisor.snapshot().state==='failed');
    assert.equal(supervisor.snapshot().pid,null);
    await supervisor.stop();
    await delay(100);
    assert.deepEqual(supervisor.snapshot(),{state:'stopped',pid:null,failures:2});
  }finally{await supervisor.stop();}
});

test('maintenance closes the exact original listener normally through its private parent pipe, without kill',async()=>{
 for(const executable of [process.execPath,...(fs.existsSync(bunFile)?[bunFile]:[])]){
  const publicPort=await freePort();let ownerPort=await freePort();while(ownerPort===publicPort)ownerPort=await freePort();
  const supervisor=createListenerSupervisor({executable,script:listenerFile,publicPort,ownerPort,ownerPid:process.pid,cwd:__dirname,env:process.env,restartDelays:[20]});
  const child=await supervisor.start(),key=randomUUID();let kills=0;const oldKill=child.kill.bind(child);child.kill=()=>{kills++;throw Error('maintenance must not kill');};
  try{
   assert.throws(()=>supervisor.prepareMaintenance({operationId:key,ownerPid:process.pid+1}),/listener_unknown/);
   supervisor.prepareMaintenance({operationId:key,ownerPid:process.pid});
   await assert.rejects(supervisor.stopMaintenance({operationId:randomUUID(),ownerPid:process.pid,timeoutMs:2000}),/listener_unknown/);
   const receipt=await supervisor.stopMaintenance({operationId:key,ownerPid:process.pid,timeoutMs:3000});
   assert.deepEqual(receipt,{pid:child.pid,code:0,signal:null});assert.equal(kills,0);
   assert.deepEqual(await supervisor.stopMaintenance({operationId:key,ownerPid:process.pid,timeoutMs:3000}),receipt);
  }finally{child.kill=oldKill;if(child.exitCode===null)await supervisor.stop();}
 }
});
