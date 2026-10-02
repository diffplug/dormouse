import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function runAclScript(script: string, target: string): string {
  return execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); " + script],
    { input: target, encoding: 'utf8', windowsHide: true, timeout: 5_000 }).trim();
}

export function seedEveryoneRead(target: string): void {
  runAclScript(`$acl=Get-Acl -LiteralPath $p;
    $inheritance=[System.Security.AccessControl.InheritanceFlags]::None;
    if ((Get-Item -LiteralPath $p -Force).PSIsContainer) {
      $inheritance=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    }
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new(
      [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
      [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
      $inheritance,[System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow);
    $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`, target);
}

export function readAcl(target: string): {
  currentUser: string; owner: string; protected: boolean;
  rules: Array<{ sid: string; rights: number; allow: boolean; inheritance: number }>;
} {
  return JSON.parse(runAclScript(`$acl=Get-Acl -LiteralPath $p;
    @{ currentUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
      protected=$acl.AreAccessRulesProtected;
      rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights;
          allow=$_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow;
          inheritance=[int]$_.InheritanceFlags }
      }) } | ConvertTo-Json -Depth 4 -Compress`, target));
}
