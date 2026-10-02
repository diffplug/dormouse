import { constants } from 'node:fs';
import { open, realpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, win32 } from 'node:path';

export interface SaveSibling {
  file: FileHandle;
  path: string;
  cleanup(): Promise<void>;
}
export interface SaveFileOperations {
  createSibling(target: string, temporary: string): Promise<SaveSibling>;
  replace(temporary: string, target: string): Promise<void>;
}

// Windows chmod cannot preserve a DACL. Stage in an exclusively created,
// owner-only directory and owner-only content file, then use ReplaceFile to
// preserve the document's metadata without ignoring merge errors. Directory
// privacy alone is insufficient: Windows permits known-path traverse bypass.
// The original backup retains the original document permissions. No fallback.
// Fixed scripts receive paths as environment data. execFile retains the stage
// ownership acknowledgment on failure/timeout, so cleanup never deletes a
// collision. A timeout before acknowledgment can leave only an empty private
// stage; replacement can have committed before its reply, so never infer that
// a helper timeout left the previous bytes in place. Native replacement uses
// an original-file backup inside the owned stage; a failed replacement must
// retain the stage because ReplaceFile may already have moved either file.
const OWNED = 'dormouse-save-stage-owned';
const CREATE_DIRECTORY_CLASS = String.raw`using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DormouseSaveStage {
  [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string path, ref Attributes attributes);
  public static void Create(string path, byte[] descriptor) {
    var pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var attributes = new Attributes { Length=Marshal.SizeOf(typeof(Attributes)), Descriptor=pin.AddrOfPinnedObject(), Inherit=false };
      if (!CreateDirectoryW(path, ref attributes)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { pin.Free(); }
  }
}`;
const CREATE = String.raw`
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(CREATE_DIRECTORY_CLASS).toString('base64')}')))
$directory = [Security.AccessControl.DirectorySecurity]::new()
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$directory.SetOwner($sid)
$directory.SetAccessRuleProtection($true, $false)
$directory.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
[DormouseSaveStage]::Create($env:DORMOUSE_SAVE_STAGE, $directory.GetSecurityDescriptorBinaryForm())
[Console]::Out.WriteLine('dormouse-save-stage-owned')
[Console]::Out.Flush()
$null = [IO.File]::GetAccessControl($env:DORMOUSE_SAVE_TARGET)
$security = [Security.AccessControl.FileSecurity]::new()
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true, $false)
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, "FullControl", "Allow"))
$file = [IO.FileStream]::new($env:DORMOUSE_SAVE_SIBLING, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security)
$file.Dispose()
`;
const REPLACE = '[IO.File]::Replace($env:DORMOUSE_SAVE_SIBLING, $env:DORMOUSE_SAVE_TARGET, $env:DORMOUSE_SAVE_BACKUP, $false)';

function windowsFileOperation(script: string, target: string, temporary: string, stage = ''): Promise<{ failed: boolean; owned: boolean }> {
  const encoded = Buffer.from('$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue";\n' + script, 'utf16le').toString('base64');
  const binary = win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    // The absolute system .exe needs no PATHEXT or batch-shim handling. Output
    // contains only the ownership marker and bounded helper diagnostics.
    execFile(binary, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, DORMOUSE_SAVE_TARGET: target, DORMOUSE_SAVE_SIBLING: temporary, DORMOUSE_SAVE_STAGE: stage, DORMOUSE_SAVE_BACKUP: join(dirname(temporary), 'original') },
      windowsHide: true, timeout: 10_000, maxBuffer: 4096, encoding: 'utf8',
    }, (error, stdout) => resolve({ failed: error !== null, owned: stdout.split(/\r?\n/).includes(OWNED) }));
  });
}

export const saveFileOperations: SaveFileOperations = {
  async createSibling(target, temporary) {
    if (process.platform !== 'win32') return {
      file: await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600), path: temporary,
      cleanup: async () => { await unlink(temporary).catch(() => {}); },
    };
    const path = join(temporary, 'content');
    const result = await windowsFileOperation(CREATE, target, path, temporary);
    const cleanup = async () => { await rm(temporary, { recursive: true, force: true }); };
    if (result.failed || !result.owned) {
      if (result.owned) await cleanup();
      throw new Error('Unable to prepare a save with preserved file permissions.');
    }
    try {
      if (await realpath(path) !== path) throw new Error('The save path changed.');
      return { file: await open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)), path, cleanup };
    } catch (error) { await cleanup(); throw error; }
  },
  async replace(temporary, target) {
    if (process.platform !== 'win32') { await rename(temporary, target); return; }
    if ((await windowsFileOperation(REPLACE, target, temporary)).failed) throw new Error('The file replacement was not confirmed. Reload before saving again.');
  },
};
