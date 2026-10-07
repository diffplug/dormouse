const path = require('node:path');

/**
 * The absolute path of a program Windows ships, under `%SystemRoot%`. Every
 * Windows system helper these hosts spawn goes by this path, never a bare
 * name: Windows searches the working directory before `PATH`, so a
 * `powershell.exe` planted in whatever folder the host runs in would run
 * instead (docs/specs/security-local.md -> "Spawned programs").
 */
function windowsSystemPath(env, ...segments) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', ...segments);
}

/** Windows PowerShell 5.1, which every supported Windows ships. */
function windowsPowerShellPath(env) {
  return windowsSystemPath(env, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

module.exports = { windowsSystemPath, windowsPowerShellPath };
