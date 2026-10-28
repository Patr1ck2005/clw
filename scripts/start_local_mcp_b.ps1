param([switch]$CheckOnly,[string]$PythonExecutable,[ValidateRange(1,3)][int]$HealthWaitAttempts=1)

function Wait-ClwTunnelHealth {
  # A live original owner is never restarted for a transient health failure.
  for ($Attempt=1; $Attempt -le $HealthWaitAttempts; $Attempt++) {
    $Report=& $Tunnel.binaryPath health --json --url-file $HealthFile --require-control-plane-poll 2>$null
    $HealthExit=$LASTEXITCODE
    if ($HealthExit -eq 0 -or $Attempt -eq $HealthWaitAttempts) { return $HealthExit }
    Start-Sleep -Seconds (2*$Attempt)
  }
}

# Capture the private native JSON in this process; never write argv to support logs.
function Get-ClwNativeInventory {
  param([string[]]$Names=@('tunnel-client.exe'),[int]$ProcessId=0,[switch]$BackendListeners)
  $Executable=$PythonExecutable
  if (!$Executable) {$Executable=(Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source}
  if (!$Executable -or !(Test-Path -LiteralPath $Executable -PathType Leaf)) {throw 'Native process ownership is unavailable.'}
  $Reader=Join-Path $PSScriptRoot 'native_tunnel_processes.py'
  $ReaderArguments=@('-B',$Reader)
  if ($BackendListeners) {$ReaderArguments+='--backend-listeners'} else {
    foreach ($Name in $Names) {$ReaderArguments+=@('--name',$Name)}
    if ($PSBoundParameters.ContainsKey('ProcessId')) {
      if ($ProcessId -le 0) {throw 'Native process ownership is unavailable.'}
      $ReaderArguments+=@('--pid',([string]$ProcessId))
    }
    $ReaderArguments+='--with-command-line'
  }
  $Raw=& $Executable @ReaderArguments 2>$null
  if ($LASTEXITCODE -ne 0) {throw 'Native process ownership is unavailable.'}
  try {$Snapshot=($Raw -join "`n") | ConvertFrom-Json -ErrorAction Stop} catch {throw 'Native process ownership is unavailable.'}
  if ($Snapshot.protocol -ne 1 -or $Snapshot.complete -ne $true) {throw 'Native process ownership is unavailable.'}
  if ($BackendListeners) {
    if (!$Snapshot.server -or $Snapshot.listeners -isnot [Array]) {throw 'Native process ownership is unavailable.'}
  } elseif ($Snapshot.rows -isnot [Array]) {throw 'Native process ownership is unavailable.'}
  return $Snapshot
}

function Assert-ClwUnionAbsent {
  $Presence=[Net.Sockets.TcpClient]::new()
  try {
    $Connection=$Presence.ConnectAsync('127.0.0.1',18945)
    try {
      if (!$Connection.Wait(3000) -or $Presence.Connected) { throw 'Shared MCP listener presence is unknown or occupied; no second service was started.' }
    } catch {
      $Cause=$_.Exception
      while ($Cause.InnerException) { $Cause=$Cause.InnerException }
      if ($Cause -isnot [Net.Sockets.SocketException] -or $Cause.SocketErrorCode -ne [Net.Sockets.SocketError]::ConnectionRefused) { throw 'Shared MCP listener presence is unknown or occupied; no second service was started.' }
    }
  } finally { $Presence.Dispose() }
}

$ErrorActionPreference='Stop'
if (!$PythonExecutable) {$PythonExecutable=(Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source}
if (!$PythonExecutable -or !(Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {throw 'Native process ownership is unavailable.'}
$ProjectRoot=Split-Path -Parent $PSScriptRoot
$BridgeHome=Join-Path $ProjectRoot '.local\codex-web-bridge'
$AccountHome=Join-Path $ProjectRoot '.local\account-b-tunnel'
$ProfileFile=Join-Path $AccountHome 'profiles\webcodex-account-b.yaml'
$Settings=Get-Content -LiteralPath (Join-Path $BridgeHome 'settings.json') -Raw | ConvertFrom-Json
if (!$Settings.enabled -or $Settings.transport -ne 'shared-mcp') { throw 'Shared Local-MCP-B is not configured.' }
$Tunnel=$Settings.tunnel
$ProxyUrl='http://127.0.0.1:17890'
$env:HTTP_PROXY=$ProxyUrl;$env:HTTPS_PROXY=$ProxyUrl;$env:ALL_PROXY=$ProxyUrl;$env:NO_PROXY='127.0.0.1,localhost'
$UnionUrl='http://127.0.0.1:18945'
$DeploymentFile=Join-Path $BridgeHome 'shared-entry.json'
$HealthFile=Join-Path $AccountHome 'health-url.txt'
$RecoveryMutex=[Threading.Mutex]::new($false,('Local\CLW-SharedMCP-'+[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant()))).Substring(0,16)))
$RecoveryLocked=$false
try {
try {$RecoveryLocked=$RecoveryMutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$RecoveryLocked=$true}
if (!$RecoveryLocked) { throw 'Another original shared MCP recovery is running. Wait for its result; no second service was started.' }
$UnionHealth=$null
try { $UnionHealth=Invoke-RestMethod -Uri ($UnionUrl+'/healthz') -NoProxy -TimeoutSec 3 } catch {}
$Running=@((Get-ClwNativeInventory).rows | Where-Object { $_.CommandLine -like '*--profile webcodex-account-b *' -and $_.CommandLine -like ('*'+$AccountHome+'\profiles*') })
$Saved=$null
if ($Running.Count -gt 0) {
  $Saved=if (Test-Path -LiteralPath $DeploymentFile) {Get-Content -LiteralPath $DeploymentFile -Raw | ConvertFrom-Json} else {$null}
  if ($Running.Count -ne 1 -or !$Saved -or $Saved.tunnelPid -ne $Running[0].ProcessId) {
    throw 'An existing B tunnel has a different owner/state. Keep it intact; pause the team before maintenance.'
  }
  if ($UnionHealth) {
    if ($UnionHealth.pid -ne $Saved.unionPid -or $UnionHealth.service -ne 'clw-mcp-union') { throw 'Existing union identity changed; reconcile it before restart.' }
    $HealthExit=Wait-ClwTunnelHealth
    exit $HealthExit
  }
  if ($CheckOnly) { throw 'The original B tunnel is running, but its shared MCP entry is unavailable. Restore the shared entry; keep the tunnel intact.' }
}
elseif ($CheckOnly) { throw 'The unified B tunnel is not running.' }

# Discover public listener metadata and reuse only the existing auth file path.
$ServerInfo=Get-ClwNativeInventory -BackendListeners
$Server=$ServerInfo.server
$Listener=@($ServerInfo.listeners)
if ($Listener.Count -ne 1) { throw 'WebCodex loopback listener is ambiguous.' }
$Target='http://127.0.0.1:'+ $Listener[0].LocalPort +'/mcp'
$OldProfile=Get-Content -LiteralPath $ProfileFile -Raw
$AuthMatch=[regex]::Match($OldProfile,'Authorization:\s*"file:([^"\r\n]+)"')
if (!$AuthMatch.Success -or !(Test-Path -LiteralPath $AuthMatch.Groups[1].Value -PathType Leaf)) { throw 'Existing WebCodex authorization file reference is unavailable.' }
$AuthFile=$AuthMatch.Groups[1].Value
$UnionConfigFile=Join-Path $BridgeHome 'union-config.json'
$UnionConfig=@{target=$Target;authorizationFile=$AuthFile;port=18945;statusFile=(Join-Path $BridgeHome 'union-status.json')}
if ($UnionHealth) {
  $OldConfig=Get-Content -LiteralPath $UnionConfigFile -Raw | ConvertFrom-Json
  if ($UnionHealth.service -ne 'clw-mcp-union' -or $OldConfig.target -ne $Target -or $OldConfig.authorizationFile -ne $AuthFile) { throw 'Existing union identity changed; reconcile it before restart.' }
} else {
  # A live tunnel is not evidence that Union is alive. Recover only a positively
  # absent original service, preserving the tunnel and all independent Jobs.
  $OwnedUnion=@((Get-ClwNativeInventory -Names @('bun.exe')).rows | Where-Object { $_.CommandLine.Contains((Join-Path $ProjectRoot 'apps\codex-web-bridge\serve-union.cjs')) })
  if ($OwnedUnion.Count -ne 0) { throw 'The shared MCP process still exists but is not responsive. Preserve its original operations before maintenance.' }
  Assert-ClwUnionAbsent
  if ($Running.Count -eq 1) {
    $OldConfig=Get-Content -LiteralPath $UnionConfigFile -Raw | ConvertFrom-Json
    if ($Saved.url -ne ($UnionUrl+'/mcp') -or $Saved.upstream -ne $Target -or $OldConfig.target -ne $Target -or $OldConfig.authorizationFile -ne $AuthFile -or $OldConfig.port -ne 18945) { throw 'Original shared MCP configuration changed; the existing tunnel was retained.' }
    $OriginalB=@((Get-ClwNativeInventory).rows | Where-Object { $_.ProcessId -eq $Running[0].ProcessId })
    if ($OriginalB.Count -ne 1 -or $OriginalB[0].CreationFiletime -ne $Running[0].CreationFiletime -or $OriginalB[0].CommandLine -ne $Running[0].CommandLine) { throw 'Original B tunnel identity changed during recovery; no mutation.' }
  }
  [IO.File]::WriteAllText($UnionConfigFile,($UnionConfig | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $Bun=Join-Path $ProjectRoot '.local\runtimes\bun-1.4.0\bun.exe'
  $UnionScript=Join-Path $ProjectRoot 'apps\codex-web-bridge\serve-union.cjs'
  $env:HTTP_PROXY=$ProxyUrl;$env:HTTPS_PROXY=$ProxyUrl;$env:ALL_PROXY=$ProxyUrl;$env:NO_PROXY='127.0.0.1,localhost'
  $UnionProcess=Start-Process -FilePath $Bun -ArgumentList @('run',('"'+$UnionScript+'"'),('"'+$UnionConfigFile+'"')) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $BridgeHome 'union.stdout.log') -RedirectStandardError (Join-Path $BridgeHome 'union.stderr.log')
  for($Probe=0;$Probe -lt 40;$Probe++) {
    try {$UnionHealth=Invoke-RestMethod -Uri ($UnionUrl+'/healthz') -NoProxy -TimeoutSec 2;break} catch {Start-Sleep -Milliseconds 250}
  }
  if (!$UnionHealth -or $UnionHealth.pid -ne $UnionProcess.Id) { throw 'Union did not become ready; the B tunnel was not started.' }
  if ($Running.Count -eq 1) {
    $OriginalB=@((Get-ClwNativeInventory).rows | Where-Object { $_.ProcessId -eq $Running[0].ProcessId })
    if ($OriginalB.Count -ne 1 -or $OriginalB[0].CreationFiletime -ne $Running[0].CreationFiletime -or $OriginalB[0].CommandLine -ne $Running[0].CommandLine) { throw 'Original B tunnel identity changed after shared recovery; the new shared process was retained for reconciliation.' }
    $Saved.unionPid=$UnionHealth.pid
    $Saved.at=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($DeploymentFile,($Saved | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    Write-Output 'Original A/B tunnels retained; their absent shared MCP entry was restored without starting project work.'
    $HealthExit=Wait-ClwTunnelHealth
    exit $HealthExit
  }
}
# The Union HTTP listener can be live while its upstream MCP is still starting.
# Verify the original authenticated route before the tunnel's startup probe.
$McpReadyCode=@'
import sys
sys.path.insert(0,sys.argv[1])
from webcodex_backend import wait_mcp_ready
try:
    wait_mcp_ready(sys.argv[2],timeout=10,union=True)
except Exception:
    print('Shared MCP initialization is not ready; the original services and Jobs were retained.',file=sys.stderr)
    sys.exit(1)
'@
& $PythonExecutable -X utf8 -B -c $McpReadyCode $PSScriptRoot $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Shared MCP startup is not ready; B was not started.' }
$Quote={param([string]$Value) ConvertTo-Json -InputObject ($Value -replace '\\','/') -Compress}
$Profile=@"
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "$($Tunnel.tunnelId)"
  api_key: $(& $Quote ('file:'+$Tunnel.runtimeKeyFile))
health:
  listen_addr: "127.0.0.1:0"
  url_file: $(& $Quote $HealthFile)
admin_ui:
  open_browser: false
log:
  level: info
  format: json
  file: $(& $Quote (Join-Path $AccountHome 'tunnel.log'))
mcp:
  server_urls:
    - channel: main
      url: "$UnionUrl/mcp"
  extra_headers:
    Authorization: $(& $Quote ('file:'+$AuthFile))
"@
if (!(Test-Path -LiteralPath ($ProfileFile+'.pre-union'))) { Copy-Item -LiteralPath $ProfileFile -Destination ($ProfileFile+'.pre-union') }
[IO.File]::WriteAllText($ProfileFile,$Profile,[Text.UTF8Encoding]::new($false))
$TunnelArgs=@('run','--profile','webcodex-account-b','--profile-dir',('"'+(Split-Path -Parent $ProfileFile)+'"'),'--control-plane.http-proxy',$ProxyUrl,'--harpoon.http-proxy',$ProxyUrl)
$TunnelProcess=Start-Process -FilePath $Tunnel.binaryPath -ArgumentList $TunnelArgs -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $AccountHome 'shared.stdout.log') -RedirectStandardError (Join-Path $AccountHome 'shared.stderr.log')
$Deployment=@{at=[DateTime]::UtcNow.ToString('o');tunnelPid=$TunnelProcess.Id;unionPid=$UnionHealth.pid;url=($UnionUrl+'/mcp');upstream=$Target;proxy=$ProxyUrl;singlePoller=$true}
[IO.File]::WriteAllText($DeploymentFile,($Deployment | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output 'Local-MCP-B unified entry started with its existing identity and mandatory VPN. Check tunnel health and the visible connector catalog.'
} finally {
  if ($RecoveryLocked) {$RecoveryMutex.ReleaseMutex()}
  $RecoveryMutex.Dispose()
}
