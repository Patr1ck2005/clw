'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {EventEmitter}=require('node:events');
const {createLocalCodex,launchArguments}=require('../local-codex.cjs');
const root=path.resolve(__dirname,'../../..');

test('a preview uses its bundled PowerShell even when the system PATH is empty',t=>{
  const os=require('node:os'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'clw-preview-shell-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const {powershellFor}=require('../local-codex.cjs'),shell=path.join(folder,'runtime','powershell','pwsh.exe');
  fs.mkdirSync(path.dirname(shell),{recursive:true});fs.writeFileSync(shell,'fixture executable');
  assert.equal(powershellFor(folder),shell);
  fs.unlinkSync(shell);fs.mkdirSync(path.join(folder,'.local'));fs.writeFileSync(path.join(folder,'.local/preview-installation.json'),'{}');
  assert.throws(()=>powershellFor(folder),/private_shell_unavailable/);
});
test('local entry preserves workspace as argv and never imports a Web route or model override',()=>{
  const args=launchArguments(root,{workingDirectory:root,resume:true});
  assert.equal(args[args.indexOf('-WorkingDirectory')+1],root);
  assert.deepEqual(args.slice(-2),['-Resume','pick']);
  assert.equal(args.includes('-Model'),false);
  assert.equal(args.some(a=>a.includes('start_codex_web')||a.includes('openai_base_url')),false);
  const script=fs.readFileSync(path.join(root,'scripts/start_local_codex.ps1'),'utf8');
  assert.equal(script.includes('model_provider='),false);
  assert.equal(script.includes('openai_base_url='),false);
  assert.equal(script.includes('danger-full-access'),false);
  assert.throws(()=>launchArguments(root,{workingDirectory:root,model:'pro'}));
  assert.throws(()=>launchArguments(root,{workingDirectory:root+';exit'}));
  assert.throws(()=>launchArguments(root,{workingDirectory:root,resume:'unknown;exit'}));
});
test('opening is one interactive CLI launch with no model call; duplicate pending click cannot spawn again',async()=>{
  const child=new EventEmitter();child.pid=1234;child.unref=()=>{};let calls=0;
  const local=createLocalCodex(root,{platform:'win32',resolveCommand:()=>'/fixture/codex',spawnProcess:(command,args,options)=>{
    calls++;assert.equal(command,'powershell.exe');assert.equal(options.windowsHide,false);
    assert.equal(options.cwd,root);assert.equal(args.includes('-NoProfile'),true);return child;
  }});
  const opened=local.launch({workingDirectory:root});
  await assert.rejects(local.launch({workingDirectory:root}),/正在打开/);
  child.emit('spawn');const result=await opened;
  assert.equal(calls,1);assert.equal(result.route,'local-codex');assert.equal(result.modelSends,0);
  assert.equal(result.loginVerified,false);assert.equal(local.snapshot().lastOpened.pid,1234);
});
test('absent CLI and launch failure never fall back to Web and allow a later explicit retry',async()=>{
  const absent=createLocalCodex(root,{platform:'win32',resolveCommand:()=>null});
  assert.equal(absent.snapshot().available,false);
  await assert.rejects(absent.launch({workingDirectory:root}),/未找到/);
  let calls=0;const local=createLocalCodex(root,{platform:'win32',resolveCommand:()=>'/fixture/codex',spawnProcess:()=>{calls++;throw Error('spawn failed');}});
  await assert.rejects(local.launch({workingDirectory:root}),/spawn failed/);
  await assert.rejects(local.launch({workingDirectory:root}),/spawn failed/);
  assert.equal(calls,2);assert.equal(local.snapshot().modelCalled,false);
});
test('an explicitly supplied preview environment reaches the interactive shell unchanged',async()=>{
  const child=new EventEmitter();child.pid=2345;child.unref=()=>{};
  const selected={POWERSHELL_TELEMETRY_OPTOUT:'1',DO_NOT_TRACK:'1',PATH:'own-cli'};let seen;
  const local=createLocalCodex(root,{platform:'win32',resolveCommand:()=>'/fixture/codex',getEnvironment:()=>({...selected}),
    spawnProcess:(command,args,options)=>{seen=options.env;return child;}});
  const pending=local.launch({workingDirectory:root});child.emit('spawn');await pending;
  assert.deepEqual(seen,selected);assert.equal(local.snapshot().modelCalled,false);
});
