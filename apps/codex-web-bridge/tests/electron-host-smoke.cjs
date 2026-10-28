'use strict';
// Real isolated Chromium, blank documents only. No production profile/model.
const {app,BrowserWindow,session}=require('electron');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {freePort}=require('../electron-host.cjs');
const {NetworkGuard,configureNetworkFlags}=require('../../web-host/network-guard.cjs');
const {BrowserHost}=require('../upstream/launcher/electron/browser-host.cjs');
const {BrowserControlServer}=require('../upstream/launcher/electron/control-server.cjs');
const dest=path.resolve(__dirname,'../../..','.local','codex-web-bridge-qa');
app.setPath('userData',path.join(dest,'profile'));configureNetworkFlags(app);
let host,control;
(async()=>{
  fs.mkdirSync(dest,{recursive:true});const port=await freePort();app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');app.commandLine.appendSwitch('remote-debugging-port',String(port));await app.whenReady();
  const guard=new NetworkGuard();await guard.protect(session.defaultSession);await guard.protect(session.fromPartition('persist:clw-account-b'));
  const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true,nodeIntegration:false}});
  // Electron exposes an uninitialized window as a CDP target that never answers
  // Page.enable. The production shell loads index.html before the bridge starts.
  await win.loadURL('data:text/html,<title>CLW bridge isolated test</title>');
  const logger={info(){},warn(){},error(){},debug(){}};
  control=await new BrowserControlServer({logger,getBrowserHost:()=>host,getPreferences:()=>({showBrowserDuringTurns:false}),resolveProxy:async()=> 'PROXY 127.0.0.1:17890'}).start();
  const helper=path.resolve(__dirname,'../upstream/dist/browser-helper.cjs');
  host=new BrowserHost({window:win,descriptorPath:path.join(dest,'descriptor.json'),cdpPort:port,control:control.descriptor(),cancelTurn:async()=>{},getConnectorName:()=> 'Codex Native2',helper:{executable:process.execPath,script:helper},logger,loginWithPasskey:async()=>{throw Error('not used');},publishState(){},getUseSavedChats:()=>true});
  await host.ready();
  require('../home-navigation.cjs').installSlowNavigationNotice(host,{timeoutMs:50});
  const owned=[];for(let i=0;i<7;i++)owned.push(await host.beginTurn('clw-smoke-'+i,false,process.pid));
  assert.equal(host.turnTabs.size,7);assert.equal(new Set(owned.map(t=>t.surfaceId)).size,7);
  assert.equal((await host.beginTurn('clw-smoke-2',false,process.pid)).surfaceId,owned[2].surfaceId);
  assert.throws(()=>host.heartbeatTurn('clw-smoke-2',process.pid+100000),/ownership/);
  // Reproduce a navigation whose DOM is ready while an image remains pending.
  // Merely checking initial blank tabs misses the 0x0 viewport regression.
  // Fixture responses belong only to this separate test profile. No requests
  // leave the process and the production VPN rules are not relaxed.
  session.fromPartition('persist:clw-account-b').protocol.handle('https',req=>{
    if(new URL(req.url).pathname==='/pending.png')return new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'image/png'}});
    return new Response('<title>Slow owned page</title><textarea id="composer"></textarea><img src="/pending.png">',{headers:{'Content-Type':'text/html'}});
  });
  for(const contents of [host.view.webContents,[...host.turnTabs.values()][0].view.webContents]){
  for(let navigation=0;navigation<2;navigation++){
    const domReady=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture DOM timeout')),10000);contents.once('dom-ready',()=>{clearTimeout(timer);resolve();});});
    void contents.loadURL('https://chatgpt.com/?qa-fixture='+navigation).catch(()=>{});
    await domReady;
    const deadline=Date.now()+5000;let viewport;
    contents.debugger.attach('1.3');
    do{
      const evaluated=await contents.debugger.sendCommand('Runtime.evaluate',{expression:'({width:innerWidth,height:innerHeight,ready:document.readyState,composer:document.querySelector("#composer").getBoundingClientRect().width})',returnByValue:true});
      viewport=evaluated.result.value;
      if(viewport.width>0&&viewport.height>0&&viewport.composer>0)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }while(Date.now()<deadline);
    assert.ok(viewport.width>0&&viewport.height>0&&viewport.composer>0,JSON.stringify(viewport));
    assert.notEqual(viewport.ready,'complete','test must observe the unfinished load');
    if(contents===host.view.webContents){
      await new Promise(resolve=>setTimeout(resolve,80));
      assert.equal(contents.isLoadingMainFrame(),true,'slow-loading notice must not cancel remaining resources');
    }
    contents.debugger.detach();
  }
  }
  await new Promise((resolve,reject)=>{
    const code=`const {chromium}=require(${JSON.stringify(path.resolve(__dirname,'../upstream/node_modules/playwright-core'))});(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:${port}',{timeout:15000});if(b.contexts().flatMap(c=>c.pages()).length<8)throw Error('missing owned pages');await b.close();})().catch(e=>{console.error(e.message);process.exitCode=1;});`;
    const child=spawn(process.execPath,['-e',code],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NO_PROXY:'127.0.0.1,localhost',DEBUG:'pw:protocol'},windowsHide:true,stdio:['ignore','ignore','pipe']});
    let err='';child.stderr.on('data',b=>{err+=b;});child.on('error',reject);child.on('exit',code=>{fs.writeFileSync(path.join(dest,'blank-cdp-debug.log'),err);code===0?resolve():reject(Error('CDP child: '+err.slice(-1500)));});
  });
  const descriptor=JSON.parse(fs.readFileSync(path.join(dest,'descriptor.json'),'utf8'));assert.equal(Object.keys(descriptor.surfaceTargets).length,8);
  // The transport can discard device emulation while the Electron owner still
  // caches the same options. Exercise the exact same-page rebind handshake.
  const reboundTab=[...host.turnTabs.values()][0],reboundContents=reboundTab.view.webContents;
  reboundContents.debugger.attach('1.3');
  await reboundContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
  reboundContents.debugger.detach();
  host.heartbeatTurn(reboundTab.traceId,process.pid,true);
  await new Promise(resolve=>setTimeout(resolve,200));
  reboundContents.debugger.attach('1.3');
  const reboundViewport=(await reboundContents.debugger.sendCommand('Runtime.evaluate',{expression:'({width:innerWidth,height:innerHeight})',returnByValue:true})).result.value;
  reboundContents.debugger.detach();
  assert.ok(reboundViewport.width>=320&&reboundViewport.height>=240,'same-page rebind viewport: '+JSON.stringify(reboundViewport));
  // Check compiled helper can start with Electron's Node runtime, without a turn.
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[helper],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',err='',ready=false;const timer=setTimeout(()=>{child.kill();reject(Error('helper timeout '+err.slice(0,500)));},20000);
    child.stderr.on('data',b=>{err+=b;});child.stdout.on('data',b=>{output+=b;if(!ready&&output.includes('"ready"')){ready=true;child.stdin.write('{"type":"shutdown"}\n');}});
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);if(code===0&&ready)resolve();else reject(Error('helper failed '+code+' '+err.slice(0,1000)));});
  });
  const result={blankPages:7,uniqueOwnership:true,foreignHeartbeatRejected:true,slowNavigationViewport:true,repeatedNavigationViewport:true,samePageRebindViewport:reboundViewport,slowNoticePreservesLoading:true,hiddenWindow:!win.isVisible(),proxy:await session.fromPartition('persist:clw-account-b').resolveProxy('https://chatgpt.com/'),compiledHelperReady:true,productionProfileUsed:false,modelSends:0};
  fs.writeFileSync(path.join(dest,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));host.destroy();await control.close();app.exit(0);
})().catch(async e=>{console.error(e.stack);host?.destroy();await control?.close();app.exit(1);});
