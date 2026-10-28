param(
  [Parameter(Mandatory=$true)][ValidateSet('light','medium','high','extra-high','pro','gpt-6-pro','gpt-5.6-pro')][string]$Model,
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [ValidateSet('A','B')][string]$Account,
  [switch]$AppServer,
  [switch]$IncludeConnectedApps,
  [switch]$GitReadOnly,
  [ValidatePattern('^(pick|[0-9a-fA-F-]{36})$')][string]$Resume,
  [string]$PromptFile,
  [string]$ResultDirectory,
  [string]$PythonExecutable,
  [string]$CodexExecutable,
  [string]$CodexScript,
  [string[]]$WritePaths=@('.'),
  [string[]]$ExclusiveResources=@(),
  [ValidateRange(10000,1000000)][int]$AutoCompactTokenLimit
)
$ErrorActionPreference='Stop'
# Windows PowerShell 5 otherwise sends pipeline prompts as ASCII and decodes
# native UTF-8 output with the active console code page. Keep this invocation's
# complete Chinese/LaTeX instructions and JSON tool records intact.
$Utf8Encoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=$Utf8Encoding
[Console]::InputEncoding=$Utf8Encoding
[Console]::OutputEncoding=$Utf8Encoding
# Native command results are UTF-8. Python otherwise uses the Windows locale
# when stdout is a pipe, corrupting non-ASCII output before Codex receives it.
# Scope this to this launcher and its children; leave file encodings unchanged.
$env:PYTHONIOENCODING='utf-8'
$ProjectRoot=Split-Path -Parent $PSScriptRoot
$AdmissionScript=Join-Path $PSScriptRoot 'native_work_admission.py'
$AdmissionDb=Join-Path $ProjectRoot '.local\harness\harness.sqlite3'
function Invoke-Admission([string[]]$AdmissionArguments) {
  $Raw=& $PythonCommand -B $AdmissionScript @AdmissionArguments
  if ($LASTEXITCODE -ne 0) { throw ('CLW local write-domain admission blocked without a Web send: '+($Raw -join ' ')) }
  return ($Raw | ConvertFrom-Json)
}
$StatusFile=Join-Path $ProjectRoot '.local\codex-web-bridge\status.json'
function Get-VerifiedBridge([string]$ExpectedAccount) {
$BridgeState=if(Test-Path -LiteralPath $StatusFile){Get-Content -LiteralPath $StatusFile -Raw -Encoding UTF8 | ConvertFrom-Json}else{@{}}
$ObservedAccount=if($BridgeState.account){$BridgeState.account}else{'B'}
$SelectedAccount=if($ExpectedAccount){$ExpectedAccount}else{$ObservedAccount}
if ($ObservedAccount -ne $SelectedAccount) { throw 'The Web account changed while waiting. Original task was not sent.' }
if($SelectedAccount -notin @('A','B') -or ($ExpectedAccount -and $ExpectedAccount -ne $SelectedAccount)){throw 'Requested Web account is not the active verified bridge. No Web message was sent.'}
$AccountAccessFile=Join-Path $ProjectRoot ('.local\web-host\account-access-'+$SelectedAccount+'.json')
if (Test-Path -LiteralPath $AccountAccessFile) {
  $AccountAccess=Get-Content -LiteralPath $AccountAccessFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($AccountAccess.version -ne 1 -or $AccountAccess.account -ne $SelectedAccount -or $AccountAccess.blocked -isnot [bool]) { throw 'CLW account access state requires review; no Web request was sent.' }
  if ($AccountAccess.blocked) { throw 'ChatGPT conversation access is temporarily limited. Wait for the shared cooldown, then check the connection once in CLW. Do not retry or recreate this work package.' }
}
if (!(Test-Path -LiteralPath $StatusFile)) { throw 'Start the CLW Codex + Web workspace first.' }
if ($BridgeState.tools -and !$BridgeState.tools.ready) { throw ('CLW local tool discovery is not ready. No Web message was sent. '+$BridgeState.tools.message) }
if ($BridgeState.state -ne 'ready') { throw ('CLW Web connection is not ready: '+$BridgeState.state+'. Wait for the shared connection check; do not recreate the work package.') }
$ProofFile=Join-Path $ProjectRoot '.local\codex-web-bridge\connector-proof.json'
$Proof=if(Test-Path -LiteralPath $ProofFile){Get-Content -LiteralPath $ProofFile -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
if(($Proof.account -and $Proof.account -ne $SelectedAccount) -or (!$Proof.account -and $SelectedAccount -ne 'B')){throw 'Codex Web account has no matching connector proof. No Web message was sent.'}
if (!$Proof -or !$Proof.result.ok -or $Proof.ownerPid -ne $BridgeState.pid -or $Proof.runtimePid -ne $BridgeState.runtimePid -or $Proof.endpoint -ne $BridgeState.endpoint) { throw ('Codex Web 尚未通过当前进程的连接核验：'+$BridgeState.state) }
$Endpoint=[Uri]$BridgeState.endpoint
if ($Endpoint.Scheme -ne 'http' -or $Endpoint.Host -ne '127.0.0.1' -or $Endpoint.AbsolutePath -ne '/v1') { throw '无效的本机桥接地址。' }
$Health=Invoke-RestMethod -Uri ($Endpoint.GetLeftPart('Authority')+'/healthz') -TimeoutSec 5
if ($Health.pid -ne $BridgeState.runtimePid -or !$Health.accepting_turns) { throw '原桥接服务未就绪；没有改用其它提供方。' }
return @{account=$SelectedAccount;endpoint=$Endpoint;ownerPid=$BridgeState.pid;runtimePid=$BridgeState.runtimePid}
}
$VerifiedBridge=Get-VerifiedBridge $Account
$SelectedAccount=$VerifiedBridge.account
$Endpoint=$VerifiedBridge.endpoint
$Workspace=(Resolve-Path -LiteralPath $WorkingDirectory).Path
function Resolve-ExplicitFile([string]$Value,[string]$Label) {
  if (![IO.Path]::IsPathRooted($Value) -or !(Test-Path -LiteralPath $Value -PathType Leaf)) { throw ('CLW '+$Label+' must name an existing absolute file.') }
  return (Resolve-Path -LiteralPath $Value).Path
}
$ManifestFile=Join-Path $ProjectRoot '.local\preview-installation.json'
if (Test-Path -LiteralPath $ManifestFile) {
  $Manifest=Get-Content -LiteralPath $ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Manifest.schema -ne 1 -or !$Manifest.binaries.cli -or ![IO.Path]::IsPathRooted([string]$Manifest.binaries.cli)) { throw 'CLW preview runtime metadata is invalid.' }
  $RuntimeRoot=Split-Path -Parent (Split-Path -Parent $Manifest.binaries.cli)
  $PythonCommand=Resolve-ExplicitFile (Join-Path $RuntimeRoot 'python\python.exe') 'private Python'
  if ($PythonExecutable -and (Resolve-ExplicitFile $PythonExecutable 'Python') -ne $PythonCommand) { throw 'CLW installed work uses its own private Python.' }
  $Network=$Manifest.network
  if (!$Network -or $Network.mode -notin @('system','proxy','direct')) { throw 'CLW preview network policy is invalid.' }
  $NetworkKeys=@($Network.PSObject.Properties.Name)
  if (@($NetworkKeys | Where-Object { $_ -notin @('mode','proxy_url') }).Count -or
      ($Network.mode -ne 'proxy' -and 'proxy_url' -in $NetworkKeys)) { throw 'CLW preview network policy is invalid.' }
  if ($Network.mode -eq 'proxy') {
    $ProxyUrl=[string]$Network.proxy_url
    $Proxy=$null
    if (!$ProxyUrl -or $ProxyUrl -match '\s' -or ![Uri]::TryCreate($ProxyUrl,[UriKind]::Absolute,[ref]$Proxy) -or
        $Proxy.Scheme -notin @('http','https','socks5','socks5h') -or !$Proxy.Host -or $Proxy.UserInfo -or
        $Proxy.AbsolutePath -notin @('','/') -or $Proxy.Query -or $Proxy.Fragment -or
        ($Proxy.Scheme -in @('socks5','socks5h') -and $Proxy.Port -lt 1)) { throw 'CLW explicit proxy is invalid; no direct fallback was made.' }
  }
  if ($Network.mode -ne 'system') {
    foreach ($Variable in @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(HTTP|HTTPS|ALL)_PROXY$' })) { Remove-Item -LiteralPath ('Env:'+ $Variable.Name) }
  }
  if ($Network.mode -eq 'proxy') { $env:HTTP_PROXY=$ProxyUrl;$env:HTTPS_PROXY=$ProxyUrl;$env:ALL_PROXY=$ProxyUrl }
} else {
  $PythonCommand=if($PythonExecutable){Resolve-ExplicitFile $PythonExecutable 'Python'}else{Get-Command python -ErrorAction Stop}
}
$CodexPrefix=@()
if ($CodexScript) {
  if (!$CodexExecutable) { throw 'CLW CodexScript requires an explicit CodexExecutable.' }
  $CodexPrefix=@((Resolve-ExplicitFile $CodexScript 'Codex script'))
}
$CodexCommand=if($CodexExecutable){Resolve-ExplicitFile $CodexExecutable 'Codex executable'}else{Get-Command codex -ErrorAction Stop}
$env:NO_PROXY='127.0.0.1,localhost,::1'
function Get-CodexArguments([Uri]$Endpoint) {
$Arguments=@('-c','model_provider="openai"','-c',('openai_base_url="'+$Endpoint.AbsoluteUri+'"'),'-c',('model="chatgpt-web/'+$Model+'"'),'-c','approval_policy="never"','-c','sandbox_mode="danger-full-access"','-C',$Workspace,'-a','never','-s','danger-full-access')
# The browser's Local-MCP-B bridge is independent of Codex's connected Apps.
# Importing those Apps into this local-work entry can send file operations to
# an unrelated/retired connector, or recursively call another bridge. Keep
# the native tools and configured local MCPs; opt into Apps only when needed.
# This is process-local and does not edit the normal Codex configuration.
$Arguments+=@('-c',('features.apps='+$IncludeConnectedApps.IsPresent.ToString().ToLowerInvariant()))
if ($AutoCompactTokenLimit) { $Arguments+=@('-c',('model_auto_compact_token_limit='+$AutoCompactTokenLimit)) }
# Windows PowerShell's legacy native argument joiner removes literal TOML
# quotes. Explicit node.exe/codex.exe invocation has no npm PowerShell shim.
if ($CodexExecutable -and [IO.Path]::GetExtension($CodexExecutable) -eq '.exe' -and
    (!(Get-Variable PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue) -or $PSNativeCommandArgumentPassing -eq 'Legacy')) {
  $Arguments=@($Arguments | ForEach-Object { $_.Replace('"','\"') })
}
return $Arguments
}
$CodexArguments=Get-CodexArguments $Endpoint
if ($AppServer -and ($Resume -or $PromptFile -or $ResultDirectory)) { throw 'App Server 使用原生 thread/turn 接口；不能混用交互或工作包参数。' }
if ((!$PromptFile -or !$ResultDirectory) -and (($WritePaths -join ',') -ne '.' -or $ExclusiveResources.Count -gt 0)) { throw '写域与排他资源只适用于后台工作包。' }
if ($PromptFile -or $ResultDirectory) {
  if (!$PromptFile -or !$ResultDirectory) { throw '工作包需要同时指定 -PromptFile 和 -ResultDirectory。' }
  if ($Resume -eq 'pick') { throw '后台工作包接续必须给出明确任务 UUID。' }
  $PromptPath=(Resolve-Path -LiteralPath $PromptFile).Path
  $PromptText=[IO.File]::ReadAllText($PromptPath)
  if ([string]::IsNullOrWhiteSpace($PromptText)) { throw '工作包目标不能为空。' }
  # The same owner-approved continuation policy accompanies both Web routes.
  $TaskAuthorization=& $PythonCommand -X utf8 -B (Join-Path $PSScriptRoot 'harness_user_authorization.py')
  if ($LASTEXITCODE -ne 0) { throw 'CLW 用户授权声明读取失败；工作包没有发送。' }
  $PromptText=([string]::Join("`n",@($TaskAuthorization)))+"`n"+$PromptText
  $ResultPath=[IO.Path]::GetFullPath($ResultDirectory)
  [IO.Directory]::CreateDirectory($ResultPath) | Out-Null
  $ReceiptPath=Join-Path $ResultPath 'execution.json'
  foreach ($Reserved in @('execution.json','events.jsonl','final.md','prompt.txt','stderr.log')) {
    if (Test-Path -LiteralPath (Join-Path $ResultPath $Reserved)) { throw '该工作包已有记录；先核对原执行，不能覆盖或重放。' }
  }
  $AdmissionArgs=@('request','--database',$AdmissionDb,'--result-path',$ResultPath,'--workspace',$Workspace,'--owner-pid',[string]$PID)
  foreach ($Path in $WritePaths) { $AdmissionArgs+=@('--write-path',$Path) }
  foreach ($Resource in $ExclusiveResources) { $AdmissionArgs+=@('--resource',$Resource) }
  if ($GitReadOnly) { $AdmissionArgs+=@('--git-read-only');$PromptText+="`nDo not write Git metadata, commit, checkout, reset, or change the index. Keep this package within its declared write paths." }
  $Admission=Invoke-Admission $AdmissionArgs
  if ($Admission.state -notin @('queued','reserved')) { throw 'CLW write-domain claim did not enter the local queue.' }
  $Record=@{startedAt=[DateTime]::UtcNow.ToString('o');state=$(if($Admission.state -eq 'queued'){'queued_local'}else{'starting'});ownerPid=$PID;model=('chatgpt-web/'+$Model);workspace=$Workspace;sourceThread=$Resume;officialQuota=$false;taskAcceptance='unverified';connectedApps=$IncludeConnectedApps.IsPresent;admissionId=$Admission.claim_id;resultDirectory=$ResultPath;writeDomainIsCooperative=$true}
  $InitialReceipt=[IO.File]::Open($ReceiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $Record.webAccount=$SelectedAccount
  $Record.gitWrite=!$GitReadOnly.IsPresent
  if ($AutoCompactTokenLimit) { $Record.autoCompactTokenLimit=$AutoCompactTokenLimit }
  try { $InitialBytes=[Text.Encoding]::UTF8.GetBytes(($Record | ConvertTo-Json));$InitialReceipt.Write($InitialBytes,0,$InitialBytes.Length) } finally { $InitialReceipt.Dispose() }
  [IO.File]::WriteAllText((Join-Path $ResultPath 'prompt.txt'),$PromptText,[Text.UTF8Encoding]::new($false))
  if ($Admission.state -eq 'queued') {
    Write-Output ('CLW work package queued locally for a write domain: '+$ResultPath)
    while ($Admission.state -eq 'queued') {
      Start-Sleep -Seconds 2
      $Admission=Invoke-Admission @('poll','--database',$AdmissionDb,'--claim-id',$Record.admissionId,'--owner-pid',[string]$PID)
    }
    if ($Admission.state -ne 'reserved') { throw 'CLW original write-domain claim needs reconciliation; no Web message was sent.' }
    $Record.state='starting';$Record | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
  }
  # Admission may have waited across a CLW restart. Verify the CURRENT owner,
  # connector proof, account and health before the first Codex/model request.
  try {
    $VerifiedBridge=Get-VerifiedBridge $SelectedAccount
    $Endpoint=$VerifiedBridge.endpoint
    $CodexArguments=Get-CodexArguments $Endpoint
    $Record.bridgeEndpoint=$Endpoint.AbsoluteUri
    $Record.bridgeRuntimePid=$VerifiedBridge.runtimePid
  } catch {
    $Record.startFailure=[string]$_.Exception.Message
    $Record | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
    $null=Invoke-Admission @('cancel-before-start','--database',$AdmissionDb,'--claim-id',$Record.admissionId,'--owner-pid',[string]$PID)
    throw
  }
  $FinalPath=Join-Path $ResultPath 'final.md'
  $CodexArguments+=@('exec')
  if ($Resume) { $CodexArguments+=@('resume',$Resume) }
  $CodexArguments+=@('--skip-git-repo-check','--json','-o',$FinalPath,'-')
  Write-Output ('CLW work package: '+$ResultPath)
  $Admission=Invoke-Admission @('start','--database',$AdmissionDb,'--claim-id',$Record.admissionId,'--owner-pid',[string]$PID)
  if ($Admission.state -ne 'running') { throw 'CLW write-domain claim is not running; no Web message was sent.' }
  $Record.state='running';$Record | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
  # Windows PowerShell 5 wraps ordinary native stderr (including WARN logs)
  # as ErrorRecord. Let the native exit code decide; do not kill a valid turn
  # because the npm launcher forwarded a harmless diagnostic.
  $PreviousErrorPreference=$ErrorActionPreference
  try {
    $ErrorActionPreference='Continue'
    $PromptText | & $CodexCommand @CodexPrefix @CodexArguments 1> (Join-Path $ResultPath 'events.jsonl') 2> (Join-Path $ResultPath 'stderr.log')
    $NativeExitCode=$LASTEXITCODE
  } finally { $ErrorActionPreference=$PreviousErrorPreference }
  $Record.state=if($NativeExitCode -eq 0 -and (Get-Item -LiteralPath $FinalPath -ErrorAction SilentlyContinue).Length -gt 0){'turn_completed'}else{'needs_attention'}
  $Record.exitCode=$NativeExitCode;$Record.endedAt=[DateTime]::UtcNow.ToString('o')
  $Record | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
  try {
    $Terminal=Invoke-Admission @('mark-terminal','--database',$AdmissionDb,'--claim-id',$Record.admissionId,'--owner-pid',[string]$PID)
    if ($Terminal.state -eq 'terminal_pending') {
      try { $null=Invoke-Admission @('settle','--database',$AdmissionDb,'--result-path',$ResultPath) }
      catch { Write-Output 'CLW write domain remains held until original native tools and owned Workflow Jobs are verified. Use read_codex_web_task.py --settle-admission after reconciliation.' }
    }
  } catch { Write-Output 'CLW write domain remains held: original native turn terminal evidence is unavailable. Reconcile the original package; do not replay it.' }
  Write-Output ('CLW native turn '+$Record.state+': '+$ReceiptPath)
  Write-Output 'Review final.md, native tool events and project evidence before accepting the work package.'
  exit $NativeExitCode
}
if ($AppServer) { $CodexArguments+=@('app-server','--listen','stdio://') }
if ($Resume -eq 'pick') { $CodexArguments+=@('resume') }
elseif ($Resume) { $CodexArguments+=@('resume',$Resume) }
& $CodexCommand @CodexPrefix @CodexArguments
exit $LASTEXITCODE
