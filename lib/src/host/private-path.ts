/** Recovery's exact host-owned directory and legacy record must be private before
 * any bytes are written or claimed. Unix mkdir modes do not tighten existing
 * directories; Windows mode bits do not control access. Harden the directory
 * once at startup so a bounded teardown does not pay for a process per record.
 * Never touch ancestors. Failure prevents persistence and automatic recovery.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

const WINDOWS_PRIVATE_PATH = `
$ErrorActionPreference = 'Stop'
$targetPath = [Console]::In.ReadToEnd()
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
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

function checkPath(target: string, directory: boolean): void {
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`Recovery path must be a plain ${directory ? 'directory' : 'file'}`);
  }
  if (process.platform !== 'win32') {
    if (process.getuid && info.uid !== process.getuid()) throw new Error('Recovery path must belong to this user');
    fs.chmodSync(target, directory ? 0o700 : 0o600);
    return;
  }
}

const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Startup and cold claims do not block the host event loop on Windows ACL setup.
 * The OS authorizes SetOwner/Set-Acl; an elevated administrator-owned legacy
 * path may be rewritten, and any refused operation still fails closed. */
async function restrictToOwner(target: string, directory: boolean): Promise<void> {
  checkPath(target, directory);
  if (process.platform !== 'win32') return;
  await new Promise<void>((resolve, reject) => {
    const child = execFile(powershell(), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PRIVATE_PATH], {
      encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024,
    }, (error) => error ? reject(error) : resolve());
    child.stdin!.on('error', () => { /* execFile reports process failure */ });
    child.stdin!.end(path.resolve(target));
  });
}

export async function ensurePrivateDirectory(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  await restrictToOwner(dir, true);
}

/** Tighten explicit legacy grants before reading; reject symlinks and non-files. */
export async function ensurePrivateFile(file: string): Promise<void> {
  await restrictToOwner(file, false);
}
