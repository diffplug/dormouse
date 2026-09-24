/** Shared CLI addressing, navigation and executable plumbing for browser providers. */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { spawnAndCapture } from 'dor-lib-common';
import type { CliEnv, CliOptions, ParseResult, AgentBrowserExecResult } from './types.js';
import { requireControlClient, workspaceParam } from './shared.js';
import { inferredHttpUrl, isSpecialOpenTarget, isSurfaceOpenTarget, resolveSurfaceOpenTarget } from './open-target.js';

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

// Extensions a bare command name can carry on Windows, and the order to try
// them in. This is `which@2`'s own hardcoded fallback — npm's list, deliberately
// NOT cmd.exe's `.COM;.EXE;.BAT;.CMD` — because `resolveBinaryPath` now picks
// the file that gets spawned and has to choose the same one cross-spawn's
// `which` would (docs/specs/dor-cli.md → "Spawning External Binaries").
// Source: `getPathInfo` in `which/which.js`. Shared by resolveBinaryPath (PATH
// walk) and existsCandidate (explicit path, where order only affects reporting).
const WINDOWS_BIN_EXTS = ['.EXE', '.CMD', '.BAT', '.COM'];

/** The three identity flags dor intercepts, in the order they are reported when
 *  more than one is given. */
const IDENTITY_FLAGS = ['--key', '--session', '--surface'] as const;

/** Every flag dor takes out of the forwarded argv: the identities plus the
 *  container, which names a Workspace rather than a browser. */
const INTERCEPTED_FLAGS = [...IDENTITY_FLAGS, '--workspace'] as const;
type InterceptedFlag = (typeof INTERCEPTED_FLAGS)[number];

/** How the browser was named: a raw session known CLI-side, a managed `--key`
 *  the host namespaces under the target Workspace, or a Surface handle the host
 *  resolves — exactly one of the three, by construction. `key` rides along only
 *  when it named the session: a raw or surface-addressed session may be
 *  GUI-minted, which no key names. */
export type ResolvedSessionFlags = { rest: string[]; workspace?: string } & (
  | { session: string; key?: undefined; surface?: undefined }
  | { key: string; session?: undefined; surface?: undefined }
  | { surface: string; session?: undefined; key?: undefined }
);

export function extractSessionFlags(args: string[]): ParseResult<ResolvedSessionFlags> {
  const values = new Map<InterceptedFlag, string>();
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const flag = INTERCEPTED_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (!flag) {
      rest.push(arg);
      continue;
    }

    let value: string | undefined;
    if (arg.includes('=')) {
      value = arg.slice(arg.indexOf('=') + 1);
    } else {
      value = args[index + 1];
      index += 1;
    }
    if (!value || value.startsWith('-')) {
      return { ok: false, message: `${flag} requires a value` };
    }
    values.set(flag, value);
  }

  // Three ways to name one browser; naming it twice is always a mistake, never
  // a precedence question.
  const given = IDENTITY_FLAGS.filter((flag) => values.has(flag));
  if (given.length > 1) {
    // "--key and --session"; "--key, --session and --surface" — reported in
    // IDENTITY_FLAGS order, not argv order, so the message is stable.
    const joined = `${given.slice(0, -1).join(', ')} and ${given[given.length - 1]}`;
    return { ok: false, message: `${joined} are mutually exclusive` };
  }

  const key = values.get('--key');
  if (key !== undefined && !KEY_PATTERN.test(key)) {
    return { ok: false, message: `--key must match ${KEY_PATTERN} (it becomes part of an agent-browser session name)` };
  }

  const workspace = workspaceParam(values.get('--workspace'));

  const surface = values.get('--surface');
  if (surface !== undefined) return { ok: true, value: { surface, rest, ...workspace } };

  const session = values.get('--session');
  if (session !== undefined) return { ok: true, value: { session, rest, ...workspace } };

  // The key's session name belongs to the Workspace that will hold the browser,
  // so it is resolved host-side rather than built here.
  return { ok: true, value: { key: key ?? 'default', rest, ...workspace } };
}

// agent-browser's URL-navigation verbs. `goto` / `navigate` are documented
// aliases of `open`, so a Dormouse target resolves the same in all three.
const OPEN_SUBCOMMANDS = new Set(['open', 'goto', 'navigate']);

/**
 * Rewrite a forwarded navigation argv so the provider receives a URL:
 * `surface:` handles resolve via the host port scan, a bare `:port`/`host:port`
 * sugars to http. Non-navigation commands and plain URLs pass through unchanged.
 *
 * The target is matched by shape (not position), which is what lets `open
 * --headed surface:3` resolve — dor can't know the provider's flag arity, so it
 * can't reliably find "the positional". The trade-off is that a *flag value*
 * shaped like a target would be grabbed; this is safe because no agent-browser
 * `open` flag takes a `surface:`/`:port`/`host:port`-shaped value (`--headers` is
 * JSON, `--init-script` a path, `--enable` a feature name), and `inferredHttpUrl`
 * rejects a bare-integer host so a stray `n:n` value can't become a URL. Only the
 * first special-shaped arg is rewritten — these verbs take a single target.
 */
export async function resolveOpenTargetArgs(
  rest: string[],
  options: CliOptions,
  workspace?: string,
  verbs = OPEN_SUBCOMMANDS,
): Promise<ParseResult<string[]>> {
  const subcommand = rest.find((arg) => !arg.startsWith('-'));
  if (subcommand === undefined || !verbs.has(subcommand)) return { ok: true, value: rest };

  const index = rest.findIndex((arg) => isSpecialOpenTarget(arg));
  if (index === -1) return { ok: true, value: rest };

  const raw = rest[index] ?? '';
  let url: string;
  if (isSurfaceOpenTarget(raw)) {
    // A Surface handle only resolves against a live Dormouse host; outside one
    // there is no control endpoint and the error says so.
    const client = requireControlClient(options);
    if (client instanceof Error) return { ok: false, message: client.message };
    const resolved = await resolveSurfaceOpenTarget(raw, client, workspace);
    if (!resolved.ok) return resolved;
    url = resolved.value;
  } else {
    // A schemeless :port / host:port needs no host round trip. isSpecialOpenTarget
    // matched a non-surface target, so inference here always succeeds; leave argv
    // untouched rather than forward a non-URL if that ever changes.
    const inferred = inferredHttpUrl(raw);
    if (inferred === null) return { ok: true, value: rest };
    url = inferred;
  }

  const next = [...rest];
  next[index] = url;
  return { ok: true, value: next };
}

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
export function binaryCandidateNames(binary: string, env: CliEnv, isWindows: boolean): string[] {
  if (!isWindows) return [binary];
  // No `.filter(Boolean)`: `getPathInfo` splits without one, so a trailing
  // separator — ordinary on Windows — leaves a final empty extension that tries
  // the name unsuffixed. Nothing runnable lives there, but dropping it would make
  // the walk report missing where `which` returned a path.
  const exts = (env.PATHEXT || WINDOWS_BIN_EXTS.join(';')).split(';');
  if (binary.includes('.')) exts.unshift('');
  return exts.map((ext) => `${binary}${ext}`);
}

export function resolveBinaryPath(binary: string, env: CliEnv): string | undefined {
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

// Narrow, now that an unresolvable name never reaches the spawn: this catches a
// binary that disappeared between the PATH walk and the spawn, plus a stub exec's
// injected ENOENT.
export function isMissingBinaryError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Whether the binary can be proven absent without spawning it, given the path
 * `resolveBinaryPath` already produced for it. Every "not found" answer ends the
 * call here rather than at the spawn, because the spawn's own fallback is the
 * bare name and cross-spawn resolves that against the cwd first on Windows.
 */
export function browserBinaryIsMissing(binary: string, env: CliEnv, resolvedPath: string | undefined): boolean {
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

// The default exec: delegate the spawn/capture/Windows handling to
// spawnAndCapture, and adapt its never-throws result to this call site's
// throw-on-spawn-failure contract (callers catch ENOENT via isMissingBinaryError).
export async function execBrowserProcess(binary: string, args: string[], cwd?: string): Promise<AgentBrowserExecResult> {
  const result = await spawnAndCapture(binary, args, { cwd });
  if (!result.ok) {
    const error: Error & { code?: string } = new Error(result.error.message);
    error.code = result.error.code;
    throw error;
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
