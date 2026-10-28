'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const cfg=require('../bridge-config.cjs');
function manifest(t,value){
  const root=path.resolve('preview-bridge-fixture'),file=path.join(root,'.local','preview-installation.json');
  t.mock.method(fs,'readFileSync',actual=>{assert.equal(actual,file,'only installation metadata may be read');return JSON.stringify(value);});
  return root;
}
for(const mode of ['system','direct','proxy'])test('bridge subprocess environment follows preview '+mode+' network policy',t=>{
  const proxy='http://proxy.example:8765',root=manifest(t,{schema:1,network:{mode,...(mode==='proxy'?{proxy_url:proxy}:{})},accounts:[{id:'A'}]});
  const base={PATH:'retained',HTTPS_PROXY:'http://inherited:8080',http_proxy:'http://lowercase:8081',NO_PROXY:'*'},env=cfg.isolatedEnvironment(root,base);
  assert.equal(env.PATH,'retained');assert.equal(env.NO_PROXY,'127.0.0.1,localhost,::1');assert.equal(env.CODEX_CHATGPT_WEB_HOME,cfg.paths(root).home);
  if(mode==='system'){assert.equal(env.HTTPS_PROXY,base.HTTPS_PROXY);assert.equal(env.http_proxy,base.http_proxy);}
  else if(mode==='direct'){assert.equal(env.HTTPS_PROXY,undefined);assert.equal(env.http_proxy,undefined);assert.equal(env.ALL_PROXY,undefined);}
  else {for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'])assert.equal(env[key],proxy);assert.equal(env.http_proxy,undefined);}
  assert.equal(base.NO_PROXY,'*');assert.equal(cfg.webAccount({},root),'A');assert.equal(cfg.webAccount({webAccount:'B'},root),'B');assert.equal(cfg.webAccount({}),'B');
});
test('bridge subprocesses keep an explicit startup policy snapshot after settings are edited',()=>{
  const env=cfg.isolatedEnvironment('unused',{ALL_PROXY:'http://old:80'},{mode:'direct'});
  assert.equal(env.ALL_PROXY,undefined);assert.equal(env.NO_PROXY,'127.0.0.1,localhost,::1');
});
test('legacy tunnel keeps explicit proxy arguments and manual preview never gains DIRECT fallback',()=>{
  for(const network of [{mode:'legacy',proxyUrl:cfg.PROXY},{mode:'proxy',proxyUrl:'https://proxy.example:9443'}])
    assert.deepEqual(cfg.tunnelArguments('unused','private-profile.yaml',network),['run','--profile-file','private-profile.yaml','--control-plane.http-proxy',network.proxyUrl,'--harpoon.http-proxy',network.proxyUrl]);
});
for(const mode of ['system','direct'])test(mode+' preview tunnel does not inherit legacy fixed proxy arguments',t=>{
  const root=manifest(t,{schema:1,network:{mode}});assert.deepEqual(cfg.tunnelArguments(root,'private-profile.yaml'),['run','--profile-file','private-profile.yaml']);
});
