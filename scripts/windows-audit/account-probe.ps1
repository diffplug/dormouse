#Requires -Version 5.1
param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$results = @()
$pipes = Get-Content -Raw -LiteralPath (Join-Path $Root 'pipes.json') | ConvertFrom-Json
foreach ($kind in 'dor', 'peer') {
  $name = $pipes.$kind -replace '^\\\\\.\\pipe\\', ''
  $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(3000)
    $results += @{ kind = $kind; result = 'CONNECTED'; detail = 'Cross-account duplex open succeeded; authentication not attempted' }
  } catch {
    $errorCode = $_.Exception.GetBaseException().HResult -band 65535
    $results += @{ kind = $kind; result = $(if ($errorCode -eq 5) { 'ACCESS_DENIED' } else { 'INCONCLUSIVE' }); errorCode = $errorCode; detail = $_.Exception.GetBaseException().Message }
  } finally { $pipe.Dispose() }
}
foreach ($relative in 'control.txt', 'explicit.txt', 'private\inherited.txt') {
  foreach ($access in 'Read', 'Write') {
    try {
      $file = [IO.File]::Open((Join-Path $Root $relative), [IO.FileMode]::Open, [IO.FileAccess]$access, [IO.FileShare]::ReadWrite)
      $file.Dispose()
      $results += @{ file = $relative; access = $access; result = 'OPENED' }
    } catch {
      $errorCode = $_.Exception.GetBaseException().HResult -band 65535
      $results += @{ file = $relative; access = $access; result = $(if ($errorCode -eq 5) { 'ACCESS_DENIED' } else { 'INCONCLUSIVE' }); errorCode = $errorCode }
    }
  }
}
@{ sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; results = $results } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $Output
