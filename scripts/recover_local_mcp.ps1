param([string]$PythonExecutable,[switch]$Watch,[switch]$StartWatch,[switch]$StopWatch,[int]$WatchIntervalSeconds=30,
    [int]$WaitForVpnSeconds=0,[int]$VpnProbeIntervalSeconds=5,[string]$VerifiedWatchSourceSha,[string]$RecoveryRunId)

# Windows logon may enter through Windows PowerShell. Reuse an installed PS7;
# forwarding starts this entry once and never replays an accepted recovery.
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $OnPath = (Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    $ShellCandidates = @($OnPath, (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'))
    $ForwardShell = $ShellCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
    if (!$ForwardShell) { Write-Error 'PowerShell 7 is unavailable; no recovery was started.'; exit 1 }
    $ForwardArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
    foreach ($Name in $PSBoundParameters.Keys) {
        if ($PSBoundParameters[$Name] -is [Management.Automation.SwitchParameter]) {
            if ($PSBoundParameters[$Name].IsPresent) { $ForwardArgs += ('-'+$Name) }
        } else { $ForwardArgs += @(('-'+$Name), ([string]$PSBoundParameters[$Name])) }
    }
    & $ForwardShell @ForwardArgs
    exit $LASTEXITCODE
}

# Restore the original shared backend and tunnels only; development stays paused.
$ErrorActionPreference = 'Stop'
$Utf8 = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$env:PYTHONIOENCODING = 'utf-8'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RecoveryLock = $null
$LockHeld = $false
$ExitCode = 1
$Receipt = $null
$ReceiptPath = $null
$PriorServiceEnded = $null
$ErrorCode = 'recovery_entry_unavailable'

function Save-RecoveryReceipt([string]$State, [string]$Step) {
    if (!$Receipt) { return }
    $Receipt.state=$State; $Receipt.step=$Step; $Receipt.updated_at=[DateTime]::UtcNow.ToString('o')
    $Json=$Receipt | ConvertTo-Json -Depth 8
    # Each run retains its original receipt, including unknown launch outcomes.
    foreach ($Path in @($ReceiptPath, (Join-Path $ProjectRoot '.local\ab-recovery.json'))) {
        $Temp=$Path+'.'+$Receipt.run_id+'.tmp'
        [IO.File]::WriteAllText($Temp,$Json,$Utf8)
        [IO.File]::Move($Temp,$Path,$true)
    }
}

function Test-VpnProxy {
    $Proxy=[Net.Sockets.TcpClient]::new()
    try {
        $Connect=$Proxy.ConnectAsync('127.0.0.1',17890)
        return ($Connect.Wait(1000) -and $Proxy.Connected)
    } catch { return $false } finally { $Proxy.Dispose() }
}

function Wait-VpnProxy {
    $Timer=[Diagnostics.Stopwatch]::StartNew()
    while (!(Test-VpnProxy)) {
        if ($Timer.Elapsed.TotalSeconds -ge $WaitForVpnSeconds) { throw 'VPN 代理 17890 不可达，请先连接 VPN。' }
        Start-Sleep -Milliseconds ([int](1000*[Math]::Min($VpnProbeIntervalSeconds,[Math]::Max(0.05,$WaitForVpnSeconds-$Timer.Elapsed.TotalSeconds))))
    }
}

function Get-WatchSignature {
    $Signature=& $Python -B $WatchScript --root $ProjectRoot --signature
    if ($LASTEXITCODE -ne 0 -or $Signature -notmatch '^[a-f0-9]{64}$') { throw '连接守候源码未能核验。' }
    return [string]$Signature
}

function Get-ExistingWatch {
    # The legacy --existing treats a failed identity read as inactive. This
    # entry must distinguish positive absence from an unknown original owner.
    $ReadCode=@'
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from local_mcp_watch import read_json
from windows_process_owner import _NativeApi, process_identity
path=Path(sys.argv[2])/'.local/local-mcp-watch/status.json'
if not path.exists():
    print(json.dumps({'active':False})); sys.exit(0)
status=read_json(path); pid=status.get('pid')
if type(pid) is not int or not isinstance(status.get('creation_filetime'),str) or not status.get('run_id') or not status.get('source_sha'):
    sys.exit(2)
if pid not in _NativeApi().snapshot():
    print(json.dumps({'active':False})); sys.exit(0)
identity=process_identity(pid)
if identity['CreationFiletime'] != status['creation_filetime']:
    print(json.dumps({'active':False})); sys.exit(0)
if identity['ProcessName'] not in ('python.exe','pythonw.exe') or status.get('state') == 'stopped':
    sys.exit(2)
print(json.dumps({'active':True,'pid':pid,'source_sha':status['source_sha']}))
'@
    $Raw=& $Python -B -c $ReadCode $PSScriptRoot $ProjectRoot 2>$null
    if ($LASTEXITCODE -ne 0) { throw '原连接守候身份未能核验。' }
    try { return ($Raw -join "`n") | ConvertFrom-Json -ErrorAction Stop }
    catch { throw '原连接守候身份未能核验。' }
}

function Assert-OriginalRecoverySettled {
    $Latest=Join-Path $ProjectRoot '.local\ab-recovery.json'
    if (!(Test-Path -LiteralPath $Latest)) { return }
    $Prior=Get-Content -LiteralPath $Latest -Raw | ConvertFrom-Json
    if ($Prior.launch_unknown -ne $true) { return }
    if ($Prior.run_id -notmatch '^[a-f0-9]{32}$') { throw '原恢复请求身份未知，原回执保留。' }
    $BootCheckCode=@'
import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from local_mcp_watch import preboot_service_evidence
print(json.dumps(preboot_service_evidence(Path(sys.argv[2]))))
'@
    $Evidence=& $Python -B -c $BootCheckCode $PSScriptRoot $ProjectRoot 2>$null
    if ($LASTEXITCODE -ne 0) { throw '原恢复请求的启动代次未能核实，原回执保留。' }
    $Evidence=($Evidence -join "`n")|ConvertFrom-Json
    if ($Evidence.state -eq 'preboot_ended' -and $Evidence.run_id -eq $Prior.run_id) {
        $script:PriorServiceEnded=$Evidence
        return
    }
    $StatusFile=Join-Path $WatchHome 'status.json'
    if (Test-Path -LiteralPath $StatusFile) {
        $PriorWatch=Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
        if ($PriorWatch.settled_recovery_run_id -eq $Prior.run_id -and $PriorWatch.recovery_completion_unknown -eq $false) { return }
    }
    $InspectCode=@'
import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from local_mcp_watch import inspect
print('ready' if inspect(Path(sys.argv[2]))['healthy'] else 'unknown')
'@
    if (Test-VpnProxy) {
        $Ready=& $Python -B -c $InspectCode $PSScriptRoot $ProjectRoot 2>$null
        if ($LASTEXITCODE -eq 0 -and $Ready -eq 'ready') { return }
    }
    throw '原恢复请求完成未知，保留原回执；尚未核实全连接就绪，未触发新恢复。'
}

function Stop-OriginalWatch($ExistingWatch) {
    # The native handle holds the exact creation identity until confirmed exit.
    # Only the watch's formal stop.json is written; no service/process is killed.
    $StopCode=@'
import ctypes, sys, time
from pathlib import Path, PureWindowsPath
sys.path.insert(0, sys.argv[1])
from local_mcp_watch import read_json
from product_runtime import atomic_json
from windows_process_owner import _NativeApi, DWORD
home=Path(sys.argv[2])/'.local/local-mcp-watch'
status=read_json(home/'status.json')
pid=int(sys.argv[3]); sha=sys.argv[4]
if status.get('pid') != pid or status.get('source_sha') != sha or not status.get('run_id'):
    sys.exit(2)
api=_NativeApi(); handle=api.open(pid)
try:
    if str(api.marker(handle)) != status.get('creation_filetime') or PureWindowsPath(api.image(handle)).name.casefold() not in ('python.exe','pythonw.exe'):
        sys.exit(2)
    current=read_json(home/'status.json')
    if any(current.get(key) != status.get(key) for key in ('run_id','pid','creation_filetime','source_sha')):
        sys.exit(2)
    atomic_json(home/'stop.json', {'run_id':status['run_id']})
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        code=DWORD()
        if not api.kernel.GetExitCodeProcess(handle,ctypes.byref(code)): sys.exit(2)
        if code.value != 259: sys.exit(0)
        time.sleep(.2)
    sys.exit(3)
finally:
    api.close(handle)
'@
    & $Python -B -c $StopCode $PSScriptRoot $ProjectRoot ([string]$ExistingWatch.pid) ([string]$ExistingWatch.source_sha)
    if ($LASTEXITCODE -ne 0) { throw '原连接守候未确认退出；未启动第二个守候，服务和 Job 保留。' }
}

function Start-VerifiedWatch {
    [IO.Directory]::CreateDirectory($WatchHome) | Out-Null
    $SourceSha=Get-WatchSignature
    $ExistingWatch=Get-ExistingWatch
    if ($ExistingWatch.active -eq $true -and $ExistingWatch.source_sha -eq $SourceSha) {
        Write-Host ('原连接守候保持（pid='+$ExistingWatch.pid+'）。')
        $Receipt.watch=@{state='retained';pid=$ExistingWatch.pid;source_sha=$SourceSha}
        return
    }
    if ($VerifiedWatchSourceSha -and
            ($VerifiedWatchSourceSha -notmatch '^[a-f0-9]{64}$' -or $VerifiedWatchSourceSha -ne $SourceSha)) {
        throw '指定的连接守候源码哈希不匹配；原守候和服务保持。'
    }
    if ($ExistingWatch.active -eq $true) { Stop-OriginalWatch $ExistingWatch }
    if ((Get-WatchSignature) -ne $SourceSha -or (Get-ExistingWatch).active -eq $true) {
        throw '连接守候源码或身份已变化；未启动第二个守候。'
    }
    $Receipt.watch=@{state='launch_unknown';source_sha=$SourceSha}
    $Receipt.launch_unknown=$true
    Save-RecoveryReceipt 'running' 'watch_launch'
    $WatchProcess=Start-Process -FilePath $Python -ArgumentList @('-B',('"'+$WatchScript+'"'),'--root',('"'+$ProjectRoot+'"'),'--interval',([string]$WatchIntervalSeconds),'--source-sha',$SourceSha) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $WatchHome 'stdout.log') -RedirectStandardError (Join-Path $WatchHome 'stderr.log')
    $Receipt.watch.pid=$WatchProcess.Id
    for ($Attempt=0; $Attempt -lt 20; $Attempt++) {
        $Current=Get-ExistingWatch
        if ($Current.active -eq $true -and $Current.pid -eq $WatchProcess.Id -and $Current.source_sha -eq $SourceSha) {
            $Receipt.watch.state='started'
            $Receipt.launch_unknown=$false
            Write-Host ('独立连接守候已启动（pid='+$WatchProcess.Id+'）。')
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw '连接守候启动回执尚未确认；保留原请求，未重复启动。'
}

function Find-Python {
    if ($PythonExecutable) {
        if (!(Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
            throw '指定的 Python 不存在。'
        }
        return (Resolve-Path -LiteralPath $PythonExecutable).Path
    }
    $OnPath = (Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    $Candidates = @(
        $OnPath,
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'),
        'D:\Program Files\Python311\python.exe'
    )
    foreach ($Candidate in $Candidates) {
        # WindowsApps can be an installation alias, rather than an interpreter.
        if ($Candidate -and $Candidate -notlike '*\WindowsApps\*' -and
                (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
            return $Candidate
        }
    }
    throw '未找到 Python。请使用 -PythonExecutable 指定已有解释器。'
}

function Wait-TunnelHealth([string]$Account, [string]$Binary) {
    $UrlFile = Join-Path $ProjectRoot ('.local\account-' + $Account.ToLowerInvariant() + '-tunnel\health-url.txt')
    # An idle first long-poll normally takes about 30 seconds. The previous
    # 18-second backoff could report failure before that successful poll ended.
    $MaxAttempts = 10
    for ($Attempt = 1; $Attempt -le $MaxAttempts; $Attempt++) {
        $Report = & $Binary health --json --url-file $UrlFile --require-control-plane-poll 2>$null
        $HealthExit = $LASTEXITCODE
        $Health = $null
        try { $Health = ($Report -join "`n") | ConvertFrom-Json } catch {}
        if ($HealthExit -eq 0 -and $Health.result -eq 'ok' -and
                $Health.readyz.ok -eq $true -and $Health.control_plane_poll.ok -eq $true) {
            Write-Host ("账号 $Account 就绪：隧道连接及控制端轮询正常。") -ForegroundColor Green
            return
        }
        if ($Attempt -lt $MaxAttempts) {
            Write-Host ("账号 $Account 等待成功轮询，稍后复查（$Attempt/$MaxAttempts）……")
            Start-Sleep -Seconds ([Math]::Min(6, 2 * $Attempt))
        }
    }
    throw ("账号 $Account 的隧道尚未就绪。原进程保留；请检查 VPN 或原隧道日志。")
}

function Assert-NoRejectedTunnelCredentials {
    # A confirmed authentication refusal needs changed credentials, not another
    # startup attempt. The incident marker contains digests only, never keys.
    $Marker = Join-Path $ProjectRoot '.local\ab-authentication-wait.json'
    if (!(Test-Path -LiteralPath $Marker -PathType Leaf)) { return }
    $Wait = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
    if ($Wait.protocol -ne 1) { throw '隧道认证等待记录无法核对；未重新启动。' }
    $Unchanged = @()
    foreach ($Account in @('A', 'B')) {
        $Rejected = $Wait.rejected_key_sha256.$Account
        if (!$Rejected) { continue }
        if ($Rejected -notmatch '^[a-f0-9]{64}$') { throw '隧道认证等待记录无法核对；未重新启动。' }
        if ($Account -eq 'A') {
            . (Join-Path $PSScriptRoot 'local_mcp_credentials.ps1')
            $Saved = Get-ClwDefaultTunnelCredentials -Path (Join-Path $env:LOCALAPPDATA 'dev.webcodex.desktop\secrets\tunnel-config.json')
            $Value = [string]$Saved.api_key
        } else {
            $Settings = Get-Content -LiteralPath (Join-Path $ProjectRoot '.local\codex-web-bridge\settings.json') -Raw | ConvertFrom-Json
            $Value = [IO.File]::ReadAllText($Settings.tunnel.runtimeKeyFile)
        }
        if (!$Value.Trim()) { throw '原隧道凭据不可用；未重新启动。' }
        $Digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Utf8.GetBytes($Value.Trim()))).ToLowerInvariant()
        if ($Digest -eq $Rejected) { $Unchanged += $Account }
        $Value = $null; $Saved = $null
    }
    if ($Unchanged.Count) { throw ('账号 ' + ($Unchanged -join '、') + ' 的原隧道收到 401，凭据尚未更新。请先在原 OpenAI 机构核对运行密钥；未重复连接。') }
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 运行。' }
    $Shell = Join-Path $PSHOME 'pwsh.exe'
    $Python = Find-Python
    $WatchHome=Join-Path $ProjectRoot '.local\local-mcp-watch'
    $WatchScript=Join-Path $PSScriptRoot 'local_mcp_watch.py'
    if ($Watch -and ($StartWatch -or $StopWatch) -or $StartWatch -and $StopWatch -or $WatchIntervalSeconds -lt 5 -or $WatchIntervalSeconds -gt 300 -or $WaitForVpnSeconds -lt 0 -or $WaitForVpnSeconds -gt 600 -or $VpnProbeIntervalSeconds -lt 1 -or $VpnProbeIntervalSeconds -gt 30) {throw '连接守候或 VPN 等待选项无效。'}
    if ($StopWatch) {
        $WatchStatus=Get-Content -LiteralPath (Join-Path $WatchHome 'status.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
        if ($WatchStatus.run_id) {
            [IO.File]::WriteAllText((Join-Path $WatchHome 'stop.json'),(@{run_id=$WatchStatus.run_id}|ConvertTo-Json),$Utf8)
            Write-Host '已请求停止连接守候；隧道、Runner 和当前执行保持。'
        } else {Write-Host '当前没有连接守候记录。'}
        exit 0
    }
    if ($Watch) {
        $SourceSha=& $Python -B $WatchScript --root $ProjectRoot --signature
        if ($LASTEXITCODE -ne 0 -or $SourceSha -notmatch '^[a-f0-9]{64}$') {throw '连接守候源码未能核验。'}
        & $Python -B $WatchScript --root $ProjectRoot --interval $WatchIntervalSeconds --source-sha $SourceSha
        exit $LASTEXITCODE
    }
    $LockName = 'Local\CLW-LocalMCP-Recovery-' + [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($Utf8.GetBytes($ProjectRoot.ToLowerInvariant()))).Substring(0, 16)
    $RecoveryLock = [Threading.Mutex]::new($false, $LockName)
    try { $LockHeld = $RecoveryLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $LockHeld = $true }
    if (!$LockHeld) { throw '另一个恢复窗口正在运行，请等待它完成。' }

    Assert-OriginalRecoverySettled
    $ErrorCode='upstream_authentication_required'
    Assert-NoRejectedTunnelCredentials

    [IO.Directory]::CreateDirectory((Join-Path $ProjectRoot '.local')) | Out-Null
    if ($RecoveryRunId -and $RecoveryRunId -notmatch '^[a-f0-9]{32}$') {throw '恢复请求身份无效。'}
    $RunId=if($RecoveryRunId){$RecoveryRunId}else{[guid]::NewGuid().ToString('N')}
    $ReceiptPath=Join-Path $ProjectRoot ('.local\ab-recovery-'+$RunId+'.json')
    if ([IO.File]::Exists($ReceiptPath)) {throw '原恢复请求已有回执；请核对原请求，未重复执行。'}
    $IdentityCode=@'
import json,sys
sys.path.insert(0,sys.argv[1])
from local_mcp_watch import boot_identity
from windows_process_owner import process_identity
coordinator=process_identity(int(sys.argv[2]))
if coordinator['ProcessName'] not in ('pwsh.exe','powershell.exe'):sys.exit(2)
print(json.dumps({'boot':boot_identity(),'coordinator':coordinator}))
'@
    $NativeIdentity=& $Python -B -c $IdentityCode $PSScriptRoot ([string]$PID) 2>$null
    if ($LASTEXITCODE -ne 0) {throw '恢复启动代次未能核实，未触发服务启动。'}
    $NativeIdentity=($NativeIdentity -join "`n")|ConvertFrom-Json
    $Receipt=@{protocol=1;run_id=$RunId;started_at=[DateTime]::UtcNow.ToString('o');state='running';step='vpn';
        boot=$NativeIdentity.boot;coordinator=$NativeIdentity.coordinator;prior_service_startup=$PriorServiceEnded;
        started=@();entry_completed=@{backend=$false;B=$false;A=$false};launch_unknown=$false;error_code=$null;watch=$null;
        model_sends=0;business_state_changed=$false;wait_for_vpn_seconds=$WaitForVpnSeconds}
    Save-RecoveryReceipt 'running' 'vpn'

    if ($StartWatch) {
        $ErrorCode='watch_update_unconfirmed'
        Save-RecoveryReceipt 'running' 'watch'
        Start-VerifiedWatch
    }

    Write-Host '1/5 检查 VPN 代理……'
    $ErrorCode='vpn_unavailable'
    Save-RecoveryReceipt 'running' 'vpn'
    try { Wait-VpnProxy } catch {
        if (!$StartWatch) { throw }
        $Receipt.error_code='vpn_waiting'; Save-RecoveryReceipt 'waiting_vpn' 'vpn'
        Write-Host 'VPN 尚未就绪，独立连接守候继续等待；代理可用后自动沿原入口恢复。'
        exit 0
    }

    Write-Host '2/5 检查共享执行服务，必要时沿原配置恢复……'
    $ErrorCode='backend_preflight_failed'
    $PortReadyCode=@'
import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from local_mcp_watch import backend_port_readiness
ready,reason=backend_port_readiness(Path(sys.argv[2]))
print(json.dumps({'ready':ready,'reason':reason}))
'@
    $PortReady=& $Python -B -c $PortReadyCode $PSScriptRoot $ProjectRoot 2>$null
    if ($LASTEXITCODE -ne 0) { throw '共享执行服务端口状态未能核实；未触发服务启动。' }
    $PortReady=($PortReady -join "`n")|ConvertFrom-Json
    if ($PortReady.ready -ne $true) {
        if ($PortReady.reason -ne 'backend_port_waiting') { throw '共享执行服务端口并非原生服务持有；未触发服务启动。' }
        $Receipt.error_code='backend_port_waiting'; Save-RecoveryReceipt 'waiting_backend' 'backend'
        Write-Host '原共享服务端口暂不能绑定，尚未启动服务；独立守候若已启用，会在端口可用后沿原入口恢复。'
        exit 0
    }
    $ErrorCode='backend_prepare_failed'
    $Receipt.launch_unknown=$true
    Save-RecoveryReceipt 'running' 'backend'
    # Existing preparation verifies ownership and reuses live services. Invoke it
    # once: an accepted/unknown launch must never be replayed by this wrapper.
    $PrepareCode = @'
import json, sys
sys.path.insert(0, sys.argv[1])
from webcodex_backend import prepare, failure_code
try:
    result=prepare(sys.argv[2])
    print(json.dumps({'success':True,'started':result.get('started',[]),'launch_unknown':False}))
except Exception as error:
    print(json.dumps({'success':False,'started':getattr(error,'started',[]),'launch_unknown':getattr(error,'completion_unknown',False)}))
    print('共享服务恢复失败：' + failure_code(error), file=sys.stderr)
    sys.exit(1)
'@
    $Prepared=& $Python -X utf8 -B -c $PrepareCode $PSScriptRoot $ProjectRoot
    $PrepareExit=$LASTEXITCODE
    try {
        $Prepared=($Prepared -join "`n") | ConvertFrom-Json -ErrorAction Stop
        $Receipt.started=@($Prepared.started); $Receipt.launch_unknown=($Prepared.launch_unknown -eq $true)
    } catch { throw '共享执行服务启动回执未确认，未重复启动。请检查原服务状态。' }
    if ($PrepareExit -ne 0 -or $Prepared.success -ne $true) { throw '共享执行服务未就绪，未重复启动。请检查原服务状态。' }
    $Receipt.entry_completed.backend=$true

    # Cold project registration can take over a minute. Wait for the original
    # Server and exact Runner before either tunnel's one-time startup probe.
    $ErrorCode='mcp_startup_not_ready'
    Save-RecoveryReceipt 'running' 'mcp-ready'
    $McpReadyCode=@'
import sys
sys.path.insert(0,sys.argv[1])
from webcodex_backend import wait_mcp_ready
try:
    wait_mcp_ready(sys.argv[2],timeout=180,require_runner=True)
except Exception:
    print('共享工具接口或原 Runner 尚未就绪；原服务和任务已保留。',file=sys.stderr)
    sys.exit(1)
'@
    & $Python -X utf8 -B -c $McpReadyCode $PSScriptRoot $ProjectRoot
    if ($LASTEXITCODE -ne 0) { throw '共享工具接口或原 Runner 尚未就绪；未提前启动隧道，守候将沿原入口接续。' }

    # Both original launchers can exit. Separate child shells retain this flow.
    Write-Host '3/5 恢复账号 B 和共享工具入口；已连接时复用……'
    $ErrorCode='b_recovery_failed'; $Receipt.launch_unknown=$true
    Save-RecoveryReceipt 'running' 'B'
    & $Shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start_local_mcp_b.ps1') -PythonExecutable $Python -HealthWaitAttempts 3
    $BExit=$LASTEXITCODE; $Receipt.launch_unknown=$false
    if ($BExit -ne 0) { throw '账号 B 恢复失败；请查看上方原启动脚本的错误。' }
    $Receipt.entry_completed.B=$true; $Receipt.launch_unknown=$false
    Write-Host '4/5 恢复账号 A；已连接时复用……'
    $ErrorCode='a_recovery_failed'; $Receipt.launch_unknown=$true
    Save-RecoveryReceipt 'running' 'A'
    & $Shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start_local_mcp_a.ps1') -PythonExecutable $Python -TakeOverDesktopTunnel
    $AExit=$LASTEXITCODE; $Receipt.launch_unknown=$false
    if ($AExit -ne 0) { throw '账号 A 恢复失败；请查看上方原启动脚本的错误。' }
    $Receipt.entry_completed.A=$true; $Receipt.launch_unknown=$false

    Write-Host '5/5 核验两个隧道及共享工具目录……'
    $ErrorCode='connection_verification_failed'
    Save-RecoveryReceipt 'running' 'verify'
    $BridgeHome = Join-Path $ProjectRoot '.local\codex-web-bridge'
    $Settings = Get-Content -LiteralPath (Join-Path $BridgeHome 'settings.json') -Raw | ConvertFrom-Json
    $ABinary = Join-Path $env:LOCALAPPDATA 'WebCodex\tools\tunnel-client\0.0.12\windows-amd64\tunnel-client.exe'
    Wait-TunnelHealth 'B' $Settings.tunnel.binaryPath
    Wait-TunnelHealth 'A' $ABinary

    $Union = Get-Content -LiteralPath (Join-Path $BridgeHome 'union-config.json') -Raw | ConvertFrom-Json
    $Deployment = Get-Content -LiteralPath (Join-Path $BridgeHome 'shared-entry.json') -Raw | ConvertFrom-Json
    if ($Union.port -ne 18945) { throw '共享工具入口与原配置不一致。' }
    $Base = 'http://127.0.0.1:18945'
    $UnionHealth = Invoke-RestMethod -Uri ($Base + '/healthz') -NoProxy -TimeoutSec 5
    if ($UnionHealth.service -ne 'clw-mcp-union' -or $UnionHealth.pid -ne $Deployment.unionPid) {
        throw '共享工具入口的原进程身份未通过核验。'
    }
    $Headers = @{
        Authorization = [IO.File]::ReadAllText($Union.authorizationFile).Trim()
        'mcp-protocol-version' = '2026-07-28'
        'mcp-method' = 'tools/list'
    }
    try {
        $Request = @{
            jsonrpc = '2.0'; id = ('tunnel-recovery-' + [guid]::NewGuid()); method = 'tools/list'
            params = @{ _meta = @{
                'io.modelcontextprotocol/protocolVersion' = '2026-07-28'
                'io.modelcontextprotocol/clientCapabilities' = @{}
            } }
        } | ConvertTo-Json -Depth 8 -Compress
        $Catalog = Invoke-RestMethod -Uri ($Base + '/mcp') -Method Post -Headers $Headers -Body $Request -ContentType 'application/json' -NoProxy -TimeoutSec 10
        if ($Catalog.error -or $Catalog.result.tools -isnot [Array] -or $Catalog.result.tools.Count -eq 0) {
            throw '共享工具目录未就绪。'
        }
        Write-Host ("共享工具入口就绪：$($Catalog.result.tools.Count) 项工具。") -ForegroundColor Green
        $Headers['mcp-method']='tools/call';$Headers['mcp-name']='runtime_status'
        $StatusRequest=@{jsonrpc='2.0';id=('tunnel-recovery-runtime-'+[guid]::NewGuid());method='tools/call';params=@{name='runtime_status';arguments=@{compact=$true};_meta=@{'io.modelcontextprotocol/protocolVersion'='2026-07-28';'io.modelcontextprotocol/clientCapabilities'=@{}}}} | ConvertTo-Json -Depth 8 -Compress
        $RuntimeReply=Invoke-RestMethod -Uri ($Base+'/mcp') -Method Post -Headers $Headers -Body $StatusRequest -ContentType 'application/json' -NoProxy -TimeoutSec 10
        $Runtime=$RuntimeReply.result.structuredContent
        $HeartbeatAge=$Runtime.output.connection_layers.server_transport.age_secs
        if ($Runtime.success -ne $true -or $Runtime.output.connection_layers.runner_process.status -ne 'ready' -or $Runtime.output.connection_layers.server_transport.status -ne 'connected' -or $null -eq $HeartbeatAge -or $HeartbeatAge -gt 60 -or $HeartbeatAge -lt 0 -or $Runtime.output.agents.online_count -lt 1 -or $Runtime.output.connection_layers.project_registry.online_projects -lt 1) {throw '共享工具入口已响应，但 Runner 连接尚未恢复；原进程和 Job 保留，不能视为恢复完成。'}
        Write-Host 'Runner 在线，原执行连接正常。' -ForegroundColor Green
    } finally { $Headers.Clear() }

    Write-Host '恢复完成。CLW 开发保持暂停。' -ForegroundColor Green
    $ExitCode = 0
    Save-RecoveryReceipt 'completed' 'complete'
} catch {
    if ($Receipt) { $Receipt.error_code=$ErrorCode; Save-RecoveryReceipt 'needs_attention' $Receipt.step }
    Write-Host ('恢复未完成：' + $_.Exception.Message) -ForegroundColor Red
} finally {
    if ($LockHeld) { $RecoveryLock.ReleaseMutex() }
    if ($RecoveryLock) { $RecoveryLock.Dispose() }
}
exit $ExitCode
