param(
  [Parameter(Mandatory=$true)][string]$WorkingDirectory,
  [ValidatePattern('^(pick|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')][string]$Resume,
  [switch]$InspectOnly
)
$ErrorActionPreference='Stop'
$WorkspacePath=(Resolve-Path -LiteralPath $WorkingDirectory).Path
if (!(Test-Path -LiteralPath $WorkspacePath -PathType Container)) { throw '请选择存在的工作目录。' }
$CodexCommand=Get-Command codex -ErrorAction Stop
$NativeArguments=@('-C',$WorkspacePath)
if ($Resume -eq 'pick') { $NativeArguments+=@('resume') }
elseif ($Resume) { $NativeArguments+=@('resume',$Resume) }
# This entry never imports a Web bridge, rewrites authentication/configuration,
# selects a model/provider, or sends a prompt. The installed CLI owns execution.
if ($InspectOnly) {
  @{route='local-codex';command=$CodexCommand.Source;arguments=$NativeArguments;modelSends=0;configurationChanged=$false} | ConvertTo-Json
  exit 0
}
Write-Host '本地 Codex · 使用本机原生登录与默认设置。输入目标后才开始执行。'
& $CodexCommand @NativeArguments
exit $LASTEXITCODE
