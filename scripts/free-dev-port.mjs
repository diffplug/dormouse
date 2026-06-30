// Clears the two Windows-only strays that block the next `tauri dev`:
//
//  1. An orphaned `vite` process squatting on the dev-server port — left by an
//     interrupted `tauri dev` (closed window, Ctrl-C that doesn't propagate to
//     the Vite child) — so the next run aborts with "Port 1420 is already in use".
//  2. An orphaned standalone sidecar `node.exe` running out of `target\debug`.
//     Its JobObject leash should take it down with the app, but a force-quit or
//     crash can leave it alive holding a lock on `target\debug\node.exe`; the next
//     Rust rebuild then fails copying the sidecar binary with "Access is denied."
//
// Both are no-ops everywhere but Windows.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.platform !== 'win32') {
  process.exit(0);
}

// Keep in sync with standalone/vite.config.ts (defaults to 1420).
const port = Number(process.env.DORMOUSE_BROWSER_DEV_VITE_PORT || 1420);

// scripts/ sits at the repo root, so the sidecar's dev build lives at
// standalone/src-tauri/target/debug next to it.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const debugDir = join(repoRoot, 'standalone', 'src-tauri', 'target', 'debug');

// Single-quoted PS literals; double any apostrophe in the path so it can't break out.
const debugDirLiteral = debugDir.replace(/'/g, "''");

const script = `
$ErrorActionPreference = 'SilentlyContinue'

# 1. Orphaned Vite squatting on the dev-server port.
$conns = Get-NetTCPConnection -LocalPort ${port} -State Listen
foreach ($procId in ($conns.OwningProcess | Select-Object -Unique)) {
  $proc = Get-Process -Id $procId
  if ($proc -and $proc.ProcessName -eq 'node') {
    Stop-Process -Id $procId -Force
    Write-Output "[free-dev-port] killed orphaned node process $procId holding port ${port}"
  }
}

# 2. Orphaned sidecar node.exe locking the dev build output.
$debugDir = '${debugDirLiteral}'
$sidecars = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$debugDir\\*" }
foreach ($sidecar in $sidecars) {
  Stop-Process -Id $sidecar.ProcessId -Force
  Write-Output "[free-dev-port] killed orphaned sidecar node process $($sidecar.ProcessId) locking $debugDir"
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
