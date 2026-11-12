#Requires -Version 5.1
<# Run the PREPARED copy, not this source file. All evidence stays in a new
   ProgramData directory. Temporary standard accounts, their processes, SMB
   share and profiles are removed in finally. No firewall rule is changed. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$GitExe,
  [switch]$CapturePackaged,
  [string]$StandaloneDirectory,
  [string]$CodeDirectory,
  [string]$ExtensionDirectory
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run the prepared copy from an Administrator Windows PowerShell.'
}
foreach ($name in 'fixture.cjs', 'node.exe', 'installer.ps1', 'provenance.json', 'account-probe.ps1', 'owner-acl.ps1', 'child.ps1', 'directory-link.ps1') {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "Missing $name; run prepare.mjs first" }
}
. (Join-Path $PSScriptRoot 'directory-link.ps1')
$GitExe = (Resolve-Path -LiteralPath $GitExe).Path
if ($CapturePackaged) {
  foreach ($pair in @(@($StandaloneDirectory, 'dormouse.exe'), @($CodeDirectory, 'Code.exe'), @($ExtensionDirectory, 'package.json'))) {
    if (-not $pair[0] -or -not (Test-Path -LiteralPath (Join-Path $pair[0] $pair[1]) -PathType Leaf)) { throw "Missing packaged artifact $($pair[1])" }
  }
}
$tag = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$lab = Join-Path $env:ProgramData "DormouseAudit-$tag"
$ownerName = "dm90o$tag"; $otherName = "dm90x$tag"; $shareName = "dm90$tag"
$createdUsers = @(); $shareCreated = $false; $capturing = $false
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$pktmon = Join-Path $env:SystemRoot 'System32\pktmon.exe'
$ownerSidCache = @{}; $runStarted = Get-Date
$summary = [ordered]@{ status = 'INCOMPLETE'; lab = $lab; started = (Get-Date).ToUniversalTime().ToString('o'); cleanup = @() }

function Grant-LabPath([string]$Path, $Rules) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in $Rules) {
    $sid = New-Object Security.Principal.SecurityIdentifier($rule[0])
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rule[1], 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  }
  (Get-Item -LiteralPath $Path).SetAccessControl($acl)
}
function Start-As($Credential, [string]$Exe, [string[]]$Arguments, [string]$Log, [switch]$Visible, [switch]$Electron) {
  $account = New-Object Security.Principal.NTAccount($Credential.UserName)
  $sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
  $plan = "$Log-plan.json"
  $resultLog = Join-Path $(if ($sid -eq $owner.SID.Value) { $data } else { $otherOutput }) ([IO.Path]::GetFileName($Log) + '-result.json')
  @{ resultLog = $resultLog; exe = $Exe; arguments = @($Arguments); cwd = $lab; sid = $sid; electron = [bool]$Electron; identityLog = (Join-Path $(if ($sid -eq $owner.SID.Value) { $data } else { $otherOutput }) ([IO.Path]::GetFileName($Log) + '-identity.json')) } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $plan
  $joined = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $kit 'child.ps1') + '" -Plan "' + $plan + '"'
  $options = @{ FilePath = $ps; ArgumentList = $joined; Credential = $Credential; LoadUserProfile = $true; WorkingDirectory = $lab; PassThru = $true; RedirectStandardOutput = "$Log.out"; RedirectStandardError = "$Log.err" }
  if (-not $Visible) { $options.WindowStyle = 'Hidden' }
  Write-Host ("Running {0} as {1}" -f [IO.Path]::GetFileName($Log), $Credential.UserName)
  $process = Start-Process @options
  $process | Add-Member -NotePropertyName AuditResultPath -NotePropertyValue $resultLog
  return $process
}
function Wait-ProcessResult($Process, [int]$Seconds = 60) {
  if (-not $Process.WaitForExit($Seconds * 1000)) { throw "Process $($Process.Id) timed out" }
  # Start-Process -Credential returned a Process with a null ExitCode on the
  # first native run. Require the wrapper's explicit result, never coerce null.
  if (-not (Test-Path -LiteralPath $Process.AuditResultPath)) { throw "Process $($Process.Id) exited without a result: $($Process.AuditResultPath)" }
  $result = Get-Content -Raw -LiteralPath $Process.AuditResultPath | ConvertFrom-Json
  if ($null -eq $result.exitCode -or $result.exitCode -ne 0 -or $result.error) { throw "Process $($Process.Id) failed: exit=$($result.exitCode); $($result.error); result=$($Process.AuditResultPath)" }
}
function Wait-File([string]$Path, $Process) {
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-Path -LiteralPath $Path) { return }
    if ($Process.HasExited) { throw "Process exited before writing $Path" }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $Path"
}
function Assert-UnfilteredCapture([string[]]$Lines, [int]$ExitCode) {
  $text = (($Lines -join ' ') -replace '\s+', ' ').Trim()
  # Windows 11 26300 prints "Packet Filters: None". Accept only the complete
  # empty-list replies; a prefix, empty output or failed command proves nothing.
  if ($ExitCode -ne 0 -or $text -notmatch '^(?:No filters\.?|Packet Filters: None\.?)$') {
    throw "PktMon filter check failed (exit $ExitCode): $text"
  }
}
function Start-Capture([string]$Name) {
  # Existing filters would make a negative capture meaningless. Preserve them and fail closed.
  $filters = & $pktmon filter list
  $filterExitCode = $LASTEXITCODE
  $filters | Set-Content -Encoding UTF8 (Join-Path $lab ($Name + '-filters.txt'))
  Assert-UnfilteredCapture -Lines $filters -ExitCode $filterExitCode
  # PktMon refuses an already active collector; never stop one we did not start.
  & $pktmon start --capture --pkt-size 128 --file-size 256 --log-mode multi-file --file-name (Join-Path $lab "$Name.etl") *> (Join-Path $lab "$Name-capture-start.txt")
  if ($LASTEXITCODE -ne 0) { throw 'PktMon start failed; no existing collector has been stopped' }
  $script:capturing = $true
}
function Stop-Capture([string]$Name) {
  if (-not $script:capturing) { return }
  & $pktmon stop *> (Join-Path $lab "$Name-capture-stop.txt")
  if ($LASTEXITCODE -ne 0) { throw 'PktMon stop failed' }
  $script:capturing = $false
  # Multi-file mode can number the ETLs, including the first segment. The lab
  # is unique and phase names are distinct; convert every segment it produced.
  $segments = @(Get-ChildItem -LiteralPath $lab -Filter "$Name*.etl" -File | Sort-Object Name)
  if ($segments.Count -eq 0) { throw "PktMon produced no ETL for $Name; inspect capture start/stop logs" }
  foreach ($segment in $segments) {
    & $pktmon etl2pcap $segment.FullName --out (Join-Path $lab ($segment.BaseName + '.pcapng')) *> (Join-Path $lab ($segment.BaseName + '-convert.txt'))
    if ($LASTEXITCODE -ne 0) { throw "PktMon conversion failed for $($segment.Name); original ETL retained" }
  }
  @($segments | Select-Object Name, Length) | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $lab "$Name-segments.json")
}
function Record-Processes([string]$Name, [int]$Seconds = 60) {
  Write-Host ("Collecting {0}: approximately {1} seconds of process/network samples" -f $Name, $Seconds)
  $timeline = Join-Path $lab "$Name-processes.jsonl"
  $clock = [Diagnostics.Stopwatch]::StartNew(); $tick = 0
  while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
    if ($tick % 10 -eq 0) { Write-Host ("  {0}: sample {1}, elapsed {2:N0}/{3}s" -f $Name, ($tick + 1), $clock.Elapsed.TotalSeconds, $Seconds) }
    # Both accounts were just created. Older processes cannot belong to them.
    # Cache by PID AND creation time, so PID reuse never reuses another owner.
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
      if (-not $_.CreationDate -or $_.CreationDate -lt $runStarted) { return $false }
      $key = '{0}|{1}' -f $_.ProcessId, $_.CreationDate.Ticks
      if (-not $ownerSidCache.ContainsKey($key)) {
        $ownerSidCache[$key] = (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid
      }
      $ownerSidCache[$key] -eq $owner.SID.Value
    } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)
    $ids = @($processes.ProcessId)
    $tcp = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $ids } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess)
    $udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $ids } | Select-Object LocalAddress,LocalPort,OwningProcess)
    @{ at = (Get-Date).ToUniversalTime().ToString('o'); processes = $processes; tcp = $tcp; udp = $udp } | ConvertTo-Json -Depth 6 -Compress | Add-Content -Encoding UTF8 -LiteralPath $timeline
    $tick++
    Start-Sleep -Seconds 1
  }
}
function Stop-LabProcesses {
  $sids = @($createdUsers | ForEach-Object { $_.SID.Value })
  foreach ($process in Get-CimInstance Win32_Process) {
    $sid = (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid
    if ($sid -and $sid -in $sids) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}
function Copy-Artifact([string]$Source, [string]$Target) {
  New-Item -ItemType Directory -Path $Target | Out-Null
  # No mirroring, deletion, junction traversal, install, or change to the source.
  & (Join-Path $env:SystemRoot 'System32\robocopy.exe') $Source $Target /E /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copy failed: $Source" }
}
try {
  New-Item -ItemType Directory -Path $lab | Out-Null
  Grant-LabPath $lab @(@($identity.User.Value, 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-18', 'FullControl'))
  foreach ($name in $ownerName, $otherName) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $password = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force
    $user = New-LocalUser -Name $name -Password $password -Description "Temporary Dormouse issue 90 audit $tag" -AccountExpires (Get-Date).AddDays(1)
    $createdUsers += $user
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
    $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$name", $password)
    if ($name -eq $ownerName) { $owner = $user; $ownerCredential = $credential } else { $other = $user; $otherCredential = $credential }
  }
  Grant-LabPath $lab @(@($identity.User.Value, 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-18', 'FullControl'), @($owner.SID.Value, 'ReadAndExecute'), @($other.SID.Value, 'ReadAndExecute'))
  Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $lab 'windows.json')
  & $GitExe --version | Set-Content -Encoding UTF8 (Join-Path $lab 'git-version.txt')
  $kit = Join-Path $lab 'kit'; New-Item -ItemType Directory -Path $kit | Out-Null
  Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $kit
  $data = Join-Path $lab 'owner'; New-Item -ItemType Directory -Path $data | Out-Null
  Grant-LabPath $data @(@($identity.User.Value, 'ReadAndExecute'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-18', 'FullControl'), @($owner.SID.Value, 'FullControl'), @($other.SID.Value, 'ReadAndExecute'))
  $otherOutput = Join-Path $lab 'other'; New-Item -ItemType Directory -Path $otherOutput | Out-Null
  Grant-LabPath $otherOutput @(@($identity.User.Value, 'ReadAndExecute'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-18', 'FullControl'), @($other.SID.Value, 'FullControl'))
  $control = Join-Path $data 'control.txt'; [IO.File]::WriteAllText($control, 'synthetic')
  $acl = (Get-Item -LiteralPath $control).GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($other.SID, 'Read, Write', 'Allow')))
  (Get-Item -LiteralPath $control).SetAccessControl($acl)
  if ($CapturePackaged) {
    $apps = Join-Path $lab 'apps'; New-Item -ItemType Directory -Path $apps | Out-Null
    Copy-Artifact $StandaloneDirectory (Join-Path $apps 'standalone')
    Copy-Artifact $CodeDirectory (Join-Path $apps 'code')
  }
  $aclProcess = Start-As $ownerCredential $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $kit 'owner-acl.ps1'), '-Root', $data, '-Installer', (Join-Path $kit 'installer.ps1')) (Join-Path $lab 'acl')
  Wait-ProcessResult $aclProcess
  $server = Start-As $ownerCredential (Join-Path $kit 'node.exe') @((Join-Path $kit 'fixture.cjs'), 'serve', $data) (Join-Path $lab 'pipes')
  Wait-File (Join-Path $data 'pipes.json') $server
  $probe = Start-As $otherCredential $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $kit 'account-probe.ps1'), '-Root', $data, '-Output', (Join-Path $otherOutput 'cross-account.json')) (Join-Path $lab 'probe')
  Wait-ProcessResult $probe
  $cross = Get-Content -Raw -LiteralPath (Join-Path $otherOutput 'cross-account.json') | ConvertFrom-Json
  $valid = $cross.sid -eq $other.SID.Value
  foreach ($row in $cross.results) {
    $expected = if ($row.file -eq 'control.txt') { 'OPENED' } else { 'ACCESS_DENIED' }
    if ($row.result -ne $expected) { $valid = $false }
  }
  if (@($cross.results).Count -ne 8) { $valid = $false }
  $summary.crossAccount = if ($valid) { 'PASS' } else { 'REVIEW: see cross-account.json; connection is not proof of authenticated access' }
  Set-Content -LiteralPath (Join-Path $data 'stop') -Value 'stop'
  Wait-ProcessResult $server

  if ($CapturePackaged) {
    # Run the same real peer module with VS Code's Electron/Node runtime too.
    $electronData = Join-Path $data 'electron'; New-Item -ItemType Directory -Path $electronData | Out-Null
    $electronAcl = Start-As $ownerCredential $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $kit 'owner-acl.ps1'), '-Root', $electronData, '-Installer', (Join-Path $kit 'installer.ps1')) (Join-Path $lab 'electron-acl')
    Wait-ProcessResult $electronAcl
    $electronServer = Start-As $ownerCredential (Join-Path $apps 'code\Code.exe') @((Join-Path $kit 'fixture.cjs'), 'serve', $electronData) (Join-Path $lab 'electron-pipes') -Electron
    Wait-File (Join-Path $electronData 'pipes.json') $electronServer
    # Reuse the file-access controls, whose results were already checked above.
    Copy-Item -LiteralPath (Join-Path $data 'pipes.json') -Destination (Join-Path $data 'pinned-node-pipes.json')
    Copy-Item -LiteralPath (Join-Path $electronData 'pipes.json') -Destination (Join-Path $data 'pipes.json') -Force
    $probe = Start-As $otherCredential $ps @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $kit 'account-probe.ps1'), '-Root', $data, '-Output', (Join-Path $otherOutput 'electron-cross-account.json')) (Join-Path $lab 'electron-probe')
    Wait-ProcessResult $probe
    $electronCross = Get-Content -Raw -LiteralPath (Join-Path $otherOutput 'electron-cross-account.json') | ConvertFrom-Json
    $pipeRows = @($electronCross.results | Where-Object { $_.kind })
    $summary.electronPipes = if ($electronCross.sid -eq $other.SID.Value -and $pipeRows.Count -eq 2 -and @($pipeRows | Where-Object { $_.result -ne 'ACCESS_DENIED' }).Count -eq 0) { 'PASS' } else { 'REVIEW' }
    Set-Content -LiteralPath (Join-Path $electronData 'stop') -Value 'stop'
    Wait-ProcessResult $electronServer
  }
  try {
  # An OS SMB server on this machine, restricted to the synthetic owner account.
  $smbStep = 'create fixture files'
  $smb = Join-Path $lab 'smb'; New-Item -ItemType Directory -Path $smb | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $smb 'repo.git\objects'), (Join-Path $smb 'repo.git\refs') | Out-Null
  [IO.File]::WriteAllText((Join-Path $smb 'sentinel.txt'), 'dormouse-audit-synthetic')
  [IO.File]::WriteAllText((Join-Path $smb 'repo.git\HEAD'), "ref: refs/heads/main`n")
  [IO.File]::WriteAllText((Join-Path $smb 'repo.git\config'), "[core]`nrepositoryformatversion = 0`nbare = true`n")
  [IO.File]::WriteAllText((Join-Path $smb 'config'), "[core]`nrepositoryformatversion = 0`n")
  $smbStep = 'create SMB share'
  Write-Host 'Creating the synthetic SMB share'
  New-SmbShare -Name $shareName -Path $smb -ReadAccess "$env:COMPUTERNAME\$ownerName" | Out-Null
  $shareCreated = $true
  $unc = "\\$env:COMPUTERNAME\$shareName"
  # A directory symlink, not a junction: Windows junctions cannot target UNC.
  $smbStep = 'create directory symlink without inspecting its target'
  New-AuditDirectoryLink -Link (Join-Path $data 'share-link') -Target $unc
  $smbStep = 'start SMB packet capture'
  Start-Capture 'smb'
  $smbStep = 'run SMB positive controls and Git guard probes'
  $gitProcess = Start-As $ownerCredential (Join-Path $kit 'node.exe') @((Join-Path $kit 'fixture.cjs'), 'git', $data, $unc, $GitExe) (Join-Path $lab 'git')
  Wait-ProcessResult $gitProcess
  $smbStep = 'stop and convert SMB capture'
  Stop-Capture 'smb'
  $summary.git = 'REVIEW: refusals and positive control in owner/git.json; SMB capture must show the positive control before a no-contact conclusion'

  } catch {
    $summary.git = 'INCONCLUSIVE: SMB phase did not finish; packaged captures remain independent'
    $summary.gitError = @{ step = $smbStep; message = $_.Exception.Message; location = $_.InvocationInfo.PositionMessage; stack = $_.ScriptStackTrace }
    Write-Warning ("SMB phase failed at {0}: {1}" -f $smbStep, $_.Exception.Message)
    if ($capturing) { Stop-Capture 'smb' }
    Write-Host 'Continuing to the packaged-app captures.'
  }
  if ($CapturePackaged) {
    Stop-LabProcesses
    $fresh = Join-Path $data 'vscode'; New-Item -ItemType Directory -Path $fresh | Out-Null
    # Launch settings/user-data are fresh; the shipped extension directory is copied, never rebuilt.
    $extensions = Join-Path $data 'extensions'; New-Item -ItemType Directory -Path $extensions | Out-Null
    Copy-Artifact $ExtensionDirectory (Join-Path $extensions 'diffplug.dormouse')
    Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $apps 'standalone\dormouse.exe'), (Join-Path $apps 'code\Code.exe'), (Join-Path $extensions 'diffplug.dormouse\package.json'), (Join-Path $extensions 'diffplug.dormouse\dist\extension.js') | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $lab 'artifacts.json')
    Start-Capture 'standalone-first-launch'
    $app = Start-As $ownerCredential (Join-Path $apps 'standalone\dormouse.exe') @() (Join-Path $lab 'standalone') -Visible
    Record-Processes 'standalone-first-launch'
    Write-Host 'In the temporary-account Dormouse window, confirm Settings > Network is Nowhere. Do not enable network features.'
    $summary.standaloneNowhere = Read-Host 'Type NOWHERE only after observing it (anything else leaves this unverified)'
    Stop-Capture 'standalone-first-launch'
    Stop-LabProcesses
    $baseline = Join-Path $data 'vscode-baseline'
    $emptyExtensions = Join-Path $data 'empty-extensions'
    New-Item -ItemType Directory -Path $baseline, $emptyExtensions | Out-Null
    Start-Capture 'vscode-baseline'
    $app = Start-As $ownerCredential (Join-Path $apps 'code\Code.exe') @('--user-data-dir', $baseline, '--extensions-dir', $emptyExtensions, '--disable-extensions', '--new-window', '--skip-welcome', '--skip-release-notes') (Join-Path $lab 'vscode-baseline') -Visible
    Record-Processes 'vscode-baseline' 30
    Stop-Capture 'vscode-baseline'
    Stop-LabProcesses
    Start-Capture 'vscode-first-launch'
    $app = Start-As $ownerCredential (Join-Path $apps 'code\Code.exe') @('--user-data-dir', $fresh, '--extensions-dir', $extensions, '--new-window', '--skip-welcome', '--skip-release-notes') (Join-Path $lab 'vscode') -Visible
    Record-Processes 'vscode-first-launch'
    Write-Host 'In the temporary-account VS Code window run Dormouse: Focus; confirm its Settings > Network is Nowhere. Leave the terminals idle.'
    $summary.vscodeNowhere = Read-Host 'Type NOWHERE after observing the active Dormouse pane and its network setting'
    Record-Processes 'vscode-activated'
    Stop-Capture 'vscode-first-launch'
    $summary.packaged = 'REVIEW REQUIRED: attribute traffic using process timelines, distinguish VS Code/WebView2 traffic, and verify both NOWHERE observations'
  } else { $summary.packaged = 'NOT RUN: use -CapturePackaged with all three artifact directories' }
  $summary.status = 'EVIDENCE COLLECTED; ISSUE NOT YET CLEARED'
} catch {
  $summary.error = $_.Exception.Message
  $summary.errorLocation = $_.InvocationInfo.PositionMessage
  $summary.errorStack = $_.ScriptStackTrace
  Write-Warning ($summary.error + [Environment]::NewLine + $summary.errorLocation)
} finally {
  if ($capturing) {
    & $pktmon stop *> (Join-Path $lab 'capture-final-stop.txt')
    if ($LASTEXITCODE -ne 0) { $summary.cleanup += 'FAILED to stop our PktMon capture' }
  }
  Stop-LabProcesses
  if ($shareCreated) {
    try { Remove-SmbShare -Name $shareName -Force -Confirm:$false } catch { $summary.cleanup += "FAILED share $shareName : $_" }
  }
  foreach ($user in $createdUsers) {
    try {
      $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value }
      if ($profile) {
        $expected = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $env:USERPROFILE) $user.Name))
        $actual = [IO.Path]::GetFullPath($profile.LocalPath)
        if ($actual -ne $expected) { throw "Profile path $actual differs from $expected; kept for manual cleanup" }
        $profile | Remove-CimInstance
      }
    } catch { $summary.cleanup += "FAILED profile cleanup $($user.Name) : $_" }
    try { Remove-LocalUser -SID $user.SID } catch { $summary.cleanup += "FAILED account cleanup $($user.Name) : $_" }
  }
  if (Test-Path -LiteralPath $lab) {
    $summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $lab 'summary.json')
    Write-Host "Evidence: $lab"
    Write-Host "Summary: $(Join-Path $lab 'summary.json')"
  }
}
if ($summary.error -or $summary.gitError -or $summary.cleanup.Count -or $summary.crossAccount -ne 'PASS' -or ($CapturePackaged -and $summary.electronPipes -ne 'PASS')) { exit 1 }
