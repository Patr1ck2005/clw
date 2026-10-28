'use strict';
// Isolated real Electron network/layout probe. No production account is opened.
const {app,BrowserWindow,session,ipcMain}=require('electron');const path=require('node:path');const fs=require('node:fs');const http=require('node:http');const {NetworkGuard,configureNetworkFlags}=require('../network-guard.cjs');
const dest=path.resolve(__dirname,'../../..','.local','web-host-qa');app.setPath('userData',path.join(dest,'profile'));configureNetworkFlags(app);
app.whenReady().then(async()=>{fs.mkdirSync(dest,{recursive:true});const guard=new NetworkGuard();await guard.verify(session.defaultSession);
 const win=new BrowserWindow({width:1440,height:960,show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});guard.protectContents(win.webContents);
 ipcMain.handle('clw-command',()=>({}));await win.loadFile(path.resolve(__dirname,'../index.html'));
 win.webContents.send('clw-state',{root:'D:\\Projects\\Research',connected:true,network:guard.state,pages:[],notice:'',view:null});await new Promise(r=>setTimeout(r,300));fs.writeFileSync(path.join(dest,'shell.png'),(await win.webContents.capturePage()).toPNG());
 let requests=0;const server=http.createServer((_req,res)=>{requests++;res.end('DIRECT LEAK');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dead=http.createServer();await new Promise(r=>dead.listen(0,'127.0.0.1',r));const deadPort=dead.address().port;await new Promise(r=>dead.close(r));
 const offline=session.fromPartition('offline-proxy-test');await offline.setProxy({mode:'fixed_servers',proxyRules:'http://127.0.0.1:'+deadPort,proxyBypassRules:'<-loopback>'});let blocked=false;
 try{await offline.fetch('http://127.0.0.1:'+server.address().port,{signal:AbortSignal.timeout(5000)});}catch{blocked=true;}
 await new Promise(r=>server.close(r));const evidence={vpn:guard.ready,proxyRoute:await session.defaultSession.resolveProxy('https://chatgpt.com/'),webrtc:win.webContents.getWebRTCIPHandlingPolicy(),proxyFailureBlocked:blocked,directServerRequests:requests,realAccount:false,realModel:false};fs.writeFileSync(path.join(dest,'verification.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));app.exit(blocked&&requests===0?0:1);
}).catch(e=>{console.error(e.message);app.exit(1);});
