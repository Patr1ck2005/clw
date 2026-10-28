# Secret-bearing result: callers must capture it in-process, never print or log it.
function Get-ClwDefaultTunnelCredentials {
  param([Parameter(Mandatory)][string]$Path)
  try {
    $Config=Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($Config -isnot [pscustomobject]) {throw 'invalid'}
    $Pair=$Config
    if ($Config.PSObject.Properties.Name -contains 'schema_version') {
      if ($Config.schema_version -ne 2 -or $Config.profiles -isnot [Array]) {throw 'invalid'}
      $Default=@($Config.profiles | Where-Object {$_.id -ceq 'default'})
      if ($Default.Count -ne 1) {throw 'invalid'}
      $Pair=$Default[0].credentials
    }
    if ($Pair.tunnel_id -isnot [string] -or $Pair.tunnel_id -cnotmatch '^tunnel_[a-f0-9]{32}$' -or
        $Pair.api_key -isnot [string] -or [string]::IsNullOrWhiteSpace($Pair.api_key)) {throw 'invalid'}
    return [pscustomobject]@{tunnel_id=$Pair.tunnel_id;api_key=$Pair.api_key}
  } catch {
    throw 'Existing default tunnel settings unavailable.'
  }
}
