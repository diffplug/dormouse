#Requires -Version 5.1
param([Parameter(Mandatory)][string]$Plan)
$ErrorActionPreference = 'Stop'
$task = Get-Content -Raw -LiteralPath $Plan | ConvertFrom-Json
$result = [ordered]@{ exitCode = 1; error = $null; sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; started = (Get-Date).ToUniversalTime().ToString('o') }
try {
  # CreateProcessWithLogonW loads the profile, but Start-Process can carry the
  # caller's environment. Resolve these from the child's own Windows identity.
  foreach ($entry in @(Get-ChildItem Env:)) {
    if ($entry.Name -match '^(DORMOUSE_|AGENT_BROWSER_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)') { Remove-Item -LiteralPath ('Env:' + $entry.Name) }
  }
  if ($result.sid -ne $task.sid) { throw 'Wrong child account' }
  $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
  $profileKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $result.sid
  $registeredProfile = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath).ProfileImagePath)
  if ([IO.Path]::GetFullPath($env:USERPROFILE) -ne [IO.Path]::GetFullPath($registeredProfile)) { throw "Unexpected child profile $env:USERPROFILE" }
  $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
  $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
  $env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'; $env:TMP = $env:TEMP
  $env:HOMEDRIVE = [IO.Path]::GetPathRoot($env:USERPROFILE).TrimEnd('\')
  $env:HOMEPATH = $env:USERPROFILE.Substring($env:HOMEDRIVE.Length)
  $env:USERNAME = [Environment]::UserName; $env:USERDOMAIN = [Environment]::UserDomainName
  New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
  Set-Location -LiteralPath $task.cwd
  @{ sid = $task.sid; profile = $env:USERPROFILE; localAppData = $env:LOCALAPPDATA; exe = $task.exe; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $task.identityLog
  if ($task.electron) { $env:ELECTRON_RUN_AS_NODE = '1' }
  # Start directly through Process so we own its kernel handle and exit code.
  # Keep the logon wrapper alive while a GUI runs, retaining its loaded profile.
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $task.exe
  $start.WorkingDirectory = $task.cwd
  $start.UseShellExecute = $false
  $start.Arguments = (@($task.arguments) | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $native = [Diagnostics.Process]::Start($start)
  try {
    $result.nativePid = $native.Id
    $native.WaitForExit()
    $result.exitCode = $native.ExitCode
  } finally { $native.Dispose() }
} catch {
  $result.error = $_.Exception.Message
  [Console]::Error.WriteLine($result.error)
} finally {
  $result.completed = (Get-Date).ToUniversalTime().ToString('o')
  $result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath ($task.resultLog + '.tmp')
  Move-Item -LiteralPath ($task.resultLog + '.tmp') -Destination $task.resultLog -Force
}
exit $result.exitCode
