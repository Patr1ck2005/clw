'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const runNative=promisify(execFile);
const {protectControlDirectory,readControlProcessIdentity,PRIVATE_DIRECTORY_SCRIPT,PROCESS_IDENTITY_SCRIPT}=require('../app-control-private.cjs');
const {startAppControl}=require('../app-control.cjs');

async function folder(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'clw-private-control-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('fixed encoded ACL script receives directory and current SID only through child environment',async t=>{
  const root=await folder(t),directory=path.join(root,"control' $(not-code)"),calls=[],sid='S-1-5-21-1-2-3-1001';
  const protection=await protectControlDirectory(directory,{platform:'win32',run:async(file,args,options)=>{
    calls.push({file,args,options});
    assert.equal(options.windowsHide,true);assert.ok(options.timeout>0);
    if(file.endsWith('whoami.exe')){assert.deepEqual(args,['/user','/fo','csv','/nh']);return {stdout:'"DOMAIN\\person","'+sid+'"'};}
    assert.ok(file.endsWith('powershell.exe'));assert.deepEqual(args.slice(0,4),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand']);
    assert.equal(Buffer.from(args[4],'base64').toString('utf16le'),PRIVATE_DIRECTORY_SCRIPT);
    assert.equal(options.env.CLW_APP_CONTROL_DIRECTORY,directory);assert.equal(options.env.CLW_APP_CONTROL_USER_SID,sid);
    assert.ok(!args.join(' ').includes(directory));assert.ok(!args.join(' ').includes(sid));
    assert.ok(!PRIVATE_DIRECTORY_SCRIPT.includes('Set-Acl'));assert.ok(PRIVATE_DIRECTORY_SCRIPT.includes('[IO.Directory]::SetAccessControl'));
    assert.ok(!PRIVATE_DIRECTORY_SCRIPT.includes('.SetOwner('));assert.ok(PRIVATE_DIRECTORY_SCRIPT.includes('private_directory_owner_untrusted'));
    return {stdout:JSON.stringify({scheme:'windows-dacl',verified:true,user_sid:sid,owner_sid:sid,allowed_sids:[sid,'S-1-5-18','S-1-5-32-544']})};
  }});
  assert.equal(calls.length,2);assert.equal(protection.verified,true);
  assert.equal(process.env.CLW_APP_CONTROL_DIRECTORY,undefined);assert.equal(process.env.CLW_APP_CONTROL_USER_SID,undefined);
});

test('native process identity is creation-bound; a query error remains unknown',async()=>{
  const current=await readControlProcessIdentity(process.pid);assert.equal(current.state,'alive');assert.equal(current.identity.pid,process.pid);
  assert.equal(current.identity.executable.toLowerCase(),process.execPath.toLowerCase());
  const second=await readControlProcessIdentity(process.pid);assert.deepEqual(second,current);
  let executed=0;
  const unavailable=await readControlProcessIdentity(process.pid,{platform:'win32',run:async(file,args,options)=>{
    executed++;assert.equal(options.windowsHide,true);assert.equal(options.env.CLW_APP_CONTROL_OWNER_PID,String(process.pid));
    assert.equal(Buffer.from(args[4],'base64').toString('utf16le'),PROCESS_IDENTITY_SCRIPT);throw Object.assign(Error('fixture denied'),{code:'EPERM'});
  }});
  assert.equal(executed,1);assert.equal(unavailable.state,'unknown');
});

test('actual repository control path accepts Modify without WRITE_OWNER and preserves owner and surrounding profile',
  {skip:process.platform!=='win32'},async t=>{
  const parent=path.resolve('.local/product-control-20261006/acl-app-path');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'modify-fixture-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const profile=path.join(root,'profile'),directory=path.join(profile,'control'),chromium=path.join(profile,'Chromium');
  await fs.mkdir(directory,{recursive:true});await fs.mkdir(chromium);
  const initial=await protectControlDirectory(directory),sid=initial.user_sid;
  const setup=String.raw`
$ErrorActionPreference = 'Stop'
$directory = [Environment]::GetEnvironmentVariable('CLW_APP_CONTROL_DIRECTORY', 'Process')
$sidText = [Environment]::GetEnvironmentVariable('CLW_APP_CONTROL_USER_SID', 'Process')
$sid = [Security.Principal.SecurityIdentifier]::new($sidText)
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
$owned = [IO.Directory]::GetAccessControl($directory, $sections)
if ($owned.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sidText) {
  $owned.SetOwner($sid)
  [IO.Directory]::SetAccessControl($directory, $owned)
}
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::TakeOwnership, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny))
[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Modify, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
foreach ($trusted in @('S-1-5-18','S-1-5-32-544')) {
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($trusted), [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
}
[IO.Directory]::SetAccessControl($directory, $acl)
$verified = [IO.Directory]::GetAccessControl($directory, $sections)
if ($verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sidText) { throw 'fixture_owner_changed' }
$rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $sidText -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::TakeOwnership })) { throw 'fixture_WRITE_OWNER_not_denied' }
[Console]::WriteLine($verified.GetSecurityDescriptorSddlForm($sections))
foreach ($relative in @('..','..\Chromium')) {
  $sibling = [IO.Path]::GetFullPath([IO.Path]::Combine($directory, $relative))
  [Console]::WriteLine([IO.Directory]::GetAccessControl($sibling, $sections).GetSecurityDescriptorSddlForm($sections))
}`;
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const options={windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:32768,env:{...process.env,CLW_APP_CONTROL_DIRECTORY:directory,CLW_APP_CONTROL_USER_SID:sid}};
  const configured=await runNative(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(setup,'utf16le').toString('base64')],options);
  const before=configured.stdout.trim().split(/\r?\n/);assert.equal(before.length,3);assert.ok(before[0].includes('(D;'));
  await fs.writeFile(path.join(directory,'existing-private-receipt.json'),'{}');
  const protection=await protectControlDirectory(directory);assert.equal(protection.verified,true);assert.equal(protection.owner_sid,sid);
  const verify=String.raw`
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
$directory = [Environment]::GetEnvironmentVariable('CLW_APP_CONTROL_DIRECTORY', 'Process')
foreach ($relative in @('..','..\Chromium')) {
  $sibling = [IO.Path]::GetFullPath([IO.Path]::Combine($directory, $relative))
  [Console]::WriteLine([IO.Directory]::GetAccessControl($sibling, $sections).GetSecurityDescriptorSddlForm($sections))
}`;
  const verified=await runNative(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(verify,'utf16le').toString('base64')],options);
  assert.deepEqual(verified.stdout.trim().split(/\r?\n/),before.slice(1));
  assert.equal(await fs.readFile(path.join(directory,'existing-private-receipt.json'),'utf8'),'{}');
});

test('ambiguous SID, failed native command and unverified ACL fail closed',async t=>{
  const root=await folder(t),sid='S-1-5-21-1-2-3-1001';
  let calls=0;
  await assert.rejects(protectControlDirectory(path.join(root,'ambiguous'),{platform:'win32',run:async()=>{calls++;return {stdout:sid+' S-1-5-21-4-5-6-1002'};}}),{code:'app_control_private_directory_unavailable'});
  assert.equal(calls,1);
  await assert.rejects(protectControlDirectory(path.join(root,'denied'),{platform:'win32',run:async()=>{throw Object.assign(Error('native denied'),{code:'EPERM'});}}),{code:'app_control_private_directory_unavailable'});
  await assert.rejects(protectControlDirectory(path.join(root,'unverified'),{platform:'win32',run:async file=>file.endsWith('whoami.exe')?{stdout:sid}:{stdout:'{"verified":false}'}}),{code:'app_control_private_directory_unavailable'});
});

test('protection failure creates no endpoint descriptor or dispatch activity',async t=>{
  const root=await folder(t),profile=path.join(root,'profile');let dispatched=0;
  for(const protectDirectory of [async()=>({verified:false}),async()=>{throw Object.assign(Error('private unavailable'),{code:'fixture_private_unavailable'});}]){
    await assert.rejects(startAppControl({root,profile,instanceId:'private-failed-instance',snapshot:async()=>({}),dispatch:async()=>{dispatched++;},protectDirectory}));
    await assert.rejects(fs.stat(path.join(profile,'control','app-control.json')),{code:'ENOENT'});
  }
  assert.equal(dispatched,0);
});

test('control directory junction or symlink is rejected before native ACL operations',async t=>{
  const root=await folder(t),target=path.join(root,'unrelated'),directory=path.join(root,'control');let executed=0;
  await fs.mkdir(target);await fs.symlink(target,directory,process.platform==='win32'?'junction':'dir');
  await assert.rejects(protectControlDirectory(directory,{run:async()=>{executed++;}}),{code:'app_control_private_directory_reparse'});
  assert.equal(executed,0);assert.deepEqual(await fs.readdir(target),[]);
});

test('actual OS protection verifies private control files and leaves profile and Chromium ACLs unchanged',async t=>{
  const root=await folder(t),profile=path.join(root,'profile'),chromium=path.join(profile,'Chromium'),directory=path.join(profile,'control');
  await fs.mkdir(chromium,{recursive:true});await fs.mkdir(directory);await fs.writeFile(path.join(directory,'previous-receipt.json'),'{}');
  async function siblingACL(){
    if(process.platform!=='win32')return [(await fs.stat(profile)).mode,(await fs.stat(chromium)).mode];
    const text=String.raw`
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
foreach ($directory in @([Environment]::GetEnvironmentVariable('CLW_CONTROL_PROFILE', 'Process'), [Environment]::GetEnvironmentVariable('CLW_CONTROL_CHROMIUM', 'Process'))) {
  [Console]::WriteLine([IO.Directory]::GetAccessControl($directory, $sections).GetSecurityDescriptorSddlForm($sections))
}`;
    const output=await runNative(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(text,'utf16le').toString('base64')],
      {windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:32768,env:{...process.env,CLW_CONTROL_PROFILE:profile,CLW_CONTROL_CHROMIUM:chromium}});
    return output.stdout.trim();
  }
  const before=await siblingACL(),protection=await protectControlDirectory(directory);
  assert.equal(protection.verified,true);assert.deepEqual(await siblingACL(),before);
  assert.equal(await fs.readFile(path.join(directory,'previous-receipt.json'),'utf8'),'{}');
  if(process.platform==='win32'){
    assert.equal(protection.scheme,'windows-dacl');assert.match(protection.user_sid,/^S-\d+-\d+(?:-\d+)+$/);
    assert.ok(protection.allowed_sids.includes('S-1-5-18'));assert.ok(protection.allowed_sids.includes('S-1-5-32-544'));
    await fs.mkdir(path.join(directory,'unexpected-subdirectory'));
    await assert.rejects(protectControlDirectory(directory),{code:'app_control_private_directory_unavailable'});
  }else{
    assert.equal(protection.scheme,'posix-mode');assert.equal((await fs.stat(directory)).mode&0o777,0o700);
  }
});
