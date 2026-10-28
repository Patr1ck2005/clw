param(
  [switch]$Restart,
  [int]$ExpectedOwnerPid=0
)
function Test-ClwEndpointListening {
  param([Uri]$Endpoint)
  $Client=[Net.Sockets.TcpClient]::new()
  try {
    $Connect=$Client.ConnectAsync($Endpoint.Host,$Endpoint.Port)
    try {
      if (!$Connect.Wait(5000)) { throw 'Native endpoint presence is unknown; no mutation.' }
    } catch {
      $Cause=$_.Exception
      while ($Cause.InnerException) { $Cause=$Cause.InnerException }
      if ($Cause -is [Net.Sockets.SocketException] -and $Cause.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $false }
      throw 'Native endpoint presence is unknown; no mutation.'
    }
    return $Client.Connected
  } finally { $Client.Dispose() }
}

function Get-ClwTunnelIdle {
  param([string]$Account,[int]$OwnerPid,[string]$TunnelId,[string]$Binary,[string]$Profile,[switch]$NamedProfile)
  $Process=Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid"
  $ProfileMatch=$Process -and $Process.CommandLine -and $Process.CommandLine.Contains($Profile)
  if ($NamedProfile) { $ProfileMatch=$Process -and $Process.CommandLine -match '(?:^|\s)--profile\s+webcodex-account-b\s' -and $Process.CommandLine.Contains((Split-Path -Parent $Profile)) }
  if (!$Process -or $Process.ExecutablePath -ne $Binary -or !$ProfileMatch -or $TunnelId -notmatch '^tunnel_[a-f0-9]{32}$') { throw "Original $Account tunnel owner is unverified; no mutation." }
  $Reference=Join-Path $Root ('.local\account-'+$Account.ToLowerInvariant()+'-tunnel\health-url.txt')
  $Text=[IO.File]::ReadAllText($Reference).Trim()
  $Match=[regex]::Match($Text,'^http://127\.0\.0\.1:([1-9][0-9]{0,4})/?$')
  if ($Text.Length -gt 256 -or !$Match.Success -or [int]$Match.Groups[1].Value -gt 65535) { throw "Original $Account health reference is invalid; no mutation." }
  $Origin=$Text.TrimEnd('/')
  $Probe=Invoke-WebRequest -Uri ($Origin+'/readyz') -NoProxy -TimeoutSec 5 -MaximumRedirection 0
  if ($Probe.StatusCode -ne 200 -or $Probe.Content.Trim() -ne 'ready') { throw "Original $Account tunnel is not ready; no mutation." }
  $Metrics=Invoke-WebRequest -Uri ($Origin+'/metrics') -NoProxy -TimeoutSec 5 -MaximumRedirection 0
  if ($Metrics.StatusCode -ne 200 -or [Text.Encoding]::UTF8.GetByteCount($Metrics.Content) -gt 2097152) { throw "Original $Account tunnel metrics are unavailable; no mutation." }
  $Identities=@([regex]::Matches($Metrics.Content,'tunnel_id="([^"\r\n]+)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
  if ($Identities.Count -ne 1 -or $Identities[0] -ne $TunnelId) { throw "Original $Account tunnel metrics identity changed; no mutation." }
  $Workers=[regex]::Matches($Metrics.Content,'(?m)^dispatcher_worker_pool_occupancy(?:\{[^\r\n]*\})?\s+([0-9]+(?:\.[0-9]+)?)(?:\s+[0-9]+)?\s*$')
  if ($Workers.Count -ne 1) { throw "Original $Account tunnel activity is unknown; no mutation." }
  $Current=Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid"
  if (!$Current -or $Current.CreationDate -ne $Process.CreationDate -or $Current.CommandLine -ne $Process.CommandLine -or [IO.File]::ReadAllText($Reference).Trim() -ne $Text) { throw "Original $Account tunnel identity changed during inspection; no mutation." }
  return [ordered]@{account=$Account;pid=$OwnerPid;activeWorkers=[double]::Parse($Workers[0].Groups[1].Value,[Globalization.CultureInfo]::InvariantCulture)}
}
# Default is read-only inspection. -Restart is an explicit operator action;
# invoking it still requires the caller's normal approval process.
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw 'This maintenance command requires PowerShell 7 (pwsh) for proxy-free loopback checks; no mutation was made.'
}
$Root=Split-Path -Parent $PSScriptRoot
$HomePath=Join-Path $Root '.local\codex-web-bridge'
$ConfigPath=Join-Path $HomePath 'union-config.json'
$OwnerPath=Join-Path $HomePath 'shared-entry.json'
$Bun=Join-Path $Root '.local\runtimes\bun-1.4.0\bun.exe'
$ServiceScript=Join-Path $Root 'apps\codex-web-bridge\serve-union.cjs'
$NativeScript=Join-Path $Root 'apps\codex-web-bridge\upstream\src\cli.ts'
$Config=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$Saved=Get-Content -LiteralPath $OwnerPath -Raw | ConvertFrom-Json
$Base='http://127.0.0.1:'+ $Config.port
if ($Saved.url -ne ($Base+'/mcp')) { throw 'Shared entry URL changed; no mutation.' }
$Health=Invoke-RestMethod -Uri ($Base+'/healthz') -NoProxy -TimeoutSec 5
if ($Health.service -ne 'clw-mcp-union' -or $Health.pid -ne $Saved.unionPid) { throw 'Union owner changed; no mutation.' }
$Owner=Get-CimInstance Win32_Process -Filter "ProcessId=$($Health.pid)"
if (!$Owner -or $Owner.ExecutablePath -ne $Bun -or !$Owner.CommandLine.Contains($ServiceScript) -or !$Owner.CommandLine.Contains($ConfigPath)) { throw 'Union executable ownership unverified; no mutation.' }
$OwnedProcesses=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($Owner.ProcessId)")
# Windows can attach a console host to this hidden process. Its lifetime is
# managed by Windows; do not treat it as a tool provider or terminate it here.
$ConsolePath=Join-Path $env:SystemRoot 'System32\conhost.exe'
$Children=@($OwnedProcesses | Where-Object { $_.ExecutablePath -ne $ConsolePath })
foreach ($Child in $Children) {
  if ($Child.ExecutablePath -ne $Bun -or !$Child.CommandLine.Contains($NativeScript) -or $Child.CommandLine -notmatch '\bmcp\s+--contract\s+native\s+--broker-socket\b') { throw 'Unexpected service child; no mutation.' }
}
$Status=Get-Content -LiteralPath (Join-Path $HomePath 'status.json') -Raw | ConvertFrom-Json
$Endpoint=[Uri]$Status.endpoint
if ($Endpoint.Scheme -ne 'http' -or $Endpoint.Host -ne '127.0.0.1' -or $Endpoint.AbsolutePath -ne '/v1') { throw 'Native endpoint unverified; no mutation.' }
$NativeHealth=$null
$NativeOwnerAbsent=$false
if ($Status.state -eq 'stopped' -and !(Test-ClwEndpointListening $Endpoint)) {
  if ($Status.runtimePid -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($Status.runtimePid)")) { throw 'Stopped Native owner is still present; no mutation.' }
  $NativeOwnerAbsent=$true
} else {
  $NativeHealth=Invoke-RestMethod -Uri ($Endpoint.GetLeftPart('Authority')+'/healthz') -NoProxy -TimeoutSec 5
  if (!$Status.runtimePid -or $NativeHealth.pid -ne $Status.runtimePid) { throw 'Native owner changed; no mutation.' }
}
# Reuse the existing credential only in memory for read-only runtime metadata.
# No identity, tunnel profile, permissions or task authority is changed.
$Headers=@{Authorization=([IO.File]::ReadAllText($Config.authorizationFile).Trim());'mcp-protocol-version'='2026-07-28';'mcp-method'='tools/call';'mcp-name'='runtime_status'}
$Request=@{jsonrpc='2.0';id=('maintenance-'+[guid]::NewGuid().ToString());method='tools/call';params=@{name='runtime_status';arguments=@{compact=$true};_meta=@{'io.modelcontextprotocol/protocolVersion'='2026-07-28';'io.modelcontextprotocol/clientCapabilities'=@{}}}} | ConvertTo-Json -Depth 8 -Compress
try { $Runtime=Invoke-RestMethod -Uri ($Base+'/mcp') -Method Post -Headers $Headers -ContentType 'application/json' -Body $Request -NoProxy -TimeoutSec 10 }
finally { $Headers.Clear() }
if ($Runtime.error -or !$Runtime.result.structuredContent.success) { throw 'Runtime idle state unverified; no mutation.' }
$Jobs=$Runtime.result.structuredContent.output.jobs
if ($null -eq $Jobs.active_count) { throw 'Runtime Job count unavailable; no mutation.' }
$DbPath=Join-Path $Root '.local\harness\harness.sqlite3'
$Managed=$null
if ($NativeOwnerAbsent) {
  $Managed=@{inspection='not_required_owner_absent';historicalRequestsPreserved=$true}
} elseif (Test-Path -LiteralPath $DbPath) {
  $ManagedRaw=& python -B (Join-Path $PSScriptRoot 'inspect_managed_maintenance.py') $DbPath
  if ($LASTEXITCODE -ne 0) { throw 'Managed state unavailable; no mutation.' }
  $Managed=$ManagedRaw | ConvertFrom-Json
} elseif (!$NativeOwnerAbsent) { throw 'Managed state unavailable; no mutation.' }
# An owner may retire its local turn immediately after a browser binding error while
# ChatGPT keeps generating on the already submitted page. Zero local counters are
# then not proof that the shared tool service is safe to restart.
$UnsettledBrowserTabs=@($Status.browser.tabs | Where-Object { $null -ne $_ -and ($_.status -ne 'ready' -or $_.loading) })
$BrowserReady=$NativeOwnerAbsent -or ($Status.state -eq 'ready' -and $Status.browser.status -eq 'ready' -and !$Status.browser.loading -and $UnsettledBrowserTabs.Count -eq 0)
$NativeIdle=$NativeOwnerAbsent -or ($NativeHealth.active_http_turns -eq 0 -and $NativeHealth.active_browser_turns -eq 0)
# Paused historical requests remain in the ledger when the owning application is
# closed. They do not execute without that owner. Real shared calls are checked
# below on both tunnel dispatchers, the Union and the Runner instead.
$ManagedIdle=$NativeOwnerAbsent -or ($Managed -and $Managed.activeRuns -eq 0 -and $Managed.unsettledMaintenance -eq 0)
$AOwner=Get-Content -LiteralPath (Join-Path $Root '.local\account-a-tunnel\owner.json') -Raw | ConvertFrom-Json
$BSettings=Get-Content -LiteralPath (Join-Path $HomePath 'settings.json') -Raw | ConvertFrom-Json
$ATunnelArguments=@{Account='A';OwnerPid=$AOwner.pid;TunnelId=$AOwner.tunnelId;Binary=(Join-Path $env:LOCALAPPDATA 'WebCodex\tools\tunnel-client\0.0.12\windows-amd64\tunnel-client.exe');Profile=(Join-Path $Root '.local\account-a-tunnel\profile.yaml')}
$BTunnelArguments=@{Account='B';OwnerPid=$Saved.tunnelPid;TunnelId=$BSettings.tunnel.tunnelId;Binary=$BSettings.tunnel.binaryPath;Profile=(Join-Path $Root '.local\account-b-tunnel\profiles\webcodex-account-b.yaml');NamedProfile=$true}
$Tunnels=@((Get-ClwTunnelIdle @ATunnelArguments),(Get-ClwTunnelIdle @BTunnelArguments))
$UnionIdle=$Health.pendingNative -eq 0 -and ($null -eq $Health.activeRequests -or $Health.activeRequests -eq 0) -and ($null -eq $Health.activeUpstream -or $Health.activeUpstream -eq 0)
$Ready=$BrowserReady -and $NativeIdle -and $ManagedIdle -and $UnionIdle -and $Jobs.active_count -eq 0 -and @($Tunnels | Where-Object { $_.activeWorkers -ne 0 }).Count -eq 0
$Plan=[ordered]@{at=[DateTime]::UtcNow.ToString('o');canRestart=$Ready;nativeOwnerAbsent=$NativeOwnerAbsent;browserStatus=$Status.browser.status;unsettledBrowserTabs=$UnsettledBrowserTabs.Count;browserRequiresReconciliation=(-not $BrowserReady);unionPid=$Owner.ProcessId;ownedChildPids=@($Children | ForEach-Object ProcessId);tunnelPid=$Saved.tunnelPid;tunnels=$Tunnels;pendingNative=$Health.pendingNative;activeRequests=$Health.activeRequests;activeUpstream=$Health.activeUpstream;nativeHttpTurns=$NativeHealth.active_http_turns;nativeBrowserTurns=$NativeHealth.active_browser_turns;localJobs=$Jobs.active_count;managed=$Managed;modelSends=0;changesTunnel=$false}
if (!$Restart) { $Plan | ConvertTo-Json -Depth 5; exit 0 }
if (!$Ready -or $ExpectedOwnerPid -ne $Owner.ProcessId) {
  $Plan | ConvertTo-Json -Depth 5
  throw 'Maintenance is not idle or explicit expected owner is missing; no mutation.'
}
# Recheck the exact process creation identity immediately before the approved
# stop. Never terminate a reused PID, sibling, Runner, tunnel or browser owner.
$Current=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedOwnerPid"
if (!$Current -or $Current.CreationDate -ne $Owner.CreationDate -or $Current.CommandLine -ne $Owner.CommandLine) { throw 'Union identity changed during preflight; no mutation.' }
$FinalHealth=Invoke-RestMethod -Uri ($Base+'/healthz') -NoProxy -TimeoutSec 5
$FinalTunnels=@((Get-ClwTunnelIdle @ATunnelArguments),(Get-ClwTunnelIdle @BTunnelArguments))
if ($FinalHealth.pid -ne $ExpectedOwnerPid -or $FinalHealth.service -ne 'clw-mcp-union' -or $FinalHealth.pendingNative -ne 0 -or ($null -ne $FinalHealth.activeRequests -and $FinalHealth.activeRequests -ne 0) -or ($null -ne $FinalHealth.activeUpstream -and $FinalHealth.activeUpstream -ne 0) -or @($FinalTunnels | Where-Object { $_.activeWorkers -ne 0 }).Count -ne 0) { throw 'Shared entry became active during preflight; no mutation.' }
if ($NativeOwnerAbsent) {
  $FinalStatus=Get-Content -LiteralPath (Join-Path $HomePath 'status.json') -Raw | ConvertFrom-Json
  $NativeReturned=$FinalStatus.runtimePid -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($FinalStatus.runtimePid)")
  if ($FinalStatus.state -ne 'stopped' -or $FinalStatus.endpoint -ne $Status.endpoint -or $NativeReturned -or (Test-ClwEndpointListening $Endpoint)) { throw 'Native owner appeared during preflight; no mutation.' }
} else {
  $FinalNative=Invoke-RestMethod -Uri ($Endpoint.GetLeftPart('Authority')+'/healthz') -NoProxy -TimeoutSec 5
  $FinalStatus=Get-Content -LiteralPath (Join-Path $HomePath 'status.json') -Raw | ConvertFrom-Json
  if ($FinalNative.pid -ne $Status.runtimePid -or $FinalStatus.runtimePid -ne $Status.runtimePid -or $FinalStatus.endpoint -ne $Status.endpoint -or $FinalNative.active_http_turns -ne 0 -or $FinalNative.active_browser_turns -ne 0 -or $FinalStatus.state -ne 'ready' -or $FinalStatus.browser.status -ne 'ready' -or $FinalStatus.browser.loading -or @($FinalStatus.browser.tabs | Where-Object { $_.status -ne 'ready' -or $_.loading }).Count -ne 0) { throw 'Native or browser activity changed during preflight; no mutation.' }
}
$FinalHeaders=@{Authorization=([IO.File]::ReadAllText($Config.authorizationFile).Trim());'mcp-protocol-version'='2026-07-28';'mcp-method'='tools/call';'mcp-name'='runtime_status'}
try { $FinalRuntime=Invoke-RestMethod -Uri ($Base+'/mcp') -Method Post -Headers $FinalHeaders -ContentType 'application/json' -Body $Request -NoProxy -TimeoutSec 10 }
finally { $FinalHeaders.Clear() }
if ($FinalRuntime.error -or !$FinalRuntime.result.structuredContent.success -or $FinalRuntime.result.structuredContent.output.jobs.active_count -ne 0) { throw 'Runner activity changed during preflight; no mutation.' }
$LastOwner=Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedOwnerPid"
if (!$LastOwner -or $LastOwner.CreationDate -ne $Owner.CreationDate -or $LastOwner.CommandLine -ne $Owner.CommandLine) { throw 'Union identity changed before stop; no mutation.' }
Stop-Process -Id $ExpectedOwnerPid -ErrorAction Stop
Wait-Process -Id $ExpectedOwnerPid -Timeout 10 -ErrorAction SilentlyContinue
foreach ($Child in $Children) {
  $Remaining=Get-CimInstance Win32_Process -Filter "ProcessId=$($Child.ProcessId)"
  if ($Remaining -and $Remaining.CreationDate -eq $Child.CreationDate -and $Remaining.CommandLine -eq $Child.CommandLine) { Stop-Process -Id $Child.ProcessId -ErrorAction Stop }
}
$env:HTTP_PROXY='http://127.0.0.1:17890';$env:HTTPS_PROXY=$env:HTTP_PROXY;$env:ALL_PROXY=$env:HTTP_PROXY;$env:NO_PROXY='127.0.0.1,localhost'
$Started=Start-Process -FilePath $Bun -ArgumentList @('run',('"'+$ServiceScript+'"'),('"'+$ConfigPath+'"')) -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $HomePath 'union.stdout.log') -RedirectStandardError (Join-Path $HomePath 'union.stderr.log')
$Fresh=$null
for($i=0;$i -lt 40;$i++) {
  try { $Probe=Invoke-RestMethod -Uri ($Base+'/healthz') -NoProxy -TimeoutSec 2; if($Probe.pid -eq $Started.Id -and $Probe.service -eq 'clw-mcp-union'){$Fresh=$Probe;break} } catch {}
  Start-Sleep -Milliseconds 250
}
if (!$Fresh) { throw 'Updated union did not become ready. Original receipts retained; no alternate route or replay.' }
$Saved.unionPid=$Fresh.pid;$Saved.at=[DateTime]::UtcNow.ToString('o')
$Temporary=$OwnerPath+'.maintenance.tmp'
[IO.File]::WriteAllText($Temporary,($Saved | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $Temporary -Destination $OwnerPath -Force
$Plan.updatedUnionPid=$Fresh.pid;$Plan.completedAt=[DateTime]::UtcNow.ToString('o')
$Plan | ConvertTo-Json -Depth 5
