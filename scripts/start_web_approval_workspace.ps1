param(
 [Parameter(Mandatory=$true)][string]$InstallRoot,
 [switch]$NoLaunch
)
$ErrorActionPreference='Stop'
$install=(Resolve-Path -LiteralPath $InstallRoot).Path
$adapter=Join-Path $install 'data/web-host/approval-adapter'
$active=Get-Content -LiteralPath (Join-Path $install 'active.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($active.build_id -notmatch '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}-[a-f0-9]{8}$'){throw 'Invalid selected CLW build'}
$code=Join-Path (Join-Path $install 'versions') $active.build_id
$python=Join-Path $code 'runtime/python/python.exe'
if(!$NoLaunch){
 $manager=Join-Path $install 'manager/web_workspace_release.py'
 Start-Process -FilePath $python -ArgumentList @('-B',('"'+$manager+'"'),'launch','--install-root',('"'+$install+'"')) -WorkingDirectory $install -WindowStyle Hidden|Out-Null
}
$log=Join-Path $adapter ('entry-'+[Guid]::NewGuid().ToString('N')+'.log')
& $python -B (Join-Path $adapter 'ensure_web_approval_adapter.py') --install-root $install --wait-seconds 120 *> $log
if($LASTEXITCODE -ne 0){throw ('CLW approval adapter startup check needs attention: '+$log)}
