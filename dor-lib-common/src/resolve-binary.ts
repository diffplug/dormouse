/**
 * Resolve an external binary to the file cross-spawn's `which` would run, so
 * callers spawn that absolute path rather than the bare name. Shared by `dor`
 * and the `lib` host; see docs/specs/dor-cli.md → "Spawning External Binaries".
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';

/** The environment the walk reads: `PATH`, and `PATHEXT` on Windows. */
export interface BinaryEnv {
  readonly [key: string]: string | undefined;
}

// Extensions a bare command name can carry on Windows, and the order to try
// them in. This is `which@2`'s own hardcoded fallback — npm's list, deliberately
// NOT cmd.exe's `.COM;.EXE;.BAT;.CMD` — because `resolveBinaryPath` now picks
// the file that gets spawned and has to choose the same one cross-spawn's
// `which` would (docs/specs/dor-cli.md → "Spawning External Binaries").
// Source: `getPathInfo` in `which/which.js`. Shared by resolveBinaryPath (PATH
// walk) and existsCandidate (explicit path, where order only affects reporting).
const WINDOWS_BIN_EXTS = ['.EXE', '.CMD', '.BAT', '.COM'];

/**
 * Whether `candidate` is a file this platform would actually run. `which` (and
 * so cross-spawn) skips a directory or a non-executable file and keeps walking;
 * since the walk's answer is now the spawn target, a laxer test here would turn
 * a `PATH` entry `which` ignored into an EACCES/EISDIR failure. On Windows the
 * extension decides executability, so being a regular file is the whole test —
 * taken as an argument, like `binaryCandidateNames`, so both branches are
 * reachable from a Linux-only CI.
 */
export function isExecutableFile(candidate: string, isWindows: boolean): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (isWindows) return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The filenames to try for a bare `binary`, in order — `which`'s extension logic,
 * which the walk has to reproduce because its answer is what gets spawned. Takes
 * `isWindows` rather than reading `process.platform` so the Windows ordering is
 * testable off Windows: every rule here is Windows-only, and a Linux-only CI
 * that could not exercise them would be asserting an unenforced claim.
 *
 * Mirrors `getPathInfo` in `which/which.js` on three points a hand-rolled walk
 * gets wrong: `||` (not `??`), so an *empty* PATHEXT falls back rather than
 * yielding no candidates; the fallback list is npm's, not `cmd.exe`'s; and an
 * empty extension comes first when the name already carries one, so
 * `agent-browser.exe` is tried as itself and not only as `agent-browser.exe.EXE`.
 */
export function binaryCandidateNames(binary: string, env: BinaryEnv, isWindows: boolean): string[] {
  if (!isWindows) return [binary];
  // No `.filter(Boolean)`: `getPathInfo` splits without one, so a trailing
  // separator — ordinary on Windows — leaves a final empty extension that tries
  // the name unsuffixed. Nothing runnable lives there, but dropping it would make
  // the walk report missing where `which` returned a path.
  const exts = (env.PATHEXT || WINDOWS_BIN_EXTS.join(';')).split(';');
  if (binary.includes('.')) exts.unshift('');
  return exts.map((ext) => `${binary}${ext}`);
}

/**
 * The absolute path `binary` resolves to on `env.PATH`, or undefined when no
 * `PATH` directory holds it. An explicit path comes back verbatim, unchecked.
 */
export function resolveBinaryPath(binary: string, env: BinaryEnv): string | undefined {
  if (binary.includes('/') || binary.includes('\\')) return binary;
  const pathVar = env.PATH;
  if (!pathVar) return undefined;
  const isWindows = process.platform === 'win32';
  const names = binaryCandidateNames(binary, env, isWindows);
  for (const dir of pathVar.split(isWindows ? ';' : ':')) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = `${dir}${isWindows ? '\\' : '/'}${name}`;
      if (isExecutableFile(candidate, isWindows)) return candidate;
    }
  }
  return undefined;
}

/**
 * Whether the binary can be proven absent without spawning it, given the path
 * `resolveBinaryPath` already produced for it. Every "not found" answer ends the
 * call here rather than at the spawn, because the spawn's own fallback is the
 * bare name and cross-spawn resolves that against the cwd first on Windows.
 */
export function browserBinaryIsMissing(binary: string, env: BinaryEnv, resolvedPath: string | undefined): boolean {
  // Explicit path (e.g. a DORMOUSE_AGENT_BROWSER_BIN override): resolveBinaryPath
  // hands such a path back verbatim without touching disk, so check it (and
  // Windows launcher extensions) directly.
  if (binary.includes('/') || binary.includes('\\')) {
    return !existsCandidate(binary, process.platform === 'win32');
  }
  // Bare name: resolvedPath is the PATH walk's result. With no PATH to search
  // there is nowhere the binary could legitimately be, and falling through to
  // the spawn would hand cross-spawn a bare name — whose `which` searches the
  // cwd first on Windows, the one thing spawning the resolved path exists to
  // prevent. So an absent PATH is "missing", not "ambiguous".
  if (!env.PATH) return true;
  return resolvedPath === undefined;
}

function existsCandidate(path: string, isWindows: boolean): boolean {
  if (existsSync(path)) return true;
  if (!isWindows) return false;
  return WINDOWS_BIN_EXTS.some((ext) => existsSync(`${path}${ext}`));
}
