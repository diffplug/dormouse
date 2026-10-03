import { rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

export interface SaveFileOperations {
  /** Move `temporary` over `target`; on Windows the original moves to `backup`. */
  replace(temporary: string, target: string, backup: string): Promise<void>;
}

// A Node rename on Windows fails with EPERM while the file viewer holds the
// target open, and drops the document's DACL. ReplaceFile succeeds with that
// descriptor open and merges the original's ACL and metadata. The fixed script
// receives paths as environment data. Any failure, including a timeout, may
// follow a partial or committed replacement, so the caller keeps both files.
const REPLACE = '$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"; [IO.File]::Replace($env:DORMOUSE_SAVE_SIBLING, $env:DORMOUSE_SAVE_TARGET, $env:DORMOUSE_SAVE_BACKUP, $false)';

export function windowsReplaceCommand(temporary: string, target: string, backup: string) {
  return {
    // The absolute system .exe needs no PATHEXT or batch-shim handling.
    file: win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(REPLACE, 'utf16le').toString('base64')],
    env: { ...process.env, DORMOUSE_SAVE_SIBLING: temporary, DORMOUSE_SAVE_TARGET: target, DORMOUSE_SAVE_BACKUP: backup },
  };
}

export const saveFileOperations: SaveFileOperations = {
  async replace(temporary, target, backup) {
    if (process.platform !== 'win32') { await rename(temporary, target); return; }
    const { file, args, env } = windowsReplaceCommand(temporary, target, backup);
    await promisify(execFile)(file, args, { env, windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
  },
};
