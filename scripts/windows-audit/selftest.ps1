#Requires -Version 5.1
# Unelevated checks; never creates users, shares, captures or installed-app state.
param([Parameter(Mandatory)][string]$Kit)
$ErrorActionPreference = 'Stop'
$Kit = (Resolve-Path -LiteralPath $Kit).Path
$root = Join-Path $env:TEMP ('dormouse-90-selftest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$server = $null
try {
  & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Kit 'owner-acl.ps1') -Root $root -Installer (Join-Path $Kit 'installer.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Installer ACL checks failed' }
  [IO.File]::WriteAllText((Join-Path $root 'control.txt'), 'synthetic')
  $server = Start-Process -FilePath (Join-Path $Kit 'node.exe') -ArgumentList @(('"' + (Join-Path $Kit 'fixture.cjs') + '"'), 'serve', ('"' + $root + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'server.out') -RedirectStandardError (Join-Path $root 'server.err')
  for ($i = 0; $i -lt 120; $i++) {
    if (Test-Path -LiteralPath (Join-Path $root 'pipes.json')) { break }
    if ($server.HasExited) { throw 'Pipe server exited before ready' }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'pipes.json'))) { throw 'Pipe server readiness timeout' }
  & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Kit 'account-probe.ps1') -Root $root -Output (Join-Path $root 'same-account.json')
  if ($LASTEXITCODE -ne 0) { throw 'Same-account probe failed' }
  $probe = Get-Content -Raw -LiteralPath (Join-Path $root 'same-account.json') | ConvertFrom-Json
  if (@($probe.results).Count -ne 8) { throw 'Missing probe rows' }
  foreach ($row in $probe.results) {
    $expected = if ($row.kind) { 'CONNECTED' } else { 'OPENED' }
    if ($row.result -ne $expected) { throw "Same-account positive control failed: $($row | ConvertTo-Json -Compress)" }
  }
  # Exercise the actual wrapper and parent completion reader, including the
  # native run's null parent ExitCode. Never infer success from that property.
  $tokens = $null; $parseErrors = $null
  $runner = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Kit 'run.ps1'), [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw 'Runner does not parse' }
  $waitFunction = @($runner.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Wait-ProcessResult' }, $true))
  if ($waitFunction.Count -ne 1) { throw 'Missing completion reader' }
  . ([ScriptBlock]::Create($waitFunction[0].Extent.Text))
  foreach ($expected in @(0, 7)) {
    $exitScript = Join-Path $root "exit-$expected.ps1"
    [IO.File]::WriteAllText($exitScript, "exit $expected")
    $resultLog = Join-Path $root "exit-$expected-result.json"
    $plan = Join-Path $root "exit-$expected-plan.json"
    @{ exe = $ps; arguments = @('-NoProfile', '-File', $exitScript); cwd = $root; sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; identityLog = (Join-Path $root "exit-$expected-identity.json"); resultLog = $resultLog; electron = $false } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $plan
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Kit 'child.ps1') -Plan $plan
    if ($LASTEXITCODE -ne $expected) { throw "Wrapper lost native exit $expected" }
    $record = Get-Content -Raw -LiteralPath $resultLog | ConvertFrom-Json
    if ($record.exitCode -ne $expected -or $record.error) { throw "Wrong result for native exit $expected" }
    $exited = [pscustomobject]@{ Id = 0; ExitCode = $null; AuditResultPath = $resultLog }
    $exited | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) return $true }
    $rejected = $false
    try { Wait-ProcessResult $exited } catch { $rejected = $true }
    if ($rejected -ne ($expected -ne 0)) { throw "Completion reader misclassified native exit $expected with null parent ExitCode" }
  }
  foreach ($invalid in @('missing', 'null', 'error')) {
    $recordPath = Join-Path $root "invalid-$invalid.json"
    if ($invalid -eq 'null') { '{"exitCode":null}' | Set-Content -LiteralPath $recordPath }
    if ($invalid -eq 'error') { '{"exitCode":0,"error":"setup failed"}' | Set-Content -LiteralPath $recordPath }
    $exited.AuditResultPath = $recordPath
    $rejected = $false
    try { Wait-ProcessResult $exited } catch { $rejected = $true }
    if (-not $rejected) { throw "Completion reader accepted $invalid evidence" }
  }
  $filterFunction = @($runner.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-UnfilteredCapture' }, $true))
  if ($filterFunction.Count -ne 1) { throw 'Missing filter preflight' }
  . ([ScriptBlock]::Create($filterFunction[0].Extent.Text))
  # Exact Windows 11 output from the 2026-11-11 native run, plus the other
  # recognized format. A real filter or trailing text must never be accepted.
  foreach ($reply in @("Packet Filters:`r`n    None`r`n", 'No filters.', "`r`nPacket Filters:   None`r`n")) { Assert-UnfilteredCapture -Lines $reply -ExitCode 0 }
  foreach ($case in @(@{ text = 'Packet Filters: None'; code = 5 }, @{ text = ''; code = 0 }, @{ text = 'Packet Filters: 1 TCP'; code = 0 }, @{ text = "Packet Filters:`nNone`n1 TCP"; code = 0 }, @{ text = 'Access is denied'; code = 0 })) {
    $rejected = $false
    try { Assert-UnfilteredCapture -Lines $case.text -ExitCode $case.code } catch { $rejected = $true }
    if (-not $rejected) { throw "Unsafe filter preflight acceptance: $($case.text)" }
  }
  Write-Host 'PASS: observed empty PktMon filter replies accepted; real filters, trailing data, empty output and failed commands rejected.'
  $stopFunction = @($runner.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Stop-Capture' }, $true))
  if ($stopFunction.Count -ne 1) { throw 'Missing capture converter' }
  . ([ScriptBlock]::Create($stopFunction[0].Extent.Text))
  $lab = Join-Path $root 'capture-segments'; New-Item -ItemType Directory -Path $lab | Out-Null
  foreach ($name in @('sample_1.etl', 'sample_2.etl', 'unrelated.etl')) { [IO.File]::WriteAllText((Join-Path $lab $name), 'synthetic') }
  $script:captureCalls = @()
  function Invoke-FakePktmon {
    $script:captureCalls += ,@($args)
    $global:LASTEXITCODE = 0
  }
  $pktmon = 'Invoke-FakePktmon'; $script:capturing = $true
  try { Stop-Capture 'sample' } finally { Remove-Item Function:\Invoke-FakePktmon }
  $converted = @($script:captureCalls | Where-Object { $_[0] -eq 'etl2pcap' } | ForEach-Object { [IO.Path]::GetFileName($_[1]) })
  if (($converted -join ',') -ne 'sample_1.etl,sample_2.etl' -or $script:capturing) { throw 'Numbered capture segments were not converted correctly' }
  Write-Host 'PASS: numbered capture segments all converted, unrelated ETLs excluded, and capture ownership released.'
  # A failed SMB setup must preserve diagnostics and leave independent captures
  # runnable. Execute the actual phase with only share creation replaced; there
  # is no account, capture, symlink or real share operation in this case.
  $smbPhase = @($runner.FindAll({ param($n) $n -is [Management.Automation.Language.TryStatementAst] -and $n.Body.Extent.Text.Contains("`$smbStep = 'create fixture files'") -and $n.CatchClauses.Extent.Text -match 'gitError' }, $true))
  if ($smbPhase.Count -ne 1) { throw 'Expected one isolated SMB phase' }
  $lab = Join-Path $root 'failed-smb-phase'; New-Item -ItemType Directory -Path $lab | Out-Null
  $summary = @{}; $capturing = $false; $shareCreated = $false; $shareName = 'never-created'; $ownerName = 'never-created'
  function New-SmbShare { throw 'injected access denied' }
  try { . ([ScriptBlock]::Create($smbPhase[0].Extent.Text)) } finally { Remove-Item Function:\New-SmbShare }
  if ($summary.gitError.step -ne 'create SMB share' -or $summary.gitError.message -ne 'injected access denied' -or -not $summary.gitError.location -or $shareCreated) { throw 'SMB failure was not recorded correctly' }
  Write-Host 'PASS: share-creation failure retains its operation and source location without aborting independent capture work.'
  Write-Host 'PASS: wrapper preserves native exits 0 and 7; null parent exit status uses the explicit result; missing, null and error results fail closed.'
  Write-Host 'PASS: actual dor and peer pipes connected; all same-account file opens succeeded.'
  Write-Host 'PASS: both shipped installer ACL readers accept protected paths and reject the extra-principal control; Protect-Path succeeds twice unelevated.'
} finally {
  Set-Content -LiteralPath (Join-Path $root 'stop') -Value 'stop'
  if ($server -and -not $server.HasExited) {
    if (-not $server.WaitForExit(10000)) { Stop-Process -Id $server.Id -Force; throw 'Fixture did not shut down' }
  }
  Write-Host "Evidence retained: $root"
}
