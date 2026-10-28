param([switch]$TakeOverDesktopTunnel,[string]$PythonExecutable)

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

$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -lt 7){throw 'PowerShell 7 is required.'}
if (!$PythonExecutable) {$PythonExecutable=(Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source}
if (!$PythonExecutable -or !(Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {throw 'Native process ownership is unavailable.'}
$Root=Split-Path -Parent $PSScriptRoot
$BridgeHome=Join-Path $Root '.local\codex-web-bridge'
$AccountHome=Join-Path $Root '.local\account-a-tunnel'
$DesktopHome=Join-Path $env:LOCALAPPDATA 'dev.webcodex.desktop'
$SecretFile=Join-Path $DesktopHome 'secrets\tunnel-config.json'
. (Join-Path $PSScriptRoot 'local_mcp_credentials.ps1')
$Credentials=Get-ClwDefaultTunnelCredentials -Path $SecretFile
$Union=Get-Content -LiteralPath (Join-Path $BridgeHome 'union-config.json') -Raw | ConvertFrom-Json
$Deployment=Get-Content -LiteralPath (Join-Path $BridgeHome 'shared-entry.json') -Raw | ConvertFrom-Json
$Base='http://127.0.0.1:'+ $Union.port
$Health=Invoke-RestMethod -Uri ($Base+'/healthz') -NoProxy -TimeoutSec 5
if($Health.service -ne 'clw-mcp-union' -or $Health.pid -ne $Deployment.unionPid){throw 'Original shared tool entry identity is not verified.'}
$Binary=Join-Path $env:LOCALAPPDATA 'WebCodex\tools\tunnel-client\0.0.12\windows-amd64\tunnel-client.exe'
$ProfileFile=Join-Path $AccountHome 'profile.yaml'
$OwnerFile=Join-Path $AccountHome 'owner.json'
$All=@((Get-ClwNativeInventory).rows)
$Managed=@($All | Where-Object {$_.CommandLine -like ('*'+$ProfileFile+'*')})
$Desktop=@($All | Where-Object {$_.CommandLine -like ('*'+$DesktopHome+'\runtime\local\regular-tunnel-runtime\*')})
if($Managed.Count -eq 1 -and $Desktop.Count -eq 0){
  $Owner=Get-Content -LiteralPath $OwnerFile -Raw | ConvertFrom-Json
  if($Owner.pid -ne $Managed[0].ProcessId -or $Owner.tunnelId -ne $Credentials.tunnel_id){throw 'A tunnel owner changed.'}
  Write-Output 'Existing A shared tunnel retained.';exit 0
}
if($Managed.Count -gt 0 -or $Desktop.Count -gt 1){throw 'Multiple or ambiguous A tunnel owners; no mutation.'}
# Probe the same authenticated Union route before the one-time tunnel startup.
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
& $PythonExecutable -X utf8 -B -c $McpReadyCode $PSScriptRoot $Root
if ($LASTEXITCODE -ne 0) { throw 'Shared MCP startup is not ready; A was not started.' }
if($Desktop.Count -eq 1){
  if(!$TakeOverDesktopTunnel){throw 'A tunnel is still owned by WebCodex Desktop; explicit idle handoff required.'}
  if($Health.pendingNative -ne 0){throw 'Original shared tool entry is not idle and verified.'}
  $Child=$Desktop[0]
  $Parent=@((Get-ClwNativeInventory -Names @('webcodex.exe') -ProcessId $Child.ParentProcessId).rows) | Select-Object -First 1
  if(!$Parent -or $Parent.Name -ne 'webcodex.exe' -or $Parent.CommandLine -notmatch 'server\s+tunnel' -or $Parent.CommandLine -notlike ('*'+$DesktopHome+'\runtime\local\webcodex.env*')){throw 'A desktop owner is not the expected regular tunnel.'}
  # Metadata-only idle proof. Existing bootstrap header stays in memory/local IPC.
  $Headers=@{Authorization=([IO.File]::ReadAllText($Union.authorizationFile).Trim());'mcp-protocol-version'='2026-07-28';'mcp-method'='tools/call';'mcp-name'='runtime_status'}
  try{
    $Req=@{jsonrpc='2.0';id=('a-handoff-'+[guid]::NewGuid());method='tools/call';params=@{name='runtime_status';arguments=@{compact=$true};_meta=@{'io.modelcontextprotocol/protocolVersion'='2026-07-28';'io.modelcontextprotocol/clientCapabilities'=@{}}}}|ConvertTo-Json -Depth 8
    $Runtime=Invoke-RestMethod -Uri ($Base+'/mcp') -Method Post -Headers $Headers -Body $Req -ContentType 'application/json' -NoProxy -TimeoutSec 10
    if($Runtime.result.structuredContent.output.jobs.active_count -ne 0){throw 'Local tools have active or unknown jobs.'}
  }finally{$Headers.Clear()}
  $Now=@((Get-ClwNativeInventory -Names @('webcodex.exe') -ProcessId $Parent.ProcessId).rows) | Select-Object -First 1
  if(!$Now -or $Now.CreationFiletime -ne $Parent.CreationFiletime){throw 'A desktop owner identity changed.'}
  Stop-Process -Id $Parent.ProcessId
  Wait-Process -Id $Parent.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  $Left=@((Get-ClwNativeInventory -ProcessId $Child.ProcessId).rows) | Select-Object -First 1
  if($Left -and $Left.CreationFiletime -eq $Child.CreationFiletime){Stop-Process -Id $Child.ProcessId;Wait-Process -Id $Child.ProcessId -Timeout 5 -ErrorAction SilentlyContinue}
  Start-Sleep -Milliseconds 500
  $Duplicate=@((Get-ClwNativeInventory).rows | Where-Object {$_.CommandLine -like ('*'+$DesktopHome+'\runtime\local\regular-tunnel-runtime\*')})
  if($Duplicate.Count){throw 'Desktop reclaimed A; no second poller was started.'}
}
[IO.Directory]::CreateDirectory($AccountHome)|Out-Null
$HealthFile=Join-Path $AccountHome 'health-url.txt'
$quote={param([string]$v) ConvertTo-Json -InputObject ($v -replace '\\','/') -Compress}
$Profile=@"
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "$($Credentials.tunnel_id)"
  api_key: "env:CLW_ACCOUNT_A_TUNNEL_KEY"
health:
  listen_addr: "127.0.0.1:0"
  url_file: $(& $quote $HealthFile)
admin_ui:
  open_browser: false
mcp:
  server_urls:
    - channel: main
      url: "$Base/mcp"
  extra_headers:
    Authorization: $(& $quote ('file:'+$Union.authorizationFile))
"@
[IO.File]::WriteAllText($ProfileFile,$Profile,[Text.UTF8Encoding]::new($false))
$LaunchEnvironment=@{CLW_ACCOUNT_A_TUNNEL_KEY=$Credentials.api_key;HTTP_PROXY='http://127.0.0.1:17890';HTTPS_PROXY='http://127.0.0.1:17890';ALL_PROXY='http://127.0.0.1:17890';NO_PROXY='127.0.0.1,localhost'}
try{$Started=Start-Process -FilePath $Binary -ArgumentList @('run','--profile-file',('"'+$ProfileFile+'"'),'--control-plane.http-proxy','http://127.0.0.1:17890','--harpoon.http-proxy','http://127.0.0.1:17890') -WorkingDirectory $Root -WindowStyle Hidden -Environment $LaunchEnvironment -PassThru -RedirectStandardOutput (Join-Path $AccountHome 'stdout.log') -RedirectStandardError (Join-Path $AccountHome 'stderr.log')}
finally{$LaunchEnvironment.Clear();$Credentials.api_key=$null}
$Owner=@{pid=$Started.Id;tunnelId=$Credentials.tunnel_id;source='existing-desktop-A';target=($Base+'/mcp');at=[DateTime]::UtcNow.ToString('o')}
[IO.File]::WriteAllText($OwnerFile,($Owner|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output ('A uses its original tunnel and the existing unified tools; pid='+$Started.Id+'. Verify connector catalog before any model send.')
