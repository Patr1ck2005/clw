'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile:execFileCallback}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const execFile=promisify(execFileCallback);
const SID_PATTERN=/^S-\d+-\d+(?:-\d+)+$/;
const processLifetimeToken=randomUUID();

const PROCESS_IDENTITY_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
$processIdText = [Environment]::GetEnvironmentVariable('CLW_APP_CONTROL_OWNER_PID', 'Process')
if ($processIdText -notmatch '^[1-9][0-9]{0,9}$') { throw 'private_process_id' }
$processIdValue = [int]::Parse($processIdText)
$original = [Diagnostics.Process]::GetProcessById($processIdValue)
$created = $original.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
$image = $original.MainModule.FileName
$current = [Diagnostics.Process]::GetProcessById($processIdValue)
if ($current.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -ne $created -or $current.MainModule.FileName -ne $image) { throw 'private_process_changed' }
[Console]::WriteLine($created)
[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($image)))
`;

function pidPresence(pid){
  try{process.kill(pid,0);return 'alive';}
  catch(error){return error.code==='ESRCH'?'absent':'unknown';}
}
async function readControlProcessIdentity(pid,{platform=process.platform,run=execFile,systemRoot=process.env.SystemRoot||'C:\\Windows'}={}){
  if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647)return {state:'unknown',reason:'process_id_invalid'};
  const presence=pidPresence(pid);
  if(presence==='absent')return {state:'absent'};
  try{
    if(platform==='win32'){
      const output=await run(path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
        ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(PROCESS_IDENTITY_SCRIPT,'utf16le').toString('base64')],
        {windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:16*1024,env:{...process.env,CLW_APP_CONTROL_OWNER_PID:String(pid)}});
      const lines=String(output.stdout).trim().split(/\r?\n/);
      if(lines.length!==2||!/^\d{16,20}$/.test(lines[0])||!/^[A-Za-z0-9+/]+={0,2}$/.test(lines[1]))throw Error('process identity invalid');
      const executable=Buffer.from(lines[1],'base64').toString('utf8');
      if(!path.isAbsolute(executable)||executable.includes('\0'))throw Error('process image invalid');
      return {state:'alive',identity:{kind:'windows-filetime',pid,creation_filetime:lines[0],executable}};
    }
    if(platform==='linux'){
      const first=await fs.readFile('/proc/'+pid+'/stat','utf8');
      const start=first.slice(first.lastIndexOf(') ')+2).trim().split(/\s+/)[19];
      const executable=await fs.readlink('/proc/'+pid+'/exe'),bootId=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
      const second=await fs.readFile('/proc/'+pid+'/stat','utf8');
      const currentStart=second.slice(second.lastIndexOf(') ')+2).trim().split(/\s+/)[19];
      if(!/^\d+$/.test(start)||currentStart!==start||!/^[a-f0-9-]{36}$/.test(bootId))throw Error('process identity changed');
      return {state:'alive',identity:{kind:'linux-proc',pid,start_ticks:start,boot_id:bootId,executable}};
    }
    if(pid===process.pid)return {state:'alive',identity:{kind:'current-process-token',pid,lifetime_token:processLifetimeToken,executable:process.execPath}};
  }catch{if(pidPresence(pid)==='absent')return {state:'absent'};}
  return {state:'unknown',reason:'process_identity_unavailable'};
}

// This is fixed program text. File paths and the current SID enter through the
// child process environment, never through PowerShell command interpolation.
const PRIVATE_DIRECTORY_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
$directory = [Environment]::GetEnvironmentVariable('CLW_APP_CONTROL_DIRECTORY', 'Process')
$userSidText = [Environment]::GetEnvironmentVariable('CLW_APP_CONTROL_USER_SID', 'Process')
if ([string]::IsNullOrWhiteSpace($directory) -or $userSidText -notmatch '^S-\d+-\d+(-\d+)+$') { throw 'private_directory_input' }
$directoryAttributes = [IO.File]::GetAttributes($directory)
if (-not ($directoryAttributes -band [IO.FileAttributes]::Directory) -or ($directoryAttributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'private_directory_reparse' }
$userSid = [Security.Principal.SecurityIdentifier]::new($userSidText)
$allowedSet = [Collections.Generic.HashSet[string]]::new()
[void]$allowedSet.Add($userSidText)
[void]$allowedSet.Add('S-1-5-18')
[void]$allowedSet.Add('S-1-5-32-544')
$allowed = @($allowedSet)
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
$originalOwner = [IO.Directory]::GetAccessControl($directory, $sections).GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($originalOwner -notin $allowed) { throw 'private_directory_owner_untrusted' }
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$directoryAcl = [Security.AccessControl.DirectorySecurity]::new()
$directoryAcl.SetAccessRuleProtection($true, $false)
foreach ($sidText in $allowed) {
  $sid = [Security.Principal.SecurityIdentifier]::new($sidText)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  [void]$directoryAcl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($directory, $directoryAcl)
if ([IO.Directory]::GetDirectories($directory).Length -ne 0) { throw 'private_directory_child' }
$children = @([IO.Directory]::GetFiles($directory))
foreach ($child in $children) {
  if ([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint) { throw 'private_directory_child' }
  $childOwner = [IO.File]::GetAccessControl($child, $sections).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($childOwner -notin $allowed) { throw 'private_file_owner_untrusted' }
  $fileAcl = [Security.AccessControl.FileSecurity]::new()
  $fileAcl.SetAccessRuleProtection($false, $false)
  [IO.File]::SetAccessControl($child, $fileAcl)
}
$verified = [IO.Directory]::GetAccessControl($directory, $sections)
if (-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $originalOwner) { throw 'private_directory_owner' }
$rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $allowed.Count) { throw 'private_directory_rule_count' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.IsInherited -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'private_directory_rule' }
}
foreach ($child in $children) {
  $childAcl = [IO.File]::GetAccessControl($child, $sections)
  if ($childAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'private_file_owner' }
  $childRules = @($childAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($childAcl.AreAccessRulesProtected -or $childRules.Count -ne $allowed.Count) { throw 'private_file_inheritance' }
  foreach ($rule in $childRules) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or -not $rule.IsInherited) { throw 'private_file_rule' }
  }
}
[Console]::WriteLine('{"scheme":"windows-dacl","verified":true,"user_sid":"' + $userSidText + '","owner_sid":"' + $originalOwner + '","allowed_sids":["' + ($allowed -join '","') + '"]}')
`;

async function protectControlDirectory(directory,{platform=process.platform,run=execFile,systemRoot=process.env.SystemRoot||'C:\\Windows'}={}){
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Object.assign(new Error('app_control_private_directory_invalid'),{code:'app_control_private_directory_invalid'});
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const info=await fs.lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw Object.assign(new Error('app_control_private_directory_reparse'),{code:'app_control_private_directory_reparse'});
  if(platform!=='win32'){
    await fs.chmod(directory,0o700);
    if(((await fs.stat(directory)).mode&0o777)!==0o700)throw Object.assign(new Error('app_control_private_directory_unavailable'),{code:'app_control_private_directory_unavailable'});
    return {scheme:'posix-mode',verified:true,mode:'0700'};
  }
  try{
    const nativeFolder=path.join(systemRoot,'System32');
    const identity=await run(path.join(nativeFolder,'whoami.exe'),['/user','/fo','csv','/nh'],
      {windowsHide:true,encoding:'utf8',timeout:5000,maxBuffer:16*1024});
    const matches=String(identity.stdout).match(/S-\d+-\d+(?:-\d+)+/g)||[];
    if(matches.length!==1||!SID_PATTERN.test(matches[0]))throw Error('current SID unavailable');
    const userSid=matches[0],encoded=Buffer.from(PRIVATE_DIRECTORY_SCRIPT,'utf16le').toString('base64');
    const result=await run(path.join(nativeFolder,'WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
      {windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:16*1024,
        env:{...process.env,CLW_APP_CONTROL_DIRECTORY:directory,CLW_APP_CONTROL_USER_SID:userSid}});
    const protection=JSON.parse(String(result.stdout).trim());
    if(protection.scheme!=='windows-dacl'||protection.verified!==true||protection.user_sid!==userSid
      ||!Array.isArray(protection.allowed_sids)||protection.allowed_sids.length!==new Set([userSid,'S-1-5-18','S-1-5-32-544']).size
      ||new Set(protection.allowed_sids).size!==protection.allowed_sids.length
      ||protection.allowed_sids.some(sid=>![userSid,'S-1-5-18','S-1-5-32-544'].includes(sid))
      ||!protection.allowed_sids.includes(protection.owner_sid))throw Error('private ACL unverified');
    return protection;
  }catch(error){throw Object.assign(new Error('app_control_private_directory_unavailable'),{code:'app_control_private_directory_unavailable',
    detail:typeof error?.code==='string'?error.code:'acl_unverified',cause:error});}
}

module.exports={protectControlDirectory,readControlProcessIdentity,PRIVATE_DIRECTORY_SCRIPT,PROCESS_IDENTITY_SCRIPT};
