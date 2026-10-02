/** Recovery's exact host-owned directory and legacy record must be private before
 * any bytes are written or claimed. Unix mkdir modes do not tighten existing
 * directories; Windows mode bits do not control access. Harden the directory
 * once at startup so a bounded teardown does not pay for a process per record.
 * Never touch ancestors. Failure prevents persistence and automatic recovery.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const WINDOWS_PRIVATE_PATH = `
$ErrorActionPreference = 'Stop'
$targetPath = [Console]::In.ReadToEnd()
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$existing = Get-Acl -LiteralPath $targetPath
if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
  throw 'Recovery path must belong to this user'
}
if ((Get-Item -LiteralPath $targetPath -Force).PSIsContainer) {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]0x001F01FF,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $targetPath -AclObject $acl
`;

function restrictToOwnerSync(target: string, directory: boolean): void {
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`Recovery path must be a plain ${directory ? 'directory' : 'file'}`);
  }
  if (process.platform !== 'win32') {
    if (process.getuid && info.uid !== process.getuid()) throw new Error('Recovery path must belong to this user');
    fs.chmodSync(target, directory ? 0o700 : 0o600);
    return;
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PRIVATE_PATH], {
    // Only literal path data crosses stdin: quotes, $, backticks and newlines
    // never become PowerShell code. Use the system executable, not PATH search.
    input: path.resolve(target), encoding: 'utf8', windowsHide: true, timeout: 5_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function ensurePrivateDirectorySync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictToOwnerSync(dir, true);
}

/** A legacy record may have explicit grants that directory inheritance cannot
 * remove. Tighten it before reading; reject symlinks and non-files outright. */
export function ensurePrivateFileSync(file: string): void {
  restrictToOwnerSync(file, false);
}
