#Requires -Version 5.1
param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer parse failed' }
function Find-Function($Tree, [string]$Name) {
  $nodes = @($Tree.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }.GetNewClosure(), $true))
  if ($nodes.Count -ne 1) { throw "Expected one $Name, got $($nodes.Count)" }
  return $nodes[0].Extent.Text
}
$body = $ast.Find({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$manageBody' }, $true)
$literal = $body.Right.Find({ param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] }, $true)
$manage = [Management.Automation.Language.Parser]::ParseInput($literal.Value, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Manage script parse failed' }
. ([ScriptBlock]::Create((Find-Function $ast 'Protect-Path')))
$script:CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$checks = @()
$peerStorage = Join-Path $Root 'peer-storage'
New-Item -ItemType Directory -Path $peerStorage -Force | Out-Null
Protect-Path -Path $peerStorage -Directory
$private = Join-Path $Root 'private'
New-Item -ItemType Directory -Path $private -Force | Out-Null
Protect-Path -Path $private -Directory
Protect-Path -Path $private -Directory # Exercise the unelevated idempotent path.
$inherited = Join-Path $private 'inherited.txt'
[IO.File]::WriteAllText($inherited, 'dormouse-audit-synthetic')
$explicit = Join-Path $Root 'explicit.txt'
[IO.File]::WriteAllText($explicit, 'dormouse-audit-synthetic')
Protect-Path -Path $explicit
Protect-Path -Path $explicit
foreach ($scope in @(@{ Name = 'installer'; Ast = $ast }, @{ Name = 'manage'; Ast = $manage })) {
  . ([ScriptBlock]::Create((Find-Function $scope.Ast 'Test-OwnerOnly')))
  foreach ($path in @($private, $inherited, $explicit)) {
    $result = Test-OwnerOnly -Path $path
    if (-not $result.Ok) { throw "$($scope.Name): $path : $($result.Reason)" }
    $checks += @{ scope = $scope.Name; path = $path; accepted = $result.Ok; sddl = (Get-Acl -LiteralPath $path).Sddl }
  }
  # Negative control: a real additional Users ACE must be rejected by BOTH readers.
  $loose = Join-Path $Root ('loose-' + $scope.Name + '.txt')
  [IO.File]::WriteAllText($loose, 'synthetic')
  Protect-Path -Path $loose
  $acl = (Get-Item -LiteralPath $loose).GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
  $users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users, 'Read', 'Allow')))
  (Get-Item -LiteralPath $loose).SetAccessControl($acl)
  if ((Test-OwnerOnly -Path $loose).Ok) { throw "$($scope.Name) accepted another principal" }
  $checks += @{ scope = $scope.Name; negativeControl = 'extra Users ACE rejected' }
}
@{ sid = $script:CurrentUserSid; checks = $checks } | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $Root 'acl.json')
