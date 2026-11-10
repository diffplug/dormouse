const path = require('node:path');

/**
 * The absolute path of a program Windows ships, under `%SystemRoot%`. Every
 * Windows system helper these hosts spawn goes by this path, never a bare
 * name: Windows searches the working directory before `PATH`, so a
 * `powershell.exe` planted in whatever folder the host runs in would run
 * instead (docs/specs/security-local.md -> "Spawned programs").
 */
function windowsSystemPath(env, ...segments) {
  return path.win32.join(envValue(env, 'SYSTEMROOT') || 'C:\\Windows', ...segments);
}

/** `env[name]` (`name` upper-case) in any case, as Windows reads its environment. */
function envValue(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Windows PowerShell 5.1, which every supported Windows ships. */
function windowsPowerShellPath(env) {
  return windowsSystemPath(env, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** `cmd.exe` by its absolute path: `ComSpec` when it is a drive path, else
 *  under `%SystemRoot%`. Mirrors `windowsCommandShell` in
 *  `dor-lib-common/src/spawn.ts`, which this CommonJS module cannot load. */
function windowsCommandShell(env) {
  const comspec = envValue(env, 'COMSPEC');
  return comspec && /^[A-Za-z]:[\\/]/.test(comspec) ? comspec : windowsSystemPath(env, 'System32', 'cmd.exe');
}

module.exports = { windowsSystemPath, windowsPowerShellPath, windowsCommandShell };
