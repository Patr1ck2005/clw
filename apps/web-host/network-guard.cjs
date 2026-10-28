'use strict';
// Existing installations keep their explicit AI-only Mihomo listener. Only an
// installation manifest may opt a new installation into another network mode.
const DEFAULT_PROXY='http://127.0.0.1:17890';
function proxyEndpoint(raw=DEFAULT_PROXY){const u=new URL(raw);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Only the explicit local AI proxy is supported.');if(u.port==='17891')throw Error('Campus-direct listener is not an AI VPN.');return u;}
function manualProxyEndpoint(raw){
  let u;
  try{if(typeof raw!=='string'||!raw.trim()||/\s/.test(raw))throw Error();u=new URL(raw);}catch{throw Error('指定代理地址无效，请填写完整的 HTTP、HTTPS 或 SOCKS5 代理地址。');}
  // SOCKS5 already resolves destination names at the proxy in Chromium.
  if(u.protocol==='socks5h:')u=new URL(raw.replace(/^socks5h:/i,'socks5:'));
  if(!['http:','https:','socks5:'].includes(u.protocol)||!u.hostname||u.username||u.password||u.search||u.hash||u.pathname!=='/'&&u.pathname!==''||u.protocol==='socks5:'&&!u.port)
    throw Error('指定代理地址无效；支持 HTTP、HTTPS、SOCKS5，地址中不能包含账号密码、路径或查询参数。');
  return u;
}
function normalizeNetworkOptions(raw=DEFAULT_PROXY){
  if(typeof raw==='string')return {mode:'legacy',proxyUrl:proxyEndpoint(raw).origin};
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!['legacy','system','direct','proxy'].includes(raw.mode))throw Error('网络模式无效，请选择系统网络、直连或指定代理。');
  if(raw.mode==='legacy')return {mode:'legacy',proxyUrl:proxyEndpoint(raw.proxyUrl??DEFAULT_PROXY).origin};
  if(raw.mode==='proxy'){
    const u=manualProxyEndpoint(raw.proxyUrl);
    // URL.origin is "null" for SOCKS URLs. Electron accepts the scheme URL.
    return {mode:'proxy',proxyUrl:`${u.protocol}//${u.host}`};
  }
  return {mode:raw.mode};
}
function configureNetworkFlags(app,raw=DEFAULT_PROXY){
  const options=normalizeNetworkOptions(raw),fixed=['legacy','proxy'].includes(options.mode);
  if(fixed){app.commandLine.appendSwitch('proxy-server',options.proxyUrl);app.commandLine.appendSwitch('proxy-bypass-list','<-loopback>');}
  else if(options.mode==='direct')app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('disable-quic');
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy','disable_non_proxied_udp');
  if(options.mode==='legacy')app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
}
function expectedProxyRoute(proxy){
  const protocol=proxy.protocol,kind=protocol==='https:'?'HTTPS':protocol==='socks5:'?'SOCKS5':'PROXY';
  const port=proxy.port||(protocol==='https:'?'443':'80');
  return `${kind} ${proxy.hostname}:${port}`;
}
class NetworkGuard {
  constructor(raw=DEFAULT_PROXY){
    this.options=normalizeNetworkOptions(raw);this.mode=this.options.mode;
    this.proxy=this.options.proxyUrl?new URL(this.options.proxyUrl):null;
    this.ready=false;this.state=this.mode==='legacy'?'VPN 未核验':'网络设置尚未应用';
    this.sessions=new WeakSet();this.protecting=new WeakMap();
  }
  async protect(ses){
    if(this.sessions.has(ses))return;
    if(this.protecting.has(ses))return this.protecting.get(ses);
    const pending=this.protectSession(ses);this.protecting.set(ses,pending);
    try{await pending;this.sessions.add(ses);}finally{this.protecting.delete(ses);}
  }
  async protectSession(ses){
    if(['legacy','proxy'].includes(this.mode)){
      // A fixed proxy contains no PAC, DIRECT fallback or implicit loopback bypass.
      await ses.setProxy({mode:'fixed_servers',proxyRules:this.options.proxyUrl,proxyBypassRules:'<-loopback>'});
      // Preserve the legacy startup contract. New-installation settings take
      // effect after a normal close/reopen and must not sever existing pages.
      if(this.mode==='legacy')await ses.closeAllConnections();
    }else await ses.setProxy({mode:this.mode});
    ses.setPermissionRequestHandler((_wc,permission,callback)=>callback(['clipboard-sanitized-write','fullscreen'].includes(permission)));
    ses.setPermissionCheckHandler((_wc,permission)=>['clipboard-sanitized-write','fullscreen'].includes(permission));
    ses.webRequest.onBeforeRequest((details,callback)=>{
      let u;try{u=new URL(details.url);}catch{callback({cancel:true});return;}
      if(['file:','data:','blob:','about:','devtools:'].includes(u.protocol)){callback({cancel:false});return;}
      const allowed=['https:','wss:'].includes(u.protocol)&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname);
      callback({cancel:!allowed});
    });
    // resolveProxy checks Chromium's selected configuration, without requesting
    // an OpenAI page. System PAC resolution belongs to normal page navigation.
    if(this.mode!=='system'){
      this.checkRoute(await ses.resolveProxy('https://chatgpt.com/'));
    }
  }
  checkRoute(route){
    if(this.mode==='system')return route;
    const expected=this.proxy?expectedProxyRoute(this.proxy):'DIRECT';
    if(route!==expected)throw Error(this.mode==='legacy'?'VPN 路由核验失败，网页联网已停止。':'网络路由与所选设置不一致，请正常关闭本安装后重新打开。');
    return route;
  }
  async resolveProxy(ses,url){await this.protect(ses);return this.checkRoute(await ses.resolveProxy(url));}
  protectContents(wc){wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');wc.on('will-attach-webview',event=>event.preventDefault());}
  async verify(ses){
    await this.protect(ses);
    if(this.mode==='legacy'){
      const response=await ses.fetch('https://www.cloudflare.com/cdn-cgi/trace',{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('VPN 出口检查失败，网页联网已停止。');
      const body=await response.text();
      if(!/^ip=\S+$/m.test(body))throw Error('VPN 出口未得到有效回执。');
      // Never persist or expose the IP address or probe a physical path to compare.
      this.ready=true;this.state='VPN 已连接 · 直连已禁用';
      return {proxy:this.proxy.origin,route:'fixed_proxy',directFallback:false,webrtc:'disable_non_proxied_udp'};
    }
    this.ready=true;
    this.state={system:'系统网络设置已应用',direct:'直连设置已应用',proxy:'指定代理已应用 · 不回退直连'}[this.mode];
    return {mode:this.mode,proxy:this.options.proxyUrl||null,route:this.mode==='proxy'?'fixed_proxy':this.mode,
      directFallback:this.mode==='system'?null:false,availability:'not_probed',webrtc:'disable_non_proxied_udp'};
  }
}
module.exports={NetworkGuard,configureNetworkFlags,proxyEndpoint,manualProxyEndpoint,normalizeNetworkOptions,DEFAULT_PROXY};
