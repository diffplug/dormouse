/**
 * What a Windows `.cmd`/`.bat` shim runs, so `spawnAndCapture` can start it
 * without `cmd.exe` when the cwd is a UNC path — a WSL caller's
 * `\\wsl.localhost\<distro>\...`. `cmd.exe` cannot start in one: it warns and
 * runs in `%SystemRoot%` instead, so relative paths and project config would
 * resolve there.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isExecutableFile, resolveBinaryPath, type BinaryEnv } from './resolve-binary.js';

// The quoted `%~dp0`/`%dp0%`-relative program a shim hands its arguments to:
// agent-browser's `"%~dp0node_modules\...\cli.exe" %*`, npm cmd-shim's
// `"%_prog%" "%dp0%\node_modules\...\cli.js" %*`, pnpm's
// `node "%~dp0\..\pkg\bin.mjs" %*`.
const SHIM_TARGET = /"((?:%~dp0|%dp0%)[^"%]*)"\s+%\*/g;
const MAX_SHIM_BYTES = 64 * 1024;

/**
 * The program and leading arguments `shim` runs, or undefined when it is not
 * one shape this reads: exactly one `%~dp0`-relative target, a native
 * executable run as itself or a script run by the `node.exe` beside the shim,
 * else the `node` on `PATH`. Reading the shim trusts nothing running it does
 * not: what it names is what `cmd.exe` would run.
 */
export function cmdShimTarget(shim: string, env: BinaryEnv): { binary: string; args: string[] } | undefined {
  let text: string;
  try {
    if (statSync(shim).size > MAX_SHIM_BYTES) return undefined;
    text = readFileSync(shim, 'utf8');
  } catch { return undefined; }
  const targets = new Set(Array.from(text.matchAll(SHIM_TARGET), (match) => match[1]));
  if (targets.size !== 1) return undefined;
  const dir = path.win32.dirname(shim);
  const target = path.win32.resolve(dir, [...targets][0].replace(/^(?:%~dp0|%dp0%)[\\/]?/, ''));
  if (!isExecutableFile(target, true)) return undefined;
  if (/\.(?:exe|com)$/i.test(target)) return { binary: target, args: [] };
  const besides = path.win32.join(dir, 'node.exe');
  const node = isExecutableFile(besides, true) ? besides : resolveBinaryPath('node', env);
  return node === undefined ? undefined : { binary: node, args: [target] };
}
