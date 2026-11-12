#Requires -Version 5.1
<#
Executes the Windows installer's two rollback paths under Windows PowerShell
5.1, the way scripts/installer-verify-test.mjs executes the unix installers:
the functions are taken from the shipped deploy/local/install-windows.ps1 (the
real text, never a copy) and run against a temporary install root.

`manage rollback` (Invoke-Rollback, Restart-DormouseTask and the release
pointer readers) lives inside the installer's $manageBody here-string, so that
string is parsed in turn; the install's own restore after a failed update
(Restore-PreviousRelease) is in the installer body. Only those functions are
loaded: the installer itself never runs.

Everything that would touch the machine is a stub that records its calls:
Get-Task, Stop-ScheduledTask, Start-ScheduledTask, Stop-DormouseProcess,
Wait-Health, Get-ListeningRelease, Set-ReleasePointer (which writes the pointer
file without starting node.exe), Write-Host and Write-Warn2. No task is
started, no process is stopped, and nothing is written outside one directory
under %TEMP%, removed at the end. Start-ScheduledTask fails the way the cmdlet
does, with a non-terminating error that the caller's -ErrorAction decides; what
a real Task Scheduler refuses, and how, is not covered here.

Run from the repo root:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\installer-windows-rollback-test.ps1
-InstallerPath runs the same cases against another copy of the installer, such
as an older one. Prints one line per case, with what was expected and what
happened under any that failed, and exits 1 if any case failed.
#>
param([string]$InstallerPath)

$ErrorActionPreference = 'Stop'

if (-not $InstallerPath) {
  $InstallerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy\local\install-windows.ps1'
}
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
[Console]::WriteLine("installer: $InstallerPath")
[Console]::WriteLine("PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))")

# ------------------------------------------------------------- extraction ---

function Get-ParsedScript {
  param([string]$Text, [string]$Path, [string]$Where)
  $tokens = $null
  $parseErrors = $null
  if ($Path) {
    $parsed = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
  } else {
    $parsed = [System.Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$parseErrors)
  }
  if ($parseErrors -and $parseErrors.Count -gt 0) {
    throw "$Where does not parse: line $($parseErrors[0].Extent.StartLineNumber): $($parseErrors[0].Message)"
  }
  return $parsed
}

function Get-FunctionSource {
  param($Ast, [string]$Name, [string]$Where)
  $predicate = {
    param($node)
    ($node -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($node.Name -eq $Name)
  }.GetNewClosure()
  $found = @($Ast.FindAll($predicate, $true))
  if ($found.Count -ne 1) { throw "expected one definition of $Name in $Where, found $($found.Count)" }
  return $found[0].Extent.Text
}

try {
  $installerAst = Get-ParsedScript -Path $InstallerPath -Where 'the installer'
  $assignments = @($installerAst.FindAll({
        param($node)
        ($node -is [System.Management.Automation.Language.AssignmentStatementAst]) -and ($node.Left.Extent.Text -eq '$manageBody')
      }, $true))
  if ($assignments.Count -ne 1) { throw "expected one assignment to `$manageBody, found $($assignments.Count)" }
  $bodyString = $assignments[0].Right.Find({
      param($node)
      $node -is [System.Management.Automation.Language.StringConstantExpressionAst]
    }, $true)
  if (-not $bodyString) { throw '$manageBody is not assigned a literal string' }
  $manageAst = Get-ParsedScript -Text $bodyString.Value -Where 'the manage script ($manageBody)'

  $sources = @()
  foreach ($name in 'Get-ReleasePointer', 'Get-CurrentRelease', 'Get-PreviousRelease', 'Restart-DormouseTask', 'Invoke-Rollback') {
    $sources += Get-FunctionSource -Ast $manageAst -Name $name -Where 'the manage script'
  }
  $sources += Get-FunctionSource -Ast $installerAst -Name 'Restore-PreviousRelease' -Where 'the installer'
} catch {
  [Console]::WriteLine("FAIL  loading the functions: $($_.Exception.Message)")
  exit 1
}
# Dot-sourced at script scope, so the functions resolve the stubs and settings
# below exactly as they resolve the installer's own definitions.
. ([ScriptBlock]::Create($sources -join "`n`n"))

# ------------------------------------------------------------------ stubs ---

$script:Calls = New-Object System.Collections.Generic.List[string]
$script:Said = New-Object System.Collections.Generic.List[string]
$script:TaskRegistered = $true
$script:StartRefused = $false
$script:Serving = $null

function Get-Task {
  if ($script:TaskRegistered) { return [pscustomobject]@{ TaskName = $LABEL; TaskPath = $TASK_PATH } }
}

function Stop-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [string]$TaskPath)
  $script:Calls.Add('Stop-ScheduledTask')
}

function Start-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [string]$TaskPath)
  $script:Calls.Add('Start-ScheduledTask')
  if (-not $script:TaskRegistered) {
    Write-Error "stub: no task $TaskPath$TaskName is registered"
    return
  }
  if ($script:StartRefused) {
    Write-Error "stub: Task Scheduler refused to start $TaskPath$TaskName"
    return
  }
}

function Stop-DormouseProcess {
  param([string]$Root)
  $script:Calls.Add('Stop-DormouseProcess')
  return 0
}

# Every case has the target release answering, so only the task start decides
# whether a rollback succeeds.
function Wait-Health {
  param([string]$Url, [int]$Seconds = 30, [string]$ExpectedRelease = '')
  $script:Calls.Add('Wait-Health')
  return $true
}

function Get-ListeningRelease {
  param([int]$Port)
  return $script:Serving
}

# With $script:PointerWriteFails the write does not land, and, like the
# installer's Die, ends the run unless the caller asked for -WarnOnFailure.
function Set-ReleasePointer {
  param([string]$ReleaseId, [string]$PointerPath, [string]$NodeBin, [switch]$WarnOnFailure)
  $script:Calls.Add("Set-ReleasePointer $(Split-Path -Leaf $PointerPath)=$ReleaseId with $NodeBin")
  if ($script:PointerWriteFails) {
    if ($WarnOnFailure) { Write-Warn2 "stub: could not write $PointerPath"; return }
    throw "stub: Die (exit 1) on the failed write of $PointerPath"
  }
  [IO.File]::WriteAllText($PointerPath, "$ReleaseId`n")
}

function Write-Host { $script:Said.Add(($args -join ' ')) }
function Write-Warn2 { param([string]$Text) $script:Said.Add($Text) }

# ---------------------------------------------------------------- settings ---

$LABEL = 'DormouseRollbackTest'
$TASK_PATH = '\DormouseRollbackTest\'
$PORT = '3100'
$LOOPBACK_PORT = '3100'
$TEST_MODE = $false
$C_RED = ''; $C_GRN = ''; $C_YEL = ''; $C_DIM = ''; $C_OFF = ''

$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ('dormouse-rollback-test-' + [Guid]::NewGuid().ToString('N'))
$script:Failed = 0
$script:Total = 0

# An install whose `current` is release "new" and whose `previous` is release
# "old", the rollback target. "new" always has a runtime; "old" only when asked.
function New-InstallTree {
  param([string]$CaseDir, [bool]$TargetRuntime)
  $tree = Join-Path $TempRoot $CaseDir
  foreach ($release in 'old', 'new') {
    [void][IO.Directory]::CreateDirectory((Join-Path $tree "releases\$release\runtime"))
  }
  [IO.File]::WriteAllText((Join-Path $tree 'releases\new\runtime\node.exe'), '')
  if ($TargetRuntime) { [IO.File]::WriteAllText((Join-Path $tree 'releases\old\runtime\node.exe'), '') }
  [IO.File]::WriteAllText((Join-Path $tree 'current.txt'), "new`n")
  [IO.File]::WriteAllText((Join-Path $tree 'previous.txt'), "old`n")
  [void][IO.Directory]::CreateDirectory((Join-Path $tree 'logs'))
  return $tree
}

function Get-PointerText {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '(none)' }
  return ([IO.File]::ReadAllText($Path)).Trim()
}

function Reset-Stub {
  param([bool]$Registered, [bool]$Refused)
  $script:Calls.Clear()
  $script:Said.Clear()
  $script:TaskRegistered = $Registered
  $script:StartRefused = $Refused
  $script:Serving = 'old'
  $script:PointerWriteFails = $false
}

# Runs one function with stderr captured. Result is its pipeline output joined
# with ',', so a stray value written beside the return code shows up too.
function Invoke-Captured {
  param([scriptblock]$Body)
  $errWriter = New-Object IO.StringWriter
  $savedErr = [Console]::Error
  [Console]::SetError($errWriter)
  $threw = ''
  $output = @()
  try {
    $output = @(& $Body)
  } catch {
    $threw = $_.Exception.Message
  } finally {
    [Console]::SetError($savedErr)
  }
  $starts = @($script:Calls | Where-Object { $_ -eq 'Start-ScheduledTask' }).Count
  $waits = @($script:Calls | Where-Object { $_ -eq 'Wait-Health' }).Count
  return [pscustomobject]@{
    Result = (($output | ForEach-Object { "$_" }) -join ',')
    Threw = $threw
    Stderr = $errWriter.ToString().Trim()
    Said = ($script:Said -join ' | ')
    Calls = ($script:Calls -join '; ')
    Starts = $starts
    Waits = $waits
  }
}

function Compare-Expectation {
  param([string]$What, $Expected, $Actual)
  if ("$Expected" -cne "$Actual") { "${What}: expected '$Expected', got '$Actual'" }
}

function Write-CaseResult {
  param([string]$Case, $Run, [object[]]$Problems)
  $script:Total++
  $Problems = @($Problems | Where-Object { $_ })
  if ($Run.Threw) { $Problems += "threw: $($Run.Threw)" }
  if ($Problems.Count -eq 0) {
    [Console]::WriteLine("ok    $Case")
    return
  }
  $script:Failed++
  [Console]::WriteLine("FAIL  $Case")
  foreach ($p in $Problems) { [Console]::WriteLine("        $p") }
  [Console]::WriteLine("        calls:  $($Run.Calls)")
  [Console]::WriteLine("        output: $($Run.Said)")
  if ($Run.Stderr) { [Console]::WriteLine("        stderr: $($Run.Stderr)") }
}

# ------------------------------------------------------------------- cases ---

function Invoke-RollbackCase {
  param([string]$CaseDir, [bool]$TargetRuntime = $true, [bool]$Registered = $true, [bool]$Refused = $false)
  $script:Root = New-InstallTree -CaseDir $CaseDir -TargetRuntime $TargetRuntime
  $script:CurrentPointer = Join-Path $script:Root 'current.txt'
  $script:PreviousPointer = Join-Path $script:Root 'previous.txt'
  Reset-Stub -Registered $Registered -Refused $Refused
  $run = Invoke-Captured { Invoke-Rollback }
  $run | Add-Member -NotePropertyName Current -NotePropertyValue (Get-PointerText $script:CurrentPointer)
  $run | Add-Member -NotePropertyName Previous -NotePropertyValue (Get-PointerText $script:PreviousPointer)
  $currentRuntime = Join-Path $script:Root 'releases\new\runtime'
  $run | Add-Member -NotePropertyName UsedCurrentRuntime -NotePropertyValue ($run.Calls.IndexOf($currentRuntime, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  $run | Add-Member -NotePropertyName ClaimedHealthy -NotePropertyValue ($run.Said -match 'rolled back and healthy')
  return $run
}

function Invoke-RestoreCase {
  param([string]$CaseDir, [bool]$Refused = $false, [bool]$WriteFails = $false)
  $script:INSTALL_ROOT = New-InstallTree -CaseDir $CaseDir -TargetRuntime $true
  $script:CURRENT_POINTER = Join-Path $script:INSTALL_ROOT 'current.txt'
  $script:PREVIOUS_POINTER = Join-Path $script:INSTALL_ROOT 'previous.txt'
  $script:LOG_DIR = Join-Path $script:INSTALL_ROOT 'logs'
  # The release the failed update just switched to, whose runtime the install
  # verified; the restore writes the pointer with it.
  $script:STAGED_NODE = Join-Path $script:INSTALL_ROOT 'releases\new\runtime\node.exe'
  $script:OLD_RELEASE = 'old'
  Reset-Stub -Registered $true -Refused $Refused
  $script:PointerWriteFails = $WriteFails
  $run = Invoke-Captured { Restore-PreviousRelease }
  $run | Add-Member -NotePropertyName Current -NotePropertyValue (Get-PointerText $script:CURRENT_POINTER)
  $run | Add-Member -NotePropertyName Previous -NotePropertyValue (Get-PointerText $script:PREVIOUS_POINTER)
  $run | Add-Member -NotePropertyName ClaimedHealthy -NotePropertyValue ($run.Said -match 'healthy again')
  return $run
}

try {
  $case = 'manage rollback: swaps to a target with its own runtime and reports healthy'
  $r = Invoke-RollbackCase -CaseDir 'rollback-healthy'
  Write-CaseResult $case $r @(
    (Compare-Expectation 'exit code' '0' $r.Result),
    (Compare-Expectation 'current.txt' 'old' $r.Current),
    (Compare-Expectation 'previous.txt' 'new' $r.Previous),
    (Compare-Expectation 'pointers written with the runtime of the release rolled away from' $false $r.UsedCurrentRuntime),
    (Compare-Expectation 'task starts' 1 $r.Starts),
    (Compare-Expectation 'printed "rolled back and healthy"' $true $r.ClaimedHealthy)
  )

  $case = 'manage rollback: refuses a target with no runtime\node.exe and never uses the current release''s'
  $r = Invoke-RollbackCase -CaseDir 'rollback-no-runtime' -TargetRuntime $false
  Write-CaseResult $case $r @(
    (Compare-Expectation 'exit code' '1' $r.Result),
    (Compare-Expectation 'current.txt' 'new' $r.Current),
    (Compare-Expectation 'previous.txt' 'old' $r.Previous),
    (Compare-Expectation 'pointers written with the runtime of the release rolled away from' $false $r.UsedCurrentRuntime),
    (Compare-Expectation 'task starts' 0 $r.Starts),
    (Compare-Expectation 'printed "rolled back and healthy"' $false $r.ClaimedHealthy)
  )

  $case = 'manage rollback: a refused task start is reported at once and exits 1'
  $r = Invoke-RollbackCase -CaseDir 'rollback-start-refused' -Refused $true
  Write-CaseResult $case $r @(
    (Compare-Expectation 'exit code' '1' $r.Result),
    (Compare-Expectation 'current.txt' 'old' $r.Current),
    (Compare-Expectation 'task starts' 1 $r.Starts),
    (Compare-Expectation 'health waits after the failed start' 0 $r.Waits),
    (Compare-Expectation 'printed "rolled back and healthy"' $false $r.ClaimedHealthy),
    (Compare-Expectation 'the failure was written to stderr' $true ([bool]$r.Stderr))
  )

  $case = 'manage rollback: an unregistered task is reported at once and exits 1'
  $r = Invoke-RollbackCase -CaseDir 'rollback-unregistered' -Registered $false
  Write-CaseResult $case $r @(
    (Compare-Expectation 'exit code' '1' $r.Result),
    (Compare-Expectation 'task starts attempted' 1 $r.Starts),
    (Compare-Expectation 'health waits after the failed start' 0 $r.Waits),
    (Compare-Expectation 'printed "rolled back and healthy"' $false $r.ClaimedHealthy),
    (Compare-Expectation 'the failure was written to stderr' $true ([bool]$r.Stderr))
  )

  $case = 'install restore: a restored release whose task starts is healthy again'
  $r = Invoke-RestoreCase -CaseDir 'restore-healthy'
  Write-CaseResult $case $r @(
    (Compare-Expectation 'result' 'True' $r.Result),
    (Compare-Expectation 'current.txt' 'old' $r.Current),
    (Compare-Expectation 'previous.txt' '(none)' (Get-PointerText $script:PREVIOUS_POINTER)),
    (Compare-Expectation 'task starts' 1 $r.Starts),
    (Compare-Expectation 'printed "healthy again"' $true $r.ClaimedHealthy)
  )

  $case = 'install restore: a refused task start is reported at once and fails'
  $r = Invoke-RestoreCase -CaseDir 'restore-start-refused' -Refused $true
  Write-CaseResult $case $r @(
    (Compare-Expectation 'result' 'False' $r.Result),
    (Compare-Expectation 'current.txt' 'old' $r.Current),
    (Compare-Expectation 'task starts' 1 $r.Starts),
    (Compare-Expectation 'health waits after the failed start' 0 $r.Waits),
    (Compare-Expectation 'printed "healthy again"' $false $r.ClaimedHealthy)
  )

  # The caller prints "update FAILED" only if the restore returns, so a failed
  # pointer write must not end the run, and previous.txt is the only way back.
  $case = 'install restore: a pointer write that does not land returns, keeps previous.txt, and fails'
  $r = Invoke-RestoreCase -CaseDir 'restore-write-fails' -WriteFails $true
  Write-CaseResult $case $r @(
    (Compare-Expectation 'result' 'False' $r.Result),
    (Compare-Expectation 'current.txt' 'new' $r.Current),
    (Compare-Expectation 'previous.txt' 'old' $r.Previous),
    (Compare-Expectation 'task starts' 0 $r.Starts),
    (Compare-Expectation 'printed "healthy again"' $false $r.ClaimedHealthy)
  )
} finally {
  if (Test-Path -LiteralPath $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force }
}

if ($script:Failed -gt 0) {
  [Console]::WriteLine("$($script:Failed) of $($script:Total) cases failed")
  exit 1
}
[Console]::WriteLine("all $($script:Total) cases passed")
exit 0
