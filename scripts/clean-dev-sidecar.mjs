// Clears a Windows sidecar left in this worktree's default debug output after
// an interrupted native dev run. Never kill a process merely for owning a port:
// another worktree (or application) may be using it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.platform !== 'win32') {
  process.exit(0);
}

// scripts/ sits at the repo root, so the sidecar's dev build lives at
// standalone/src-tauri/target/debug next to it.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const debugDir = join(repoRoot, 'standalone', 'src-tauri', 'target', 'debug');

// Single-quoted PS literals; double any apostrophe in the path so it can't break out.
const debugDirLiteral = debugDir.replace(/'/g, "''");

const script = `
$ErrorActionPreference = 'SilentlyContinue'

$debugDir = '${debugDirLiteral}'
$sidecars = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.ExecutablePath -and [IO.Path]::GetDirectoryName($_.ExecutablePath) -eq $debugDir }
foreach ($sidecar in $sidecars) {
  Stop-Process -Id $sidecar.ProcessId -Force
  Write-Output "[clean-dev-sidecar] killed orphaned sidecar node process $($sidecar.ProcessId) locking $debugDir"
}
`;

try {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  ).trim();
  if (out) console.log(out);
} catch {
  // Best effort: if we can't inspect/kill the strays, let `tauri dev` surface
  // the real error itself rather than failing the predev hook.
}
