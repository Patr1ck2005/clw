param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用已有 PowerShell 7 运行此登记入口。' }
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Shell = Join-Path $PSHOME 'pwsh.exe'
$Recovery = Join-Path $PSScriptRoot 'recover_local_mcp.ps1'
$StartupFolder = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupFolder 'CLW AB连接.lnk'
$Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Recovery + '" -StartWatch -WaitForVpnSeconds 300'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$DesktopName = 'WebCodex Desktop'
$DesktopExecutable = 'D:\Program Files\WebCodex Desktop\WebCodex.exe'
$OldTaskName = 'WebCodex-Account-B-Tunnel'
$RecordPath = Join-Path $ProjectRoot '.local\ab-startup-registration.json'
$OriginalPath = Join-Path $ProjectRoot '.local\ab-startup-original-registration.json'
$Utf8 = [Text.UTF8Encoding]::new($false)
$Wsh = New-Object -ComObject WScript.Shell

function Read-DesktopStartup {
    if ((Get-Item -LiteralPath $RunKey).Property -contains $DesktopName) {
        return Get-ItemPropertyValue -LiteralPath $RunKey -Name $DesktopName
    }
    return $null
}
function Read-Shortcut {
    if (!(Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) { return $null }
    $Link = $Wsh.CreateShortcut($ShortcutPath)
    return @{ target = $Link.TargetPath; arguments = $Link.Arguments; working_directory = $Link.WorkingDirectory; window_style = $Link.WindowStyle }
}
function Write-Registration([hashtable]$Value) {
    $Temporary = $RecordPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($Temporary, ($Value | ConvertTo-Json -Depth 10), $Utf8)
    [IO.File]::Move($Temporary, $RecordPath, $true)
}
function Assert-OldTask($Task) {
    if (!$Task) { return }
    $ExpectedArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $ProjectRoot '.local\account-b-tunnel\start-account-b-tunnel.ps1') + '"'
    if ($Task.Actions.Count -ne 1 -or $Task.Actions[0].Execute -ine (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -or $Task.Actions[0].Arguments -ne $ExpectedArguments -or $Task.Actions[0].WorkingDirectory -ine (Join-Path $ProjectRoot '.local\account-b-tunnel')) {
        throw '旧 B 任务已改变，保留它并核对；未改启动登记。'
    }
}

$DesktopValue = Read-DesktopStartup
$Existing = Read-Shortcut
$OldTask = Get-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue
if ($CheckOnly) {
    [pscustomobject]@{
        startup_link_present = ($null -ne $Existing)
        startup_link_matches = ($Existing -and $Existing.target -ieq $Shell -and $Existing.arguments -eq $Arguments -and $Existing.working_directory -ieq $ProjectRoot)
        desktop_duplicate_startup_disabled = ($null -eq $DesktopValue)
        old_b_task_disabled = (!$OldTask -or [string]$OldTask.State -eq 'Disabled')
        startup_link = $ShortcutPath
        model_sends = 0
        services_started = 0
    } | ConvertTo-Json -Compress
    exit 0
}

if ($DesktopValue -and $DesktopValue.Trim() -notin @(('"' + $DesktopExecutable + '" --background'), ($DesktopExecutable + ' --background'))) {
    throw '原 WebCodex 开机项已改变，保留它并核对；未改启动登记。'
}
if ($Existing -and ($Existing.target -ine $Shell -or $Existing.working_directory -ine $ProjectRoot -or $Existing.arguments -ne $Arguments)) {
    throw '同名登录入口已有其他配置，保留它并核对。'
}
Assert-OldTask $OldTask
$OldTaskXml = if ($OldTask) { Export-ScheduledTask -TaskName $OldTaskName } else { $null }

$Record = if (Test-Path -LiteralPath $RecordPath -PathType Leaf) { Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json -AsHashtable } else {
    @{ version = 1; created_at = [DateTime]::UtcNow.ToString('o'); original_desktop_run = $DesktopValue; original_shortcut = $Existing; original_b_task_state = if ($OldTask) { [string]$OldTask.State } else { $null } }
}
if ($OldTask -and !(Test-Path -LiteralPath (Join-Path $ProjectRoot '.local\ab-startup-original-b-task.xml'))) {
    [IO.File]::WriteAllText((Join-Path $ProjectRoot '.local\ab-startup-original-b-task.xml'), $OldTaskXml, $Utf8)
}
if (!(Test-Path -LiteralPath $OriginalPath -PathType Leaf)) {
    $Bytes = $Utf8.GetBytes(($Record | ConvertTo-Json -Depth 10))
    $Original = [IO.File]::Open($OriginalPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $Original.Write($Bytes, 0, $Bytes.Length); $Original.Flush($true) } finally { $Original.Dispose() }
}
$Record.state = 'registering'
$Record.updated_at = [DateTime]::UtcNow.ToString('o')
$Record.startup_link = $ShortcutPath
$Record.target = $Shell
$Record.arguments = $Arguments
$Record.model_sends = 0
$Record.services_started = 0
Write-Registration $Record
try {
    $Link = $Wsh.CreateShortcut($ShortcutPath)
    $Link.TargetPath = $Shell
    $Link.Arguments = $Arguments
    $Link.WorkingDirectory = $ProjectRoot
    $Link.WindowStyle = 7
    $Link.Description = '自动恢复原AB隧道和共享Runner，等待VPN；不启动项目任务。'
    $Link.Save()
    $Saved = Read-Shortcut
    if ($Saved.target -ine $Shell -or $Saved.arguments -ne $Arguments -or $Saved.working_directory -ine $ProjectRoot) { throw '登录恢复入口保存后核对失败。' }
    if ($DesktopValue) {
        if ((Read-DesktopStartup) -ne $DesktopValue) { throw '原Desktop开机项在登记期间改变，未删除它。' }
        Remove-ItemProperty -LiteralPath $RunKey -Name $DesktopName
    }
    if ($OldTask -and [string]$OldTask.State -ne 'Disabled') {
        $FreshTask = Get-ScheduledTask -TaskName $OldTaskName -ErrorAction Stop
        Assert-OldTask $FreshTask
        if ((Export-ScheduledTask -TaskName $OldTaskName) -ne $OldTaskXml) { throw '旧 B 任务在登记期间改变，未停用它。' }
        Disable-ScheduledTask -TaskName $OldTaskName | Out-Null
    }
    if ((Read-DesktopStartup) -or ((Get-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue).State -notin @($null, 'Disabled'))) { throw '重复开机入口未完全停用，请核对登记记录。' }
    $Record.state = 'registered'
    $Record.updated_at = [DateTime]::UtcNow.ToString('o')
    Write-Registration $Record
    Write-Host 'AB 登录自动恢复已登记；桌面恢复沿同一流程，WebCodex GUI 不再重复开机启动。'
} catch {
    $Record.state = 'needs_attention'
    $Record.error = $_.Exception.Message
    $Record.updated_at = [DateTime]::UtcNow.ToString('o')
    Write-Registration $Record
    throw
}
