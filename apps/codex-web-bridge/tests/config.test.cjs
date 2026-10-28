const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {paths,isolatedEnvironment,runtimeConfig,codexArguments,connectorAppName,settings}=require('../bridge-config.cjs');
test('bridge uses a separate tunnel and process-only Web route',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-bridge-'));
  try{
    const key=path.join(root,'key.txt'),bin=path.join(root,'tunnel.exe');fs.writeFileSync(key,'test-only');fs.writeFileSync(bin,'test-only');
    const tunnel={tunnelId:'tunnel_'+'a'.repeat(32),runtimeKeyFile:key,binaryPath:bin};
    const old=path.join(root,'.local/account-b-tunnel/profiles/webcodex-account-b.yaml');fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,'tunnel_id: '+tunnel.tunnelId);
    assert.throws(()=>runtimeConfig(root,{tunnel},18234),/cannot_reuse/);
    const shared=runtimeConfig(root,{tunnel,transport:'shared-mcp'},18234);
    assert.equal(shared.appName,'Local-MCP-B');assert.equal(shared.tunnel.tunnelId,tunnel.tunnelId);
    assert.equal(runtimeConfig(root,{tunnel,transport:'shared-mcp',webAccount:'A'},18234).appName,'Local-MCP');
    for(const account of ['A','B']){
      const own=runtimeConfig(root,{tunnel,transport:'shared-mcp',webAccount:account,appName:'Local-MCP-WKR'},18234);
      assert.equal(own.appName,'Local-MCP-WKR');assert.equal(own.automaticAppName,'Local-MCP-WKR');assert.equal(own.tunnel.tunnelId,tunnel.tunnelId);
    }
    assert.throws(()=>runtimeConfig(root,{tunnel,transport:'shared-mcp',webAccount:'C'},18234),/account_invalid/);
    const config=runtimeConfig(root,{tunnel:{...tunnel,tunnelId:'tunnel_'+'b'.repeat(32)}},18234);
    assert.equal(config.mode,'full');assert.equal(config.useSavedChats,true);assert.equal(config.experimentalBiggerContext,false);
    assert.equal(config.browserHostDescriptorPath,paths(root).descriptor);
    const args=codexArguments('http://127.0.0.1:18234/v1','chatgpt-web/pro',root);
    assert.ok(args.includes('openai_base_url="http://127.0.0.1:18234/v1"'));
    assert.ok(args.includes('features.apps=false'));
    const withApps=codexArguments('http://127.0.0.1:18234/v1','chatgpt-web/extra-high',root,[],{includeConnectedApps:true});
    assert.ok(withApps.includes('features.apps=true'));
    assert.equal(withApps.includes('features.apps=false'),false);
    assert.throws(()=>codexArguments('http://example.com:80/v1','chatgpt-web/pro',root),/local_endpoint/);
    assert.throws(()=>codexArguments('http://127.0.0.1:18234/v1','gpt-6-astra',root),/explicit_web_model/);
    assert.equal(fs.existsSync(path.join(root,'config.toml')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('explicit connector names stay bounded and settings reject malformed names',t=>{
  for(const value of ['',null,42,' Local-MCP-WKR','Local-MCP-WKR ','Local\nMCP','Local\u007fMCP','x'.repeat(129)])assert.throws(()=>connectorAppName({appName:value}),/app_name_invalid/);
  assert.equal(connectorAppName({},'unchanged-default'),'unchanged-default');assert.equal(connectorAppName({appName:'Local-MCP-WKR'}),'Local-MCP-WKR');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'clw-connector-name-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=paths(root).settings;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({enabled:false,appName:'broken\nname'}));
  assert.throws(()=>settings(root),/app_name_invalid/);
});
test('remote subprocess traffic is fixed to VPN, with only IPC exemptions',t=>{
  // This environment fixture must not depend on the current working directory's
  // private policy files. An empty installation uses the private-data path.
  const missing=()=>{throw Object.assign(Error('fixture missing'),{code:'ENOENT'});};
  t.mock.method(fs,'readFileSync',missing);t.mock.method(fs,'lstatSync',missing);
  const input={PATH:'retained',https_proxy:'http://wrong:1',NO_PROXY:'*',ALL_PROXY:'DIRECT'};
  const env=isolatedEnvironment(path.resolve('.'),input);
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:17890');assert.equal(env.NO_PROXY,'127.0.0.1,localhost');
  assert.equal(env.https_proxy,undefined);assert.equal(env.PATH,'retained');assert.equal(input.NO_PROXY,'*');
  assert.equal(env.CLW_WEB_AUTHORIZATION_FILE,path.join(path.resolve('.'),'.local','web-user-authorization.json'));
});
