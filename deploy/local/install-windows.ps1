#Requires -Version 5.1
#
# Install the Dormouse coordinating server on this PC as a per-user Scheduled
# Task, fronted by `tailscale serve` on the node's own HTTPS name.
#
# Running this a second time updates the installed release from the current
# checkout. It never pulls, fetches, switches branches, or installs an updater:
# the checkout you are standing in is the release source.
#
# See SELF_HOST.md for the runbook and docs/specs/server.md for the runtime
# contract this installs. This is the Windows sibling of install-macos.sh; the
# two hold the same invariants through different native mechanisms.
#
# Usage:
#   .\deploy\local\install-windows.ps1 [-Yes]
#
# Environment:
#   DORMOUSE_INSTALL_TEST=1   Build, stage, health-check and switch releases,
#                             but do not touch the Scheduled Task or the Serve
#                             config.
#   DORMOUSE_INSTALL_ROOT     A throwaway install root (requires the above), so
#                             path quoting and release switching can be tested.

[CmdletBinding()]
param(
  [Alias('y')][switch]$Yes,
  [Alias('h')][switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Get-Content -LiteralPath $PSCommandPath | Select-Object -Skip 1 -First 22 |
    ForEach-Object { $_ -replace '^# ?', '' }
  exit 0
}

$LABEL = 'Dormouse Server'
$TASK_PATH = '\'
$INSTALL_ROOT = Join-Path $env:LOCALAPPDATA 'Dormouse Server'
$LOOPBACK_PORT = 3100

$ASSUME_YES = $Yes.IsPresent
if ($env:DORMOUSE_INSTALL_ASSUME_YES -eq '1') { $ASSUME_YES = $true }
$TEST_MODE = ($env:DORMOUSE_INSTALL_TEST -eq '1')

# A throwaway install root, for exercising path quoting, task generation,
# release switching and cleanup without touching the real installation. Gated to
# test mode on purpose: a real install belongs in the documented location, and
# an overridden root would leave `manage` and the Scheduled Task disagreeing
# about where the service lives.
if ($env:DORMOUSE_INSTALL_ROOT) {
  if (-not $TEST_MODE) {
    [Console]::Error.WriteLine('DORMOUSE_INSTALL_ROOT is only honored with DORMOUSE_INSTALL_TEST=1')
    exit 64
  }
  $INSTALL_ROOT = $env:DORMOUSE_INSTALL_ROOT
}

$LOG_DIR = Join-Path $INSTALL_ROOT 'logs'

# ---------------------------------------------------------------- output ----

# The analog of `[ -t 1 ]`: SupportsVirtualTerminal describes the host, not the
# stream, so it stays true when stdout is redirected to a file or a pipe and the
# escapes would land there as literal text.
$script:UseColor = $false
try {
  $script:UseColor = [bool]$Host.UI.SupportsVirtualTerminal -and -not [Console]::IsOutputRedirected
} catch { $script:UseColor = $false }
if ($script:UseColor) {
  $E = [char]27
  $C_DIM = "$E[2m"; $C_RED = "$E[31m"; $C_GRN = "$E[32m"
  $C_YEL = "$E[33m"; $C_BLD = "$E[1m"; $C_OFF = "$E[0m"
} else {
  $C_DIM = ''; $C_RED = ''; $C_GRN = ''; $C_YEL = ''; $C_BLD = ''; $C_OFF = ''
}

function Write-Step { param([string]$Text) Write-Host ""; Write-Host "$C_BLD==>$C_OFF $C_BLD$Text$C_OFF" }
function Write-Info { param([string]$Text) Write-Host "    $Text" }
function Write-Detail { param([string]$Text) Write-Host "    $C_DIM$Text$C_OFF" }
function Write-Ok { param([string]$Text) Write-Host "    $C_GRN$([char]0x2713)$C_OFF $Text" }
function Write-Warn2 { param([string]$Text) Write-Host "    $C_YEL!$C_OFF $Text" }
function Die {
  param([string]$Text)
  Write-Host ""
  Write-Host "${C_RED}error:$C_OFF $Text"
  exit 1
}

function Confirm-Step {
  param([string]$Prompt)
  if ($ASSUME_YES) { Write-Detail "$Prompt [auto-yes]"; return $true }
  if ([Console]::IsInputRedirected) {
    Die "$Prompt -- refusing to assume an answer with no terminal. Re-run with -Yes if that is what you want."
  }
  $reply = Read-Host "    $Prompt [y/N]"
  return @('y', 'Y', 'yes', 'YES') -contains $reply
}

# --------------------------------------------------------------- helpers ----

# Quote an argument vector into the single command line Start-Process wants.
#
# Passing -ArgumentList an ARRAY lets PowerShell apply its own weak quoting,
# which a `.CMD` shim's cmd.exe then strips a second time: an argument holding a
# space arrives at the target as two arguments. `%LOCALAPPDATA%\Dormouse Server`
# holds a space, so this is not hypothetical -- it is why `pnpm deploy` failed
# with ERR_PNPM_INVALID_DEPLOY_TARGET. One pre-quoted string survives both hops.
# Windows filenames cannot contain `"`, so the escape here only has to be sane,
# not exhaustive.
function ConvertTo-NativeArgLine {
  param([string[]]$Arguments)
  $parts = @()
  foreach ($a in $Arguments) {
    if ($a -eq '' -or $a -match '[\s"]') { $parts += '"' + ($a -replace '"', '\"') + '"' }
    else { $parts += $a }
  }
  return ($parts -join ' ')
}

# Run a native executable, capturing stdout and stderr separately. Windows
# PowerShell 5.1 wraps a native command's stderr in ErrorRecords when it is
# redirected inline, which sets $? to false even on a clean exit; going through
# Start-Process avoids that entirely.
function Invoke-Native {
  param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [string]$WorkDir)
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $splat = @{
      FilePath               = $FilePath
      NoNewWindow            = $true
      Wait                   = $true
      PassThru               = $true
      RedirectStandardOutput = $outFile
      RedirectStandardError  = $errFile
    }
    if ($Arguments -and $Arguments.Count -gt 0) { $splat['ArgumentList'] = (ConvertTo-NativeArgLine $Arguments) }
    if ($WorkDir) { $splat['WorkingDirectory'] = $WorkDir }
    $proc = Start-Process @splat
    $out = ''
    $err = ''
    if (Test-Path -LiteralPath $outFile) { $out = [IO.File]::ReadAllText($outFile) }
    if (Test-Path -LiteralPath $errFile) { $err = [IO.File]::ReadAllText($errFile) }
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; StdOut = $out; StdErr = $err }
  } finally {
    foreach ($f in @($outFile, $errFile)) {
      if (Test-Path -LiteralPath $f) { [IO.File]::Delete($f) }
    }
  }
}

# Run a JavaScript snippet through Node, via a temp file rather than `node -e`.
#
# `node -e '<js>'` cannot survive the trip: an argument holding quotes and
# parentheses is re-quoted by Start-Process and then, whenever the target is a
# `.CMD` shim like pnpm's, re-parsed by cmd.exe -- which fails on the bare
# parentheses with "was unexpected at this time". A path has none of those
# characters, so passing a file always works.
#
# Note the argv shift this implies: `node file.js a` puts `a` at argv[2], where
# `node -e code a` would have put it at argv[1].
function Invoke-NodeScript {
  param(
    [Parameter(Mandatory)][string]$NodeBin,
    [Parameter(Mandatory)][string]$Script,
    [string[]]$Arguments = @()
  )
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('dormouse-' + [Guid]::NewGuid().ToString('N') + '.js')
  try {
    [IO.File]::WriteAllText($tmp, $Script)
    return Invoke-Native -FilePath $NodeBin -Arguments (@($tmp) + $Arguments)
  } finally {
    if (Test-Path -LiteralPath $tmp) { [IO.File]::Delete($tmp) }
  }
}

# Walk a dotted path through a ConvertFrom-Json object. Arrays join with commas,
# mirroring json_query in install-macos.sh.
function Get-JsonValue {
  param([Parameter(Mandatory)]$Object, [Parameter(Mandatory)][string]$Path)
  $cur = $Object
  foreach ($key in $Path.Split('.')) {
    if ($null -eq $cur) { return $null }
    $prop = $cur.PSObject.Properties[$key]
    if (-not $prop) { return $null }
    $cur = $prop.Value
  }
  if ($null -eq $cur) { return $null }
  if ($cur -is [array]) { return ($cur -join ',') }
  return [string]$cur
}

# Replace the release pointer atomically.
#
# Windows has no unprivileged replaceable directory symlink: a junction cannot
# be renamed over an existing junction, and Move-Item -Force on a directory is a
# delete-then-move with a window where `current` names nothing. So the pointer is
# a FILE holding the release id, and it is swapped with rename(2) semantics --
# MoveFileEx(MOVEFILE_REPLACE_EXISTING) via Node's fs.renameSync -- which does
# replace an existing file atomically.
# $NodeBin is used rather than .NET because File.Move(overwrite) does not exist
# in the .NET Framework that Windows PowerShell 5.1 runs on.
function Set-ReleasePointer {
  param(
    [Parameter(Mandatory)][string]$ReleaseId,
    [Parameter(Mandatory)][string]$PointerPath,
    [Parameter(Mandatory)][string]$NodeBin
  )
  $script = @'
const fs = require("fs");
const value = process.argv[2];
const link = process.argv[3];
const tmp = link + ".swap." + process.pid;
try { fs.unlinkSync(tmp); } catch (e) { /* no stale temp file */ }
fs.writeFileSync(tmp, value + "\n", { encoding: "utf8" });
fs.renameSync(tmp, link);
'@
  $r = Invoke-NodeScript -NodeBin $NodeBin -Script $script -Arguments @($ReleaseId, $PointerPath)
  if ($r.ExitCode -ne 0) { Die "could not write the release pointer $PointerPath : $(Get-FailureTail $r)" }
}

function Get-ReleasePointer {
  param([Parameter(Mandatory)][string]$PointerPath)
  if (-not (Test-Path -LiteralPath $PointerPath -PathType Leaf)) { return $null }
  $value = ([IO.File]::ReadAllText($PointerPath)).Trim()
  if (-not $value) { return $null }
  return $value
}

# The Windows analog of chmod 0700 / 0600: break inheritance and leave exactly
# one ACE, for the installing user. Administrators and SYSTEM are dropped for
# the same reason macOS drops group and other -- an administrator can still take
# ownership, exactly as root can still read a 0600 file, and the point is that
# no ordinary second account on this PC can read the setup password or the
# Host bearer credentials in state/.
# Built from a FRESH security object rather than Get-Acl + Set-Acl.
#
# Get-Acl returns owner, group and audit sections alongside the DACL, and
# Set-Acl writes back every section the object carries -- which needs
# SeSecurityPrivilege for the SACL and therefore fails unelevated. That failure
# does not appear on a first install, only once the DACL is already protected,
# so it would have broken exactly the idempotent re-run this installer exists
# to support. A new DirectorySecurity/FileSecurity carries only the rules added
# here, so SetAccessControl writes the DACL alone and needs no privilege.
function Protect-Path {
  param([Parameter(Mandatory)][string]$Path, [switch]$Directory)
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($Directory) {
    $sec = New-Object System.Security.AccessControl.DirectorySecurity
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $sec = New-Object System.Security.AccessControl.FileSecurity
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  # ($true, $false) = break inheritance and do NOT copy the inherited entries,
  # so %LOCALAPPDATA%'s SYSTEM and Administrators ACEs do not survive.
  $sec.SetAccessRuleProtection($true, $false)
  $ace = New-Object Security.AccessControl.FileSystemAccessRule(
    $me,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  $sec.AddAccessRule($ace)
  (Get-Item -LiteralPath $Path -Force).SetAccessControl($sec)
}

# The tail of whatever a failed command actually said. pnpm reports its errors
# on STDOUT -- ERR_PNPM_INVALID_DEPLOY_TARGET never touches stderr -- so quoting
# only stderr produces a failure message with nothing in it.
function Get-FailureTail {
  param($Result, [int]$Lines = 12)
  $text = (($Result.StdErr + "`n" + $Result.StdOut) -split "`r?`n" | Where-Object { $_.Trim() })
  if (-not $text) { return '(the command produced no output)' }
  return (($text | Select-Object -Last $Lines) -join "`n")
}

function Test-Health {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 3)
  try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -MaximumRedirection 0
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400)
  } catch {
    return $false
  }
}

function Wait-Health {
  param([Parameter(Mandatory)][string]$Url, [int]$Seconds = 30)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health -Url $Url -TimeoutSec 2) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function New-Directory {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    [void][IO.Directory]::CreateDirectory($Path)
  }
}

# The `rm -rf` the macOS installer gets for free.
#
# pnpm hardlinks packages out of its content-addressable store with the
# read-only attribute set, and on Windows both Directory.Delete and Remove-Item
# refuse to unlink a read-only file. Every release tree contains hundreds of
# them, so staging over a partial release, pruning, and uninstalling all hit
# this. Clear the attribute first, then delete.
function Remove-Tree {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) {
      try { $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) } catch { }
    }
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
}

# ------------------------------------------------------------- preflight ----

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  Die "this installer is Windows-only (found $([Environment]::OSVersion.Platform)). See SELF_HOST.md Prerequisites -- design the native service manager with the user rather than translating Scheduled Task commands."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Die "do not run this elevated. It installs only into your user profile and needs no administrator rights; an elevated run would lock the install to the wrong account and register the Scheduled Task for the wrong principal."
}
$USER_ID = $identity.Name

$SCRIPT_DIR = $PSScriptRoot
$REPO_ROOT = (Resolve-Path (Join-Path $SCRIPT_DIR '..\..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $REPO_ROOT 'pnpm-workspace.yaml'))) {
  Die "cannot locate the repository root from $SCRIPT_DIR"
}

$POWERSHELL_EXE = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $POWERSHELL_EXE)) {
  Die "cannot find Windows PowerShell at $POWERSHELL_EXE -- the Scheduled Task action needs an absolute interpreter path, because Task Scheduler does not read your interactive PATH."
}

# --------------------------------------------------------------- tailscale --

$TS_BIN = $null
$tsCmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if ($tsCmd) {
  $TS_BIN = $tsCmd.Source
} else {
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'),
      (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe'))) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $TS_BIN = $candidate; break }
  }
}
if (-not $TS_BIN) {
  Die "tailscale.exe not found on PATH or in Program Files\Tailscale. Install Tailscale and sign in first -- this installer will not install or reauthenticate it for you. https://tailscale.com/docs/install/windows"
}

function Invoke-Tailscale {
  param([string[]]$Arguments)
  return Invoke-Native -FilePath $TS_BIN -Arguments $Arguments
}

# ------------------------------------------------------------------ start ----

Write-Host "$C_BLD Dormouse selfhost server -- Windows installer$C_OFF"
if ($TEST_MODE) { Write-Warn2 "DORMOUSE_INSTALL_TEST=1 -- the Scheduled Task and Serve will not be touched." }

Write-Step "Checking Tailscale"

$tsStatus = Invoke-Tailscale @('status', '--json')
if ($tsStatus.ExitCode -ne 0) {
  $detail = ($tsStatus.StdErr + $tsStatus.StdOut).Trim()
  # Windows tailscaled hands its LocalAPI to one interactive user at a time.
  # On a machine with a second signed-in profile this is by far the most common
  # failure, and the raw 401 does not say what to do about it.
  if ($detail -match 'already in use by\s+(\S+)') {
    Die @"
Tailscale's local API is currently owned by another Windows user on this PC:

    $detail

Windows tailscaled serves its local API to one interactive session at a time.
Sign that user out (or have them quit the Tailscale tray app), then re-run.
You are running as $USER_ID.
"@
  }
  Die "``tailscale status --json`` failed. Is Tailscale running and signed in?`n$detail"
}

try {
  $tsJson = $tsStatus.StdOut | ConvertFrom-Json
} catch {
  Die "could not parse ``tailscale status --json`` output: $($_.Exception.Message)"
}

$TS_BACKEND = Get-JsonValue -Object $tsJson -Path 'BackendState'
if ($TS_BACKEND -ne 'Running') {
  Die "Tailscale backend state is '$(if ($TS_BACKEND) { $TS_BACKEND } else { 'unknown' })', expected 'Running'. Sign in and connect, then re-run."
}

$TS_DNS_RAW = Get-JsonValue -Object $tsJson -Path 'Self.DNSName'
if (-not $TS_DNS_RAW) {
  Die "Tailscale reports no MagicDNS name for this node. Enable MagicDNS for the tailnet: https://login.tailscale.com/admin/dns"
}
# MagicDNS names arrive fully qualified with a trailing dot.
$TS_DNS = $TS_DNS_RAW.TrimEnd('.')

$MAGIC_DNS = Get-JsonValue -Object $tsJson -Path 'CurrentTailnet.MagicDNSEnabled'
if ($MAGIC_DNS -ne 'True' -and $MAGIC_DNS -ne 'true') {
  Write-Warn2 "MagicDNS is not reported as enabled for this tailnet; the HTTPS name may not resolve for other devices."
}

$ORIGIN = "https://$TS_DNS"
Write-Ok "node: $TS_DNS"
Write-Ok "external origin: $ORIGIN"

$CERT_DOMAINS = Get-JsonValue -Object $tsJson -Path 'CertDomains'
if ($CERT_DOMAINS -and (",$CERT_DOMAINS," -like "*,$TS_DNS,*")) {
  Write-Ok "tailnet HTTPS certificates enabled for this name"
} else {
  Write-Warn2 "tailnet HTTPS certificates do not list $TS_DNS."
  Write-Warn2 "Enable HTTPS at https://login.tailscale.com/admin/dns -- Serve cannot get a certificate without it."
  Write-Warn2 "Tailscale may also prompt for consent the first time Serve requests one."
}

# --------------------------------------------------------- origin identity ---

$CONFIG_DIR = Join-Path $INSTALL_ROOT 'config'
$ENV_FILE = Join-Path $CONFIG_DIR 'server.env'
$STATE_DIR = Join-Path $INSTALL_ROOT 'state'
$RELEASES_DIR = Join-Path $INSTALL_ROOT 'releases'
$BIN_DIR = Join-Path $INSTALL_ROOT 'bin'
$CURRENT_POINTER = Join-Path $INSTALL_ROOT 'current.txt'
$PREVIOUS_POINTER = Join-Path $INSTALL_ROOT 'previous.txt'

$FIRST_INSTALL = $true
if (Test-Path -LiteralPath $ENV_FILE) {
  $FIRST_INSTALL = $false
  $existingOrigin = ''
  foreach ($line in [IO.File]::ReadAllLines($ENV_FILE)) {
    if ($line -match '^DORMOUSE_ORIGIN=(.*)$') { $existingOrigin = $Matches[1].Trim('"'); break }
  }
  if ($existingOrigin -and $existingOrigin -ne $ORIGIN) {
    Write-Host ""
    Write-Warn2 "This machine already has an installation bound to a DIFFERENT origin."
    Write-Warn2 "  installed: $existingOrigin"
    Write-Warn2 "  derived:   $ORIGIN"
    Write-Warn2 ""
    Write-Warn2 "DORMOUSE_ORIGIN is durable WebAuthn identity: it is the source of the"
    Write-Warn2 "passkey rpId and of the Host's ConnectionPolicy. Rewriting it invalidates"
    Write-Warn2 "the registered passkey and every enrolled Host -- they must be re-enrolled."
    Write-Warn2 ""
    Write-Warn2 "This usually means the Tailscale node was renamed or re-enrolled."
    Die "refusing to silently rewrite the origin. Decide deliberately: restore the old node name, or plan the passkey + Host re-enrollment and remove $ENV_FILE by hand."
  }
}

# ----------------------------------------------------------------- source ----

Write-Step "Checking the source checkout"

function Invoke-Git {
  param([string[]]$Arguments)
  return Invoke-Native -FilePath 'git.exe' -Arguments (@('-C', $REPO_ROOT) + $Arguments)
}

$r = Invoke-Git @('rev-parse', 'HEAD')
$GIT_SHA = if ($r.ExitCode -eq 0) { $r.StdOut.Trim() } else { 'unknown' }
$r = Invoke-Git @('rev-parse', '--short', 'HEAD')
$GIT_SHORT = if ($r.ExitCode -eq 0) { $r.StdOut.Trim() } else { 'unknown' }
$r = Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')
$GIT_BRANCH = if ($r.ExitCode -eq 0) { $r.StdOut.Trim() } else { 'unknown' }
$r = Invoke-Git @('status', '--porcelain')
$GIT_STATUS = if ($r.ExitCode -eq 0) { $r.StdOut } else { '' }
$GIT_DIRTY = if ($GIT_STATUS.Trim()) { 'true' } else { 'false' }
$ARCH = $env:PROCESSOR_ARCHITECTURE

Write-Info "checkout: $REPO_ROOT"
Write-Info "branch:   $GIT_BRANCH"
Write-Info "commit:   $GIT_SHA"
Write-Info "arch:     $ARCH"
if ($GIT_DIRTY -eq 'true') {
  Write-Warn2 "the worktree is DIRTY -- the installed release will not be identified by its SHA alone."
  foreach ($line in $GIT_STATUS.Split("`n")) { if ($line.Trim()) { Write-Host "      $($line.TrimEnd())" } }
  if (-not (Confirm-Step "Install this dirty worktree?")) { Die "aborted at the user's request." }
} else {
  Write-Ok "worktree clean"
}

$rootPkg = Get-Content -Raw -LiteralPath (Join-Path $REPO_ROOT 'package.json') | ConvertFrom-Json
$NODE_PIN = Get-JsonValue -Object $rootPkg -Path 'devEngines.runtime.version'
if (-not $NODE_PIN) {
  Die "root package.json has no devEngines.runtime.version. SECURITY.md keys a mechanical FAIL IF to that exact field."
}
if ($NODE_PIN -notmatch '^\d+\.\d+\.\d+$') {
  Die "devEngines.runtime.version must be an exact MAJOR.MINOR.PATCH version, got '$NODE_PIN'."
}
$PNPM_PIN = Get-JsonValue -Object $rootPkg -Path 'packageManager'
if (-not $PNPM_PIN) { Die "root package.json has no packageManager field." }
Write-Ok "node pin: $NODE_PIN"
Write-Ok "pnpm pin: $PNPM_PIN"

# `pnpm` on Windows resolves to a .ps1 shim before the .CMD, and Start-Process
# cannot execute a .ps1. Take the executable form.
$PNPM_BIN = $null
foreach ($c in @(Get-Command pnpm -All -ErrorAction SilentlyContinue)) {
  if ($c.CommandType -eq 'Application' -and $c.Source -match '\.(cmd|bat|exe)$') { $PNPM_BIN = $c.Source; break }
}
if (-not $PNPM_BIN) {
  Die "pnpm is not on PATH as an executable. Install pnpm $PNPM_PIN (or enable Corepack) and re-run."
}

function Invoke-Pnpm {
  param([string[]]$Arguments)
  return Invoke-Native -FilePath $PNPM_BIN -Arguments $Arguments -WorkDir $REPO_ROOT
}

$r = Invoke-Pnpm @('--version')
$PNPM_ACTUAL = if ($r.ExitCode -eq 0) { $r.StdOut.Trim() } else { 'unknown' }
if ($PNPM_PIN -ne "pnpm@$PNPM_ACTUAL") {
  Write-Warn2 "pnpm on PATH is $PNPM_ACTUAL but the repository pins $PNPM_PIN."
  if (-not (Confirm-Step "Continue with the mismatched pnpm?")) { Die "aborted at the user's request." }
} else {
  Write-Ok "pnpm on PATH matches the pin"
}

# --------------------------------------------------- workspace-state guard ---
#
# `pnpm deploy --prod --legacy` rewrites the ROOT workspace state file
# (node_modules/.pnpm-workspace-state-v1.json) to production:true / dev:false.
# Every later pnpm command in this checkout then decides the workspace is stale
# and tries to run `pnpm install --production`, which would strip the
# developer's devDependencies. Snapshot the file and restore it unconditionally
# on exit, so a failed install cannot leave the checkout poisoned either.

$WS_STATE = Join-Path $REPO_ROOT 'node_modules\.pnpm-workspace-state-v1.json'
$script:WS_STATE_BACKUP = $null
function Restore-WorkspaceState {
  if ($script:WS_STATE_BACKUP -and (Test-Path -LiteralPath $script:WS_STATE_BACKUP)) {
    try { [IO.File]::Copy($script:WS_STATE_BACKUP, $WS_STATE, $true) } catch { }
    try { [IO.File]::Delete($script:WS_STATE_BACKUP) } catch { }
    $script:WS_STATE_BACKUP = $null
  }
}

try {

  # ---------------------------------------------------------------- build ----

  Write-Step "Building the release from this checkout"

  Write-Info "pnpm install --frozen-lockfile"
  $r = Invoke-Pnpm @('install', '--frozen-lockfile')
  if ($r.ExitCode -ne 0) { Die "pnpm install --frozen-lockfile failed. Run it by hand to see why.`n$(Get-FailureTail $r)" }
  Write-Ok "dependencies installed"

  Write-Info "building lib/dist-pocket"
  $r = Invoke-Pnpm @('--filter', 'dormouse-lib', 'build:pocket')
  if ($r.ExitCode -ne 0) { Die "pocket build failed. Run: pnpm --filter dormouse-lib build:pocket`n$(Get-FailureTail $r)" }
  if (-not (Test-Path -LiteralPath (Join-Path $REPO_ROOT 'lib\dist-pocket\index.html'))) {
    Die "lib/dist-pocket/index.html missing after the pocket build."
  }
  Write-Ok "pocket app built"

  Write-Info "building server (and server-lib-common)"
  $r = Invoke-Pnpm @('--filter', 'server', 'build')
  if ($r.ExitCode -ne 0) { Die "server build failed. Run: pnpm --filter server build`n$(Get-FailureTail $r)" }
  if (-not (Test-Path -LiteralPath (Join-Path $REPO_ROOT 'server\dist\index.js'))) {
    Die "server/dist/index.js missing after the server build."
  }
  Write-Ok "server built"

  # Resolve the exact Node the build ran under. pnpm honors devEngines
  # (onFail: download), so this is the pinned runtime, not whatever is on PATH.
  # Write it to a file: pnpm can emit progress chatter on stdout, which would
  # contaminate a captured value.
  $execPathFile = [IO.Path]::GetTempFileName()
  $execPathJs = Join-Path ([IO.Path]::GetTempPath()) ('dormouse-' + [Guid]::NewGuid().ToString('N') + '.js')
  [IO.File]::WriteAllText($execPathJs, 'require("fs").writeFileSync(process.argv[2], process.execPath);')
  $r = Invoke-Pnpm @('exec', 'node', $execPathJs, $execPathFile)
  [IO.File]::Delete($execPathJs)
  if ($r.ExitCode -ne 0) { Die "could not resolve the pinned Node runtime via pnpm exec.`n$(Get-FailureTail $r)" }
  $NODE_BIN = ([IO.File]::ReadAllText($execPathFile)).Trim()
  [IO.File]::Delete($execPathFile)
  if (-not (Test-Path -LiteralPath $NODE_BIN -PathType Leaf)) {
    Die "resolved Node runtime does not exist: $NODE_BIN"
  }

  $VERSION_ARCH_JS = 'process.stdout.write(process.version + " " + process.arch);'
  $r = Invoke-NodeScript -NodeBin $NODE_BIN -Script $VERSION_ARCH_JS
  $parts = $r.StdOut.Trim().Split(' ')
  $NODE_BUILD_VERSION = $parts[0]
  $NODE_BUILD_ARCH = $parts[1]
  if ($NODE_BUILD_VERSION -ne "v$NODE_PIN") {
    Die "the build ran under Node $NODE_BUILD_VERSION but the repository pins v$NODE_PIN."
  }
  Write-Ok "pinned runtime: $NODE_BUILD_VERSION ($NODE_BUILD_ARCH)"

  # ------------------------------------------------------------ stage build ---

  Write-Step "Staging the new release"

  New-Directory $INSTALL_ROOT
  New-Directory $RELEASES_DIR
  New-Directory $BIN_DIR
  New-Directory $CONFIG_DIR
  New-Directory $STATE_DIR
  New-Directory $LOG_DIR
  Protect-Path -Path $CONFIG_DIR -Directory
  Protect-Path -Path $STATE_DIR -Directory

  $BUILT_AT = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
  $RELEASE_ID = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'") + "-$GIT_SHORT"
  if ($GIT_DIRTY -eq 'true') { $RELEASE_ID = "$RELEASE_ID-dirty" }
  $STAGE = Join-Path $RELEASES_DIR $RELEASE_ID

  if (Test-Path -LiteralPath $STAGE) { Remove-Tree $STAGE }
  New-Directory (Join-Path $STAGE 'lib')
  New-Directory (Join-Path $STAGE 'runtime')

  Write-Info "pnpm deploy --prod --legacy"
  if (Test-Path -LiteralPath $WS_STATE) {
    $script:WS_STATE_BACKUP = [IO.Path]::GetTempFileName()
    [IO.File]::Copy($WS_STATE, $script:WS_STATE_BACKUP, $true)
  }
  $r = Invoke-Pnpm @('--filter', 'server', 'deploy', '--prod', '--legacy', (Join-Path $STAGE 'server'))
  Restore-WorkspaceState
  if ($r.ExitCode -ne 0) {
    Die "pnpm deploy failed. Run: pnpm --filter server deploy --prod --legacy `$env:TEMP\dormouse-deploy-probe`n$(Get-FailureTail $r)"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $STAGE 'server\dist\index.js'))) {
    Die "the deployed server tree has no dist/index.js."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $STAGE 'server\node_modules\server-lib-common'))) {
    Die "the deployed server tree is missing the injected server-lib-common workspace package."
  }
  Write-Ok "production server tree staged"

  # server/src/config.ts resolves the pocket dir two levels up from
  # server/dist/config.js, i.e. <release>/lib/dist-pocket. Match that layout so
  # no DORMOUSE_POCKET_DIR override is needed.
  Copy-Item -Recurse -LiteralPath (Join-Path $REPO_ROOT 'lib\dist-pocket') -Destination (Join-Path $STAGE 'lib\dist-pocket')
  if (-not (Test-Path -LiteralPath (Join-Path $STAGE 'lib\dist-pocket\index.html'))) {
    Die "pocket app did not land in the release."
  }
  Write-Ok "pocket app staged"

  $STAGED_NODE = Join-Path $STAGE 'runtime\node.exe'
  Copy-Item -LiteralPath $NODE_BIN -Destination $STAGED_NODE
  $r = Invoke-NodeScript -NodeBin $STAGED_NODE -Script $VERSION_ARCH_JS
  if ($r.ExitCode -ne 0) { Die "the copied runtime does not run: $(Get-FailureTail $r)" }
  $parts = $r.StdOut.Trim().Split(' ')
  $STAGED_NODE_VERSION = $parts[0]
  $STAGED_NODE_ARCH = $parts[1]
  if ($STAGED_NODE_VERSION -ne "v$NODE_PIN") {
    Die "the copied runtime reports $STAGED_NODE_VERSION, expected v$NODE_PIN."
  }
  $archOk = (($ARCH -eq 'AMD64' -and $STAGED_NODE_ARCH -eq 'x64') -or ($ARCH -eq 'ARM64' -and $STAGED_NODE_ARCH -eq 'arm64'))
  if (-not $archOk) { Die "the copied runtime is $STAGED_NODE_ARCH but this PC is $ARCH." }
  Write-Ok "self-contained runtime staged ($STAGED_NODE_VERSION $STAGED_NODE_ARCH)"

  $releaseMeta = @(
    "release_id=$RELEASE_ID"
    "git_sha=$GIT_SHA"
    "git_short=$GIT_SHORT"
    "git_branch=$GIT_BRANCH"
    "git_dirty=$GIT_DIRTY"
    "built_at=$BUILT_AT"
    "node_version=$STAGED_NODE_VERSION"
    "node_arch=$STAGED_NODE_ARCH"
    "pnpm_version=$PNPM_ACTUAL"
    "source_checkout=$REPO_ROOT"
    "origin=$ORIGIN"
    "platform=windows"
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $STAGE 'RELEASE'), $releaseMeta + "`r`n")
  if ($GIT_DIRTY -eq 'true') {
    Write-Detail "RELEASE records git_dirty=true -- this build is NOT reproducibly identified by its SHA."
  }
  Write-Ok "release $RELEASE_ID staged"

  # ------------------------------------------------------------------ config ---

  Write-Step "Runtime configuration"

  if (-not (Test-Path -LiteralPath $ENV_FILE)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $SETUP_PASSWORD = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    # 32 random bytes is 64 hex characters. The guard counts characters, so it
    # must be 64, not 32 -- a guard reading 32 would pass a regression to half
    # the entropy SECURITY.md claims.
    if ($SETUP_PASSWORD.Length -lt 64) {
      Die "generated setup password is implausibly short; refusing to install it."
    }

    $envLines = @(
      '# Dormouse selfhost server -- installer-owned runtime configuration.'
      "# Generated $BUILT_AT. Preserved byte-for-byte across updates."
      '#'
      '# DORMOUSE_ORIGIN is durable WebAuthn identity (passkey rpId + Host'
      '# ConnectionPolicy). Changing it invalidates the registered passkey and every'
      '# enrolled Host. See docs/specs/server.md, "Configuration".'
      "DORMOUSE_SETUP_PASSWORD=$SETUP_PASSWORD"
      "DORMOUSE_ORIGIN=$ORIGIN"
      "DORMOUSE_STATE_DIR=$STATE_DIR"
      'DORMOUSE_BIND_HOST=127.0.0.1'
      "PORT=$LOOPBACK_PORT"
      'NODE_ENV=production'
    ) -join "`r`n"
    # Create the file with an owner-only ACL BEFORE the password is written, so
    # there is no window in which the secret sits under an inherited ACL.
    [IO.File]::WriteAllText($ENV_FILE, '')
    Protect-Path -Path $ENV_FILE
    [IO.File]::WriteAllText($ENV_FILE, $envLines + "`r`n")
    Remove-Variable SETUP_PASSWORD
    Write-Ok "generated config/server.env (owner-only ACL) with a locally generated setup password"
    Write-Detail "the password was not printed; retrieve it with: manage show-password"
  } else {
    Protect-Path -Path $ENV_FILE
    Write-Ok "preserved the existing config/server.env"
  }

  # The bind host is a security boundary whenever the TLS proxy is local: Serve
  # reaches the app over loopback, so an unbound socket would also publish the
  # plaintext port to the LAN and to the tailnet.
  $envText = [IO.File]::ReadAllLines($ENV_FILE)
  if (-not ($envText | Where-Object { $_ -eq 'DORMOUSE_BIND_HOST=127.0.0.1' })) {
    Die "config/server.env must set DORMOUSE_BIND_HOST=127.0.0.1. Fix it before continuing -- Tailscale access control is not a reason to expose the plaintext backend."
  }
  if (-not ($envText | Where-Object { $_ -eq "PORT=$LOOPBACK_PORT" })) {
    Die "config/server.env must set PORT=$LOOPBACK_PORT to match the Serve mapping."
  }

  # ------------------------------------------------------------- bin scripts ---

  Write-Step "Installing the service wrapper and management helper"

  $runServer = @'
#Requires -Version 5.1
# Installed by deploy/local/install-windows.ps1. Stable across releases.
#
# Task Scheduler does not read your PowerShell profile, so this must not depend
# on the interactive PATH, on a Node version manager, on pnpm's store, or on the
# source checkout. It loads only the installer-owned env file and runs the
# runtime copied into the current release.
#
# This script IS the KeepAlive: launchd restarts a LaunchAgent on any exit, and
# Task Scheduler's own restart-on-failure only fires on a failed exit, so the
# supervision loop lives here. Stopping the task terminates the whole job
# object, this script included.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root 'config\server.env'
$LogDir = Join-Path $Root 'logs'
$OutLog = Join-Path $LogDir 'server.out.log'
$ErrLog = Join-Path $LogDir 'server.err.log'
$ThrottleSeconds = 10

if (-not (Test-Path -LiteralPath $EnvFile)) {
  [Console]::Error.WriteLine("run-server: cannot read $EnvFile")
  exit 78
}
[void][IO.Directory]::CreateDirectory($LogDir)

# Parse KEY=VALUE lines. Deliberately not Invoke-Expression or dot-sourcing:
# this file holds the setup password, and a config file should not be able to
# execute code.
$EnvVars = @{}
foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
  $t = $line.Trim()
  if ($t.Length -eq 0) { continue }
  if ($t.StartsWith('#')) { continue }
  $i = $t.IndexOf('=')
  if ($i -lt 1) { continue }
  $key = $t.Substring(0, $i)
  $value = $t.Substring($i + 1)
  if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
  if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  $EnvVars[$key] = $value
}

$CmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'

function Write-ServiceLog {
  param([string]$Text)
  $stamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
  try { [IO.File]::AppendAllText($ErrLog, "[run-server $stamp] $Text`r`n") } catch { }
}

while ($true) {
  $pointer = Join-Path $Root 'current.txt'
  if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) {
    Write-ServiceLog "no current.txt release pointer; retrying in ${ThrottleSeconds}s"
    Start-Sleep -Seconds $ThrottleSeconds
    continue
  }
  $releaseId = ([IO.File]::ReadAllText($pointer)).Trim()
  $release = Join-Path $Root "releases\$releaseId"
  $nodeBin = Join-Path $release 'runtime\node.exe'
  $entry = Join-Path $release 'server\dist\index.js'

  if (-not (Test-Path -LiteralPath $nodeBin -PathType Leaf)) {
    Write-ServiceLog "missing runtime $nodeBin; retrying in ${ThrottleSeconds}s"
    Start-Sleep -Seconds $ThrottleSeconds
    continue
  }
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    Write-ServiceLog "missing entrypoint $entry; retrying in ${ThrottleSeconds}s"
    Start-Sleep -Seconds $ThrottleSeconds
    continue
  }

  # cmd.exe is the redirector so both streams APPEND across restarts;
  # .NET's ProcessStartInfo can only redirect to a pipe, and Start-Process
  # truncates the file it is given.
  $inner = '""{0}" "{1}" >>"{2}" 2>>"{3}""' -f $nodeBin, $entry, $OutLog, $ErrLog
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $CmdExe
  $psi.Arguments = "/d /c $inner"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  foreach ($key in $EnvVars.Keys) { $psi.EnvironmentVariables[$key] = $EnvVars[$key] }

  Write-ServiceLog "starting release $releaseId"
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.WaitForExit()
  Write-ServiceLog "release $releaseId exited with code $($proc.ExitCode); restarting in ${ThrottleSeconds}s"
  Start-Sleep -Seconds $ThrottleSeconds
}
'@
  [IO.File]::WriteAllText((Join-Path $BIN_DIR 'run-server.ps1'), $runServer)
  Write-Ok "bin\run-server.ps1"

  $manageHeader = @"
#Requires -Version 5.1
# Installed by deploy/local/install-windows.ps1.
`$ErrorActionPreference = 'Stop'

`$LABEL = '$LABEL'
`$TASK_PATH = '$TASK_PATH'
`$POWERSHELL_EXE = '$POWERSHELL_EXE'
"@

  $manageBody = @'

$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root 'config\server.env'
$StateDir = Join-Path $Root 'state'
$LogDir = Join-Path $Root 'logs'
$CurrentPointer = Join-Path $Root 'current.txt'
$PreviousPointer = Join-Path $Root 'previous.txt'

$UseColor = $false
try {
  $UseColor = [bool]$Host.UI.SupportsVirtualTerminal -and -not [Console]::IsOutputRedirected
} catch { $UseColor = $false }
if ($UseColor) {
  $E = [char]27
  $C_RED = "$E[31m"; $C_GRN = "$E[32m"; $C_YEL = "$E[33m"; $C_DIM = "$E[2m"; $C_OFF = "$E[0m"
} else {
  $C_RED = ''; $C_GRN = ''; $C_YEL = ''; $C_DIM = ''; $C_OFF = ''
}

$script:Failures = 0
function Pass { param([string]$T) Write-Host "  $C_GRN$([char]0x2713)$C_OFF $T" }
function Fail { param([string]$T) Write-Host "  $C_RED$([char]0x2717)$C_OFF $T"; $script:Failures++ }
function Note { param([string]$T) Write-Host "  $C_DIM$T$C_OFF" }
function Warn { param([string]$T) Write-Host "  $C_YEL!$C_OFF $T" }

function Get-EnvValue {
  param([Parameter(Mandatory)][string]$Key)
  if (-not (Test-Path -LiteralPath $EnvFile)) { return $null }
  foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
    if ($line -match "^$([regex]::Escape($Key))=(.*)$") { return $Matches[1].Trim('"') }
  }
  return $null
}

$PORT = Get-EnvValue 'PORT'
if (-not $PORT) { $PORT = '3100' }
$ORIGIN = Get-EnvValue 'DORMOUSE_ORIGIN'

$TS_BIN = $null
$tsCmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if ($tsCmd) {
  $TS_BIN = $tsCmd.Source
} else {
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'),
      (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe'))) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $TS_BIN = $candidate; break }
  }
}

# One pre-quoted string, not an array: PowerShell's own quoting of an array is
# stripped again by a .CMD shim's cmd.exe, so an argument holding a space (the
# install root is under "Dormouse Server") would arrive split in two.
function ConvertTo-NativeArgLine {
  param([string[]]$Arguments)
  $parts = @()
  foreach ($a in $Arguments) {
    if ($a -eq '' -or $a -match '[\s"]') { $parts += '"' + ($a -replace '"', '\"') + '"' }
    else { $parts += $a }
  }
  return ($parts -join ' ')
}

function Get-FailureTail {
  param($Result, [int]$Lines = 12)
  $text = (($Result.StdErr + "`n" + $Result.StdOut) -split "`r?`n" | Where-Object { $_.Trim() })
  if (-not $text) { return '(the command produced no output)' }
  return (($text | Select-Object -Last $Lines) -join "`n")
}

function Invoke-Native {
  param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [string]$WorkDir)
  $outFile = [IO.Path]::GetTempFileName()
  $errFile = [IO.Path]::GetTempFileName()
  try {
    $splat = @{
      FilePath = $FilePath; NoNewWindow = $true; Wait = $true; PassThru = $true
      RedirectStandardOutput = $outFile; RedirectStandardError = $errFile
    }
    if ($Arguments -and $Arguments.Count -gt 0) { $splat['ArgumentList'] = (ConvertTo-NativeArgLine $Arguments) }
    if ($WorkDir) { $splat['WorkingDirectory'] = $WorkDir }
    $proc = Start-Process @splat
    $out = ''; $err = ''
    if (Test-Path -LiteralPath $outFile) { $out = [IO.File]::ReadAllText($outFile) }
    if (Test-Path -LiteralPath $errFile) { $err = [IO.File]::ReadAllText($errFile) }
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; StdOut = $out; StdErr = $err }
  } finally {
    foreach ($f in @($outFile, $errFile)) { if (Test-Path -LiteralPath $f) { [IO.File]::Delete($f) } }
  }
}

function Invoke-Tailscale {
  param([string[]]$Arguments)
  if (-not $TS_BIN) { return [pscustomobject]@{ ExitCode = 127; StdOut = ''; StdErr = 'tailscale CLI not found' } }
  return Invoke-Native -FilePath $TS_BIN -Arguments $Arguments
}

# pnpm hardlinks packages out of its store with the read-only attribute set, and
# Windows refuses to unlink a read-only file. Clear it, then delete.
function Remove-Tree {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) {
      try { $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) } catch { }
    }
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Get-CurrentRelease {
  if (-not (Test-Path -LiteralPath $CurrentPointer -PathType Leaf)) { return $null }
  $id = ([IO.File]::ReadAllText($CurrentPointer)).Trim()
  if (-not $id) { return $null }
  return $id
}

function Get-PreviousRelease {
  if (-not (Test-Path -LiteralPath $PreviousPointer -PathType Leaf)) { return $null }
  $id = ([IO.File]::ReadAllText($PreviousPointer)).Trim()
  if (-not $id) { return $null }
  return $id
}

function Get-ReleaseField {
  param([Parameter(Mandatory)][string]$Field)
  $id = Get-CurrentRelease
  if (-not $id) { return $null }
  $file = Join-Path $Root "releases\$id\RELEASE"
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  foreach ($line in [IO.File]::ReadAllLines($file)) {
    if ($line -match "^$([regex]::Escape($Field))=(.*)$") { return $Matches[1] }
  }
  return $null
}

function Get-Task {
  return Get-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
}

function Test-Health {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 3)
  try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -MaximumRedirection 0
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400)
  } catch { return $false }
}

function Wait-Health {
  param([int]$Seconds = 30)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health -Url "http://127.0.0.1:$PORT/api/hello" -TimeoutSec 2) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

# Via a temp file, never `node -e`: an inline snippet's quotes and parentheses
# do not survive Start-Process argument quoting. `node file.js a b` also shifts
# the arguments to argv[2] onward.
function Invoke-NodeScript {
  param(
    [Parameter(Mandatory)][string]$NodeBin,
    [Parameter(Mandatory)][string]$Script,
    [string[]]$Arguments = @()
  )
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('dormouse-' + [Guid]::NewGuid().ToString('N') + '.js')
  try {
    [IO.File]::WriteAllText($tmp, $Script)
    return Invoke-Native -FilePath $NodeBin -Arguments (@($tmp) + $Arguments)
  } finally {
    if (Test-Path -LiteralPath $tmp) { [IO.File]::Delete($tmp) }
  }
}

function Set-ReleasePointer {
  param(
    [Parameter(Mandatory)][string]$ReleaseId,
    [Parameter(Mandatory)][string]$PointerPath,
    [Parameter(Mandatory)][string]$NodeBin
  )
  $js = 'const fs=require("fs");const v=process.argv[2];const l=process.argv[3];const t=l+".swap."+process.pid;try{fs.unlinkSync(t)}catch(e){}fs.writeFileSync(t,v+"\n","utf8");fs.renameSync(t,l);'
  $r = Invoke-NodeScript -NodeBin $NodeBin -Script $js -Arguments @($ReleaseId, $PointerPath)
  if ($r.ExitCode -ne 0) { throw "could not write the release pointer ${PointerPath}: $(Get-FailureTail $r)" }
}

# The Windows analog of a 0700/0600 check: no principal other than the current
# user may appear in the DACL.
#
# Deliberately NOT a check that the DACL is protected from inheritance. A file
# the server creates inside an already-locked state\ inherits that directory's
# single owner-only ACE, which is exactly the property wanted -- demanding
# protection on every path would fail those while they are in fact locked. An
# unprotected path that inherited %LOCALAPPDATA%'s SYSTEM and Administrators
# entries is caught by the identity test below regardless, so the identity test
# is the whole invariant and the protection flag adds nothing.
function Test-OwnerOnly {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Ok = $false; Reason = 'missing' } }
  $acl = Get-Acl -LiteralPath $Path
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $others = @()
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference
    try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { $sid = $rule.IdentityReference.Value }
    if ($sid -ne $me) { $others += $rule.IdentityReference.Value }
  }
  if ($others.Count -gt 0) {
    return [pscustomobject]@{ Ok = $false; Reason = "also grants $(($others | Select-Object -Unique) -join ', ')" }
  }
  return [pscustomobject]@{ Ok = $true; Reason = '' }
}

function Invoke-Status {
  Write-Host ""
  Write-Host "Dormouse selfhost server"
  Write-Host "  install root : $Root"
  Write-Host "  origin       : $(if ($ORIGIN) { $ORIGIN } else { '<unset>' })"
  Write-Host "  loopback     : http://127.0.0.1:$PORT"
  $cur = Get-CurrentRelease
  if ($cur) {
    Write-Host "  release      : $cur"
    Write-Host "  commit       : $(Get-ReleaseField 'git_sha') (dirty=$(Get-ReleaseField 'git_dirty'))"
    Write-Host "  built at     : $(Get-ReleaseField 'built_at')"
    Write-Host "  node         : $(Get-ReleaseField 'node_version') $(Get-ReleaseField 'node_arch')"
  } else {
    Write-Host "  release      : $C_RED(none -- current.txt missing)$C_OFF"
  }
  $prev = Get-PreviousRelease
  if ($prev) { Write-Host "  previous     : $prev" }
  else { Write-Host "  previous     : (none -- rollback unavailable)" }

  Write-Host ""
  Write-Host "Scheduled Task"
  $task = Get-Task
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
    Write-Host "  name         = $TASK_PATH$LABEL"
    Write-Host "  state        = $($task.State)"
    if ($info) {
      Write-Host "  last run     = $($info.LastRunTime)"
      Write-Host "  last result  = $($info.LastTaskResult)"
    }
  } else {
    Write-Host "  $C_RED not registered$C_OFF"
  }

  Write-Host ""
  Write-Host "Health"
  if (Test-Health -Url "http://127.0.0.1:$PORT/api/hello") {
    Write-Host "  loopback /api/hello : ${C_GRN}ok$C_OFF"
  } else {
    Write-Host "  loopback /api/hello : ${C_RED}unreachable$C_OFF"
  }

  Write-Host ""
  Write-Host "Tailscale Serve"
  $serve = Invoke-Tailscale @('serve', 'status')
  $serveText = ($serve.StdOut + $serve.StdErr).TrimEnd()
  if ($serveText) { foreach ($l in $serveText.Split("`n")) { Write-Host "  $($l.TrimEnd())" } }
  else { Write-Host "  ${C_RED}no Serve configuration$C_OFF" }

  Write-Host ""
  Write-Host "State files ($StateDir)"
  if (Test-Path -LiteralPath $StateDir) {
    Get-ChildItem -LiteralPath $StateDir -Force | ForEach-Object {
      Write-Host ("  {0,10}  {1}  {2}" -f $_.Length, $_.LastWriteTimeUtc.ToString("yyyy-MM-dd HH:mm:ss'Z'"), $_.Name)
    }
  } else {
    Write-Host "  ${C_RED}missing$C_OFF"
  }
  Write-Host ""
}

function Invoke-Verify {
  $script:Failures = 0
  Write-Host ""
  Write-Host "Verifying the installed service"
  Write-Host ""

  $task = Get-Task
  if ($task) {
    Pass "Scheduled Task $TASK_PATH$LABEL is registered"
    if ($task.State -eq 'Running') { Pass "the task is running" }
    else { Fail "the task state is $($task.State), expected Running" }

    $hasLogon = $false
    foreach ($t in @($task.Triggers)) {
      if ($t.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') { $hasLogon = $true }
    }
    if ($hasLogon) { Pass "the task declares an at-logon trigger (RunAtLoad)" }
    else { Fail "the task has no at-logon trigger" }

    $limit = $task.Settings.ExecutionTimeLimit
    if ($limit -eq 'PT0S' -or -not $limit) { Pass "the task has no execution time limit" }
    else { Fail "the task has an execution time limit of $limit -- it would be killed mid-service" }

    if ($task.Settings.RestartCount -ge 1) { Pass "the task restarts on failure (RestartCount=$($task.Settings.RestartCount))" }
    else { Fail "the task does not restart on failure" }

    if (-not $task.Settings.DisallowStartIfOnBatteries) { Pass "the task starts on battery" }
    else { Fail "the task refuses to start on battery -- it would not survive an unplugged laptop" }

    if (-not $task.Settings.StopIfGoingOnBatteries) { Pass "the task keeps running on battery" }
    else { Fail "the task stops when the PC goes on battery" }

    if (-not $task.Settings.IdleSettings.StopOnIdleEnd) { Pass "the task is not stopped by idle transitions" }
    else { Fail "the task is stopped when the idle window ends" }

    if ($task.Principal.RunLevel -eq 'Limited') { Pass "the task runs unelevated" }
    else { Fail "the task runs elevated ($($task.Principal.RunLevel)) -- it needs no administrator rights" }

    # The KeepAlive proper lives in bin\run-server.ps1's supervision loop;
    # Task Scheduler only restarts a task that *fails*.
    $wrapper = Join-Path $Root 'bin\run-server.ps1'
    if ((Test-Path -LiteralPath $wrapper) -and ([IO.File]::ReadAllText($wrapper) -match 'while \(\$true\)')) {
      Pass "bin\run-server.ps1 supervises the server (KeepAlive)"
    } else {
      Fail "bin\run-server.ps1 is missing or has no supervision loop"
    }

    $xml = Export-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
    if ($xml -and ($xml -match 'DORMOUSE_SETUP_PASSWORD')) {
      Fail "the task definition contains the setup password -- it must live only in config\server.env"
    } else {
      Pass "the task definition carries no credential"
    }
  } else {
    Fail "Scheduled Task $TASK_PATH$LABEL is not registered"
  }

  if (Test-Health -Url "http://127.0.0.1:$PORT/api/hello") {
    Pass "http://127.0.0.1:$PORT/api/hello responds"
  } else {
    Fail "loopback /api/hello is unreachable"
  }

  if (Test-Health -Url "http://127.0.0.1:$PORT/") {
    Pass "Pocket app is served on loopback"
  } else {
    Fail "Pocket index is not served -- is lib\dist-pocket in the release?"
  }

  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$PORT) -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) {
    Fail "nothing is listening on port $PORT"
  } else {
    $offLoopback = @($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' })
    if ($offLoopback.Count -gt 0) {
      Fail "port $PORT is bound off-loopback -- fix DORMOUSE_BIND_HOST=127.0.0.1"
      foreach ($l in $offLoopback) { Write-Host "      $($l.LocalAddress):$($l.LocalPort)" }
    } else {
      Pass "port $PORT is bound only to 127.0.0.1"
    }
  }

  $ipResult = Invoke-Tailscale @('ip', '-4')
  $tsIp = ''
  if ($ipResult.ExitCode -eq 0) { $tsIp = ($ipResult.StdOut.Split("`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() }
  if ($tsIp) {
    if (Test-Health -Url "http://${tsIp}:$PORT/api/hello" -TimeoutSec 3) {
      Fail "plaintext port $PORT is reachable on the Tailscale IP $tsIp"
    } else {
      Pass "plaintext port $PORT is not reachable on the Tailscale IP"
    }
  } else {
    Note "skipped the off-loopback probe (no Tailscale IPv4 address)"
  }

  $serve = Invoke-Tailscale @('serve', 'status')
  $serveText = $serve.StdOut + $serve.StdErr
  if (-not $serveText.Trim()) {
    Fail "tailscale serve reports no configuration"
  } else {
    if ($serveText -match [regex]::Escape("127.0.0.1:$PORT")) {
      Pass "Serve proxies to 127.0.0.1:$PORT"
    } else {
      Fail "Serve does not proxy to 127.0.0.1:$PORT"
      foreach ($l in $serveText.Split("`n")) { if ($l.Trim()) { Write-Host "      $($l.TrimEnd())" } }
    }
    if ($ORIGIN -and ($serveText -match [regex]::Escape($ORIGIN.Replace('https://', '')))) {
      Pass "Serve origin matches DORMOUSE_ORIGIN ($ORIGIN)"
    } else {
      Fail "Serve origin does not match DORMOUSE_ORIGIN ($ORIGIN)"
    }
  }

  # Serve and Funnel are one configuration surface, and Funnel publishes this
  # exact origin to the public internet. The whole security analysis of the
  # selfhost server assumes a tailnet-only origin -- most of all the setup
  # password, whose hardening is a constant-time compare and a 250ms delay
  # (SECURITY.md, "The setup password"). So this is checked, never assumed.
  $funnel = Invoke-Tailscale @('funnel', 'status')
  $funnelText = $funnel.StdOut + $funnel.StdErr
  if (($serveText + $funnelText) -match '(?i)funnel on') {
    Fail "tailscale funnel is ON -- this origin is published to the public internet"
    foreach ($l in $funnelText.Split("`n")) { if ($l.Trim()) { Write-Host "      $($l.TrimEnd())" } }
  } else {
    Pass "tailscale funnel is off (the origin stays tailnet-only)"
  }

  foreach ($pair in @(
      @{ Path = (Join-Path $Root 'config'); Label = 'config\' },
      @{ Path = $StateDir; Label = 'state\' },
      @{ Path = $EnvFile; Label = 'config\server.env' })) {
    $r = Test-OwnerOnly -Path $pair.Path
    if ($r.Ok) { Pass "$($pair.Label) grants only this user" }
    else { Fail "$($pair.Label) $($r.Reason)" }
  }

  # server/src/state.ts writes every state file at mode 0o600, but Node's file
  # modes are a no-op on Windows: the only thing keeping the Host bearer
  # credentials and the VAPID private key off a second account on this PC is
  # the ACE those files inherit from state\. So the files are checked here
  # rather than assumed from the directory -- this is the Windows half of the
  # "Credentials at rest" posture, and nothing else enforces it.
  $stateFiles = @(Get-ChildItem -LiteralPath $StateDir -File -Force -ErrorAction SilentlyContinue)
  if ($stateFiles.Count -eq 0) {
    Note "no state files yet (no account created -- see SELF_HOST.md checkpoint 4)"
  } else {
    $leaky = @()
    foreach ($f in $stateFiles) {
      $r = Test-OwnerOnly -Path $f.FullName
      if (-not $r.Ok) { $leaky += "$($f.Name) $($r.Reason)" }
    }
    if ($leaky.Count -eq 0) {
      Pass "all $($stateFiles.Count) state file(s) grant only this user"
    } else {
      Fail "state files readable by another principal:"
      foreach ($l in $leaky) { Write-Host "      $l" }
    }
  }

  if ((Get-EnvValue 'DORMOUSE_BIND_HOST') -eq '127.0.0.1') {
    Pass "DORMOUSE_BIND_HOST=127.0.0.1"
  } else {
    Fail "DORMOUSE_BIND_HOST is not pinned to 127.0.0.1"
  }

  $cur = Get-CurrentRelease
  if ($cur -and (Test-Path -LiteralPath (Join-Path $Root "releases\$cur\RELEASE"))) {
    Pass "current release: $cur"
    if ((Get-ReleaseField 'git_dirty') -eq 'true') { Warn "this release was built from a DIRTY worktree" }
  } else {
    Fail "current.txt or RELEASE metadata missing"
  }

  $prev = Get-PreviousRelease
  if ($prev) { Pass "a previous release is retained for rollback" }
  else { Warn "no previous release retained yet -- rollback is unavailable until the next update" }

  # The release must not depend on the source checkout.
  $src = Get-ReleaseField 'source_checkout'
  if ($src) {
    $refs = $false
    $wrapper = Join-Path $Root 'bin\run-server.ps1'
    if ((Test-Path -LiteralPath $wrapper) -and ([IO.File]::ReadAllText($wrapper) -match [regex]::Escape($src))) { $refs = $true }
    $xml = Export-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
    if ($xml -and ($xml -match [regex]::Escape($src))) { $refs = $true }
    if ($refs) { Fail "the Scheduled Task or wrapper references the source checkout ($src)" }
    else { Pass "the installed service does not reference the source checkout" }
  }

  Write-Host ""
  if ($script:Failures -eq 0) {
    Write-Host "${C_GRN}All checks passed.$C_OFF"
    Write-Host ""
    return 0
  }
  Write-Host "$C_RED$($script:Failures) check(s) failed.$C_OFF"
  Write-Host ""
  return 1
}

function Invoke-Logs {
  [void][IO.Directory]::CreateDirectory($LogDir)
  $out = Join-Path $LogDir 'server.out.log'
  $err = Join-Path $LogDir 'server.err.log'
  foreach ($f in @($out, $err)) { if (-not (Test-Path -LiteralPath $f)) { [IO.File]::WriteAllText($f, '') } }
  Write-Host "tailing $LogDir\{server.out.log,server.err.log} -- ctrl-c to stop"
  Write-Host ""
  Get-Content -LiteralPath $out, $err -Tail 50 -Wait
}

function Invoke-Restart {
  $task = Get-Task
  if (-not $task) { Write-Host "Scheduled Task $TASK_PATH$LABEL is not registered"; return 1 }
  Stop-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Start-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH
  Write-Host "restarted; waiting for health..."
  if (Wait-Health -Seconds 40) {
    Write-Host "${C_GRN}healthy$C_OFF"
    return 0
  }
  Write-Host "${C_RED}did not become healthy within 40s -- check: manage logs$C_OFF"
  return 1
}

function Invoke-ShowPassword {
  Write-Host ""
  Write-Host "${C_YEL}WARNING$C_OFF the setup password gates account creation and Host enrollment."
  Write-Host "It is about to be printed to this terminal. Make sure nobody is looking"
  Write-Host "over your shoulder and that this session is not being recorded or shared."
  Write-Host ""
  if ([Console]::IsInputRedirected) {
    [Console]::Error.WriteLine('refusing to print the setup password with no terminal to confirm at')
    return 1
  }
  $reply = Read-Host 'Print it? [y/N]'
  if (@('y', 'Y', 'yes', 'YES') -notcontains $reply) { Write-Host 'aborted'; return 1 }
  Write-Host ""
  Write-Host "  $(Get-EnvValue 'DORMOUSE_SETUP_PASSWORD')"
  Write-Host ""
  return 0
}

function Invoke-Serve {
  # Re-apply the Serve mapping -- e.g. after a dev session repointed / at :3000.
  if (-not $TS_BIN) { [Console]::Error.WriteLine('tailscale CLI not found'); return 1 }
  $r = Invoke-Tailscale @('serve', '--bg', $PORT)
  Write-Host ($r.StdOut + $r.StdErr).TrimEnd()
  if ($r.ExitCode -ne 0) { return $r.ExitCode }
  $s = Invoke-Tailscale @('serve', 'status')
  Write-Host ($s.StdOut + $s.StdErr).TrimEnd()
  return 0
}

function Invoke-Rollback {
  $prev = Get-PreviousRelease
  if (-not $prev) { [Console]::Error.WriteLine('no previous release retained'); return 1 }
  $cur = Get-CurrentRelease
  if (-not (Test-Path -LiteralPath (Join-Path $Root "releases\$prev"))) {
    [Console]::Error.WriteLine("previous release directory is gone: $prev")
    return 1
  }
  Write-Host "rolling back: $cur -> $prev"
  $nodeBin = $null
  foreach ($candidate in @((Join-Path $Root "releases\$prev\runtime\node.exe"), (Join-Path $Root "releases\$cur\runtime\node.exe"))) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nodeBin = $candidate; break }
  }
  if (-not $nodeBin) { [Console]::Error.WriteLine('no usable runtime found to swap the release pointers'); return 1 }
  # `previous` first: $nodeBin can be the CURRENT release's runtime, and moving
  # `current` to $prev would repoint it at the runtime that was just rejected.
  if ($cur) { Set-ReleasePointer -ReleaseId $cur -PointerPath $PreviousPointer -NodeBin $nodeBin }
  Set-ReleasePointer -ReleaseId $prev -PointerPath $CurrentPointer -NodeBin $nodeBin
  if ((Get-CurrentRelease) -ne $prev) {
    [Console]::Error.WriteLine("current did not advance to $prev")
    return 1
  }
  if (Get-Task) {
    Stop-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Start-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
  }
  if (Wait-Health -Seconds 40) {
    Write-Host "${C_GRN}rolled back and healthy$C_OFF"
    return 0
  }
  Write-Host "${C_RED}rolled back but not healthy -- check: manage logs$C_OFF"
  return 1
}

function Invoke-Uninstall {
  Write-Host ""
  Write-Host "This removes the Scheduled Task and the installed code."
  Write-Host "It PRESERVES your configuration and state:"
  Write-Host "  config : $Root\config"
  Write-Host "  state  : $StateDir"
  Write-Host ""
  Write-Host 'Use "manage purge" separately to delete those irreversibly.'
  Write-Host ""
  if ([Console]::IsInputRedirected) {
    [Console]::Error.WriteLine('refusing to uninstall with no terminal to confirm at')
    return 1
  }
  $reply = Read-Host 'Uninstall? [y/N]'
  if (@('y', 'Y', 'yes', 'YES') -notcontains $reply) { Write-Host 'aborted'; return 1 }

  if (Get-Task) {
    Stop-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -Confirm:$false
    Write-Host "unregistered the Scheduled Task"
  }

  # Turn off only the mapping this installer owns.
  $serve = Invoke-Tailscale @('serve', 'status')
  if (($serve.StdOut + $serve.StdErr) -match [regex]::Escape("127.0.0.1:$PORT")) {
    $off = Invoke-Tailscale @('serve', '--bg', 'off')
    if ($off.ExitCode -eq 0) { Write-Host "turned off the Serve mapping to 127.0.0.1:$PORT" }
    else { [Console]::Error.WriteLine('could not turn off the Serve mapping; check "tailscale serve status" and remove it by hand') }
  } else {
    Write-Host "left the Serve config alone (it does not point at 127.0.0.1:$PORT)"
  }

  foreach ($p in @((Join-Path $Root 'releases'), (Join-Path $Root 'bin'))) {
    if (Test-Path -LiteralPath $p) { Remove-Tree $p }
  }
  foreach ($p in @($CurrentPointer, $PreviousPointer)) {
    if (Test-Path -LiteralPath $p) { [IO.File]::Delete($p) }
  }
  Write-Host ""
  Write-Host "uninstalled. config and state remain at:"
  Write-Host "  $Root\config"
  Write-Host "  $StateDir"
  Write-Host ""
  return 0
}

function Invoke-Purge {
  Write-Host ""
  Write-Host "${C_RED}IRREVERSIBLE$C_OFF This deletes the account, enrolled Hosts, push"
  Write-Host "subscriptions, and the VAPID key:"
  Write-Host "  $StateDir"
  Write-Host "  $Root\config"
  Write-Host ""
  Write-Host "Registered passkeys and enrolled Hosts will have to be set up again."
  Write-Host ""
  $reply = Read-Host 'Type exactly: DELETE DORMOUSE STATE'
  if ($reply -cne 'DELETE DORMOUSE STATE') { Write-Host 'aborted'; return 1 }
  foreach ($p in @($StateDir, (Join-Path $Root 'config'))) {
    if (Test-Path -LiteralPath $p) { Remove-Tree $p }
  }
  Write-Host 'purged.'
  return 0
}

$command = if ($args.Count -gt 0) { $args[0] } else { 'status' }
switch ($command) {
  'status' { Invoke-Status; exit 0 }
  'verify' { exit (Invoke-Verify) }
  'logs' { Invoke-Logs; exit 0 }
  'restart' { exit (Invoke-Restart) }
  'show-password' { exit (Invoke-ShowPassword) }
  'serve' { exit (Invoke-Serve) }
  'rollback' { exit (Invoke-Rollback) }
  'uninstall' { exit (Invoke-Uninstall) }
  'purge' { exit (Invoke-Purge) }
  default {
    Write-Host @"
usage: manage <command>

  status          Scheduled Task, process, health, Serve origin, and release
  verify          run every acceptance check; exits nonzero on any failure
  logs            tail the local server logs
  restart         stop and start the Scheduled Task, then wait for health
  show-password   warn, then display the setup password locally
  serve           re-apply the Tailscale Serve mapping for this server
  rollback        switch to the retained previous release, preserving state
  uninstall       remove the Scheduled Task + code (keeps config and state)
  purge           irreversibly delete config and state
"@
    exit 64
  }
}
'@

  [IO.File]::WriteAllText((Join-Path $BIN_DIR 'manage.ps1'), $manageHeader + $manageBody)
  Write-Ok "bin\manage.ps1"

  $manageCmd = @"
@echo off
rem Installed by deploy/local/install-windows.ps1.
"$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage.ps1" %*
"@
  [IO.File]::WriteAllText((Join-Path $BIN_DIR 'manage.cmd'), $manageCmd + "`r`n")
  Write-Ok "bin\manage.cmd"

  # --------------------------------------------------------- candidate check ---

  Write-Step "Health-checking the candidate release"

  # Disposable: a throwaway state dir, a throwaway password and an ephemeral
  # port, so nothing touches the live service or the real state while we prove
  # the new code boots and serves.
  $portJs = 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)));});'
  $r = Invoke-NodeScript -NodeBin $STAGED_NODE -Script $portJs
  $PROBE_PORT = $r.StdOut.Trim()
  if (-not $PROBE_PORT) { Die "could not obtain an ephemeral probe port." }

  $PROBE_STATE = Join-Path ([IO.Path]::GetTempPath()) ("dormouse-probe-state-" + [Guid]::NewGuid().ToString('N'))
  New-Directory $PROBE_STATE
  Protect-Path -Path $PROBE_STATE -Directory
  $PROBE_LOG = [IO.Path]::GetTempFileName()

  # The analog of `env -i`: a scrubbed environment, so the candidate cannot
  # accidentally depend on anything in the developer's shell. SystemRoot and a
  # minimal PATH are the Windows floor -- winsock will not initialize without
  # them.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $STAGED_NODE
  $psi.Arguments = '"' + (Join-Path $STAGE 'server\dist\index.js') + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = $STAGE
  $psi.EnvironmentVariables.Clear()
  $psi.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
  $psi.EnvironmentVariables['windir'] = $env:windir
  $psi.EnvironmentVariables['TEMP'] = $env:TEMP
  $psi.EnvironmentVariables['TMP'] = $env:TMP
  $psi.EnvironmentVariables['PATH'] = (Join-Path $env:SystemRoot 'System32') + ';' + $env:SystemRoot
  $psi.EnvironmentVariables['SystemDrive'] = $env:SystemDrive
  $psi.EnvironmentVariables['DORMOUSE_SETUP_PASSWORD'] = "candidate-probe-$RELEASE_ID"
  $psi.EnvironmentVariables['DORMOUSE_ORIGIN'] = $ORIGIN
  $psi.EnvironmentVariables['DORMOUSE_STATE_DIR'] = $PROBE_STATE
  $psi.EnvironmentVariables['DORMOUSE_BIND_HOST'] = '127.0.0.1'
  $psi.EnvironmentVariables['PORT'] = $PROBE_PORT
  $psi.EnvironmentVariables['NODE_ENV'] = 'production'

  $probe = New-Object System.Diagnostics.Process
  $probe.StartInfo = $psi
  [void]$probe.Start()
  $probeOutTask = $probe.StandardOutput.ReadToEndAsync()
  $probeErrTask = $probe.StandardError.ReadToEndAsync()

  function Stop-Probe {
    try { if (-not $probe.HasExited) { $probe.Kill() } } catch { }
    try { $probe.WaitForExit(5000) | Out-Null } catch { }
    try { Remove-Tree $PROBE_STATE } catch { }
    try { if (Test-Path -LiteralPath $PROBE_LOG) { [IO.File]::Delete($PROBE_LOG) } } catch { }
  }

  function Show-ProbeOutput {
    Write-Host "--- candidate output ---"
    try { Write-Host $probeOutTask.Result } catch { }
    try { Write-Host $probeErrTask.Result } catch { }
  }

  $probeOk = $false
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Health -Url "http://127.0.0.1:$PROBE_PORT/api/hello" -TimeoutSec 2) { $probeOk = $true; break }
    if ($probe.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }

  if (-not $probeOk) {
    Show-ProbeOutput
    Stop-Probe
    Remove-Tree $STAGE
    Die "the candidate release did not answer /api/hello. The live service was left untouched."
  }
  Write-Ok "candidate answers /api/hello (scrubbed environment, ephemeral port $PROBE_PORT)"

  if (Test-Health -Url "http://127.0.0.1:$PROBE_PORT/" -TimeoutSec 3) {
    Write-Ok "candidate serves the Pocket app"
  } else {
    Show-ProbeOutput
    Stop-Probe
    Remove-Tree $STAGE
    Die "the candidate release did not serve the Pocket index. The live service was left untouched."
  }
  Stop-Probe

  # ----------------------------------------------------------- switch release --

  Write-Step "Switching to the new release"

  $OLD_RELEASE = Get-ReleasePointer -PointerPath $CURRENT_POINTER

  if ($OLD_RELEASE) {
    Set-ReleasePointer -ReleaseId $OLD_RELEASE -PointerPath $PREVIOUS_POINTER -NodeBin $STAGED_NODE
    Write-Detail "previous -> $OLD_RELEASE"
  }
  Set-ReleasePointer -ReleaseId $RELEASE_ID -PointerPath $CURRENT_POINTER -NodeBin $STAGED_NODE

  # Prove the switch actually landed: a silently unmoved `current` is exactly
  # the failure this step exists to prevent.
  $switchedTo = Get-ReleasePointer -PointerPath $CURRENT_POINTER
  if ($switchedTo -ne $RELEASE_ID) {
    Die "current did not advance to $RELEASE_ID (names '$(if ($switchedTo) { $switchedTo } else { 'nothing' })')."
  }
  Write-Ok "current -> $RELEASE_ID"

  # ---------------------------------------------------------- scheduled task --

  function Register-DormouseTask {
    $argline = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $BIN_DIR 'run-server.ps1')
    $action = New-ScheduledTaskAction -Execute $POWERSHELL_EXE -Argument $argline -WorkingDirectory $INSTALL_ROOT
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $USER_ID
    $principal = New-ScheduledTaskPrincipal -UserId $USER_ID -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 999 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew
    # Defaults that would silently stop a long-running service.
    $settings.IdleSettings.StopOnIdleEnd = $false
    $settings.DisallowStartOnRemoteAppSession = $false
    $settings.Priority = 6

    Register-ScheduledTask `
      -TaskName $LABEL `
      -TaskPath $TASK_PATH `
      -Action $action `
      -Trigger $trigger `
      -Principal $principal `
      -Settings $settings `
      -Description "Dormouse selfhost coordinating server, fronted by tailscale serve on $ORIGIN. Installed by deploy/local/install-windows.ps1; see SELF_HOST.md." `
      -Force | Out-Null
  }

  function Restore-PreviousRelease {
    Write-Warn2 "restoring the previous release"
    if (-not $OLD_RELEASE) {
      Write-Warn2 "there is no previous release to restore (this was a first install)."
      return $false
    }
    # $STAGED_NODE was verified executable and version/arch-matched earlier in
    # this run; the old release's runtime has not been checked at all.
    Set-ReleasePointer -ReleaseId $OLD_RELEASE -PointerPath $CURRENT_POINTER -NodeBin $STAGED_NODE
    if (-not $TEST_MODE) {
      try {
        Stop-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        Start-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
      } catch { }
    }
    if (Wait-Health -Url "http://127.0.0.1:$LOOPBACK_PORT/api/hello" -Seconds 40) {
      Write-Warn2 "the previous release ($OLD_RELEASE) is healthy again."
      return $true
    }
    Write-Warn2 "the previous release did NOT become healthy. Inspect: $LOG_DIR"
    return $false
  }

  Write-Step "Registering the Scheduled Task"

  if ($TEST_MODE) {
    Write-Warn2 "test mode: skipping Register-ScheduledTask / Start-ScheduledTask"
  } else {
    $existing = Get-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
    if ($existing) {
      try { Stop-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH -ErrorAction SilentlyContinue } catch { }
      Write-Detail "stopped the previously registered task"
    } else {
      Write-Detail "no previously registered task (first install)"
    }
    Register-DormouseTask
    Write-Ok "registered $TASK_PATH$LABEL for $USER_ID (unelevated, at logon)"
    Start-Sleep -Milliseconds 500
    Start-ScheduledTask -TaskName $LABEL -TaskPath $TASK_PATH
    Write-Ok "task started"
  }

  # ------------------------------------------------------------ live health ----

  Write-Step "Waiting for the installed service"

  if ($TEST_MODE) {
    Write-Warn2 "test mode: skipping the live health check (no Scheduled Task was registered)"
  } else {
    if (-not (Wait-Health -Url "http://127.0.0.1:$LOOPBACK_PORT/api/hello" -Seconds 60)) {
      Write-Warn2 "the new release never answered http://127.0.0.1:$LOOPBACK_PORT/api/hello"
      $errLog = Join-Path $LOG_DIR 'server.err.log'
      if (Test-Path -LiteralPath $errLog) {
        Get-Content -LiteralPath $errLog -Tail 30 | ForEach-Object { Write-Host "      $_" }
      }
      [void](Restore-PreviousRelease)
      Die "update FAILED. Rollback was attempted -- this is not a success, whatever the previous release now reports."
    }
    Write-Ok "http://127.0.0.1:$LOOPBACK_PORT/api/hello responds"

    if (Test-Health -Url "http://127.0.0.1:$LOOPBACK_PORT/") {
      Write-Ok "Pocket app is served"
    } else {
      Write-Warn2 "the Pocket index did not load"
      [void](Restore-PreviousRelease)
      Die "update FAILED (Pocket index). Rollback was attempted."
    }
  }

  # -------------------------------------------------------------- serve ------

  Write-Step "Configuring Tailscale Serve"

  $before = Invoke-Tailscale @('serve', 'status')
  $SERVE_BEFORE = ($before.StdOut + $before.StdErr).TrimEnd()
  if ($SERVE_BEFORE) {
    Write-Detail "existing Serve configuration:"
    foreach ($l in $SERVE_BEFORE.Split("`n")) { Write-Host "      $($l.TrimEnd())" }
  }

  $NEEDS_SERVE = $true
  if ($SERVE_BEFORE -match [regex]::Escape("127.0.0.1:$LOOPBACK_PORT")) {
    Write-Ok "Serve already proxies to 127.0.0.1:$LOOPBACK_PORT"
    $NEEDS_SERVE = $false
  } elseif ($SERVE_BEFORE -match '(?m)^\|--\s+/\s+proxy') {
    $existingTarget = ''
    if ($SERVE_BEFORE -match '(?m)^\|--\s+/\s+proxy\s+(.*)$') { $existingTarget = $Matches[1].Trim() }
    Write-Warn2 "the root HTTPS path is already mapped to something else: $(if ($existingTarget) { $existingTarget } else { '<unknown>' })"
    Write-Warn2 "Dormouse needs / on this node to serve the Pocket app at the passkey origin."
    if (-not (Confirm-Step "Repoint / to 127.0.0.1:$LOOPBACK_PORT?")) {
      Die "left the Serve config alone. Resolve the hostname/path conflict, then re-run."
    }
  }

  if ($TEST_MODE) {
    Write-Warn2 "test mode: skipping the Serve mutation"
  } elseif ($NEEDS_SERVE) {
    Write-Info "tailscale serve --bg $LOOPBACK_PORT"
    Write-Detail "Tailscale may open a browser consent flow if HTTPS is not yet enabled."
    $sv = Invoke-Tailscale @('serve', '--bg', "$LOOPBACK_PORT")
    if ($sv.ExitCode -ne 0) {
      Die "``tailscale serve --bg $LOOPBACK_PORT`` failed.`n$(($sv.StdOut + $sv.StdErr).Trim())"
    }
    Write-Ok "Serve configured"
  }

  if (-not $TEST_MODE) {
    $after = Invoke-Tailscale @('serve', 'status')
    $SERVE_AFTER = ($after.StdOut + $after.StdErr).TrimEnd()
    if ($SERVE_AFTER -notmatch [regex]::Escape("127.0.0.1:$LOOPBACK_PORT")) {
      Write-Host $SERVE_AFTER
      Die "Serve does not report a proxy to 127.0.0.1:$LOOPBACK_PORT."
    }
    if ($SERVE_AFTER -notmatch [regex]::Escape($TS_DNS)) {
      Write-Host $SERVE_AFTER
      Die "Serve does not report the expected HTTPS origin $ORIGIN."
    }
    Write-Ok "Serve reports $ORIGIN -> 127.0.0.1:$LOOPBACK_PORT"
  }

  # ----------------------------------------------------------------- prune ----

  Write-Step "Pruning old releases"

  $keepCurrent = Get-ReleasePointer -PointerPath $CURRENT_POINTER
  $keepPrevious = Get-ReleasePointer -PointerPath $PREVIOUS_POINTER

  $pruned = 0
  foreach ($dir in @(Get-ChildItem -LiteralPath $RELEASES_DIR -Directory -ErrorAction SilentlyContinue)) {
    if ($dir.Name -eq $keepCurrent) { continue }
    if ($keepPrevious -and $dir.Name -eq $keepPrevious) { continue }
    Remove-Tree $dir.FullName
    Write-Detail "removed release $($dir.Name)"
    $pruned++
  }
  if ($pruned -eq 0) {
    Write-Ok "nothing to prune (retaining current$(if ($keepPrevious) { ' and previous' }))"
  } else {
    Write-Ok "pruned $pruned old release(s); config and state untouched"
  }

  # ---------------------------------------------------------------- summary ---

  Write-Step "Installed"

  Write-Host "    origin        $ORIGIN"
  Write-Host "    release       $RELEASE_ID"
  Write-Host "    commit        $GIT_SHA (dirty=$GIT_DIRTY)"
  Write-Host "    install root  $INSTALL_ROOT"
  Write-Host "    config        $ENV_FILE"
  Write-Host "    state         $STATE_DIR"
  Write-Host "    logs          $LOG_DIR"
  Write-Host ""
  Write-Host "    manage:  `"$BIN_DIR\manage.cmd`" <status|verify|logs|restart|show-password|serve|rollback|uninstall>"
  Write-Host ""

  if ($FIRST_INSTALL) {
    Write-Host "    First install. Retrieve the generated setup password when you are ready"
    Write-Host "    to create the passkey and enroll a Host:"
    Write-Host ""
    Write-Host "        `"$BIN_DIR\manage.cmd`" show-password"
    Write-Host ""
  }

} finally {
  Restore-WorkspaceState
}

exit 0
