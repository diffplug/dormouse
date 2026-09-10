/** Shared CLI addressing, navigation and executable plumbing for browser providers. */
import { existsSync } from 'node:fs';
import { spawnAndCapture, sessionForKey } from 'dor-lib-common';
import type { CliEnv, CliOptions, ParseResult, AgentBrowserExecResult } from './types.js';
import { requireControlClient } from './shared.js';
import { inferredHttpUrl, isSpecialOpenTarget, isSurfaceOpenTarget, resolveSurfaceOpenTarget } from './open-target.js';
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const WINDOWS_BIN_EXTS = ['.cmd', '.exe', '.bat'];
/** The three identity flags dor intercepts, in the order they are reported when
 *  more than one is given. */
const IDENTITY_FLAGS = ['--key', '--session', '--surface'] as const;
type IdentityFlag = (typeof IDENTITY_FLAGS)[number];

/** Either a session known CLI-side (from `--session`, or namespaced from
 *  `--key`) or a Surface handle for the host to resolve — never neither, never
 *  both. A union rather than two optionals so the arm that has no session is
 *  the arm that has a surface, by construction. `key` rides along only when it
 *  named the session: a raw or surface-addressed session may be GUI-minted,
 *  which no key names. */
export type ResolvedSessionFlags = { rest: string[] } & (
  | { session: string; key?: string; surface?: undefined }
  | { surface: string; session?: undefined; key?: undefined }
);

export function extractSessionFlags(args: string[]): ParseResult<ResolvedSessionFlags> {
  const values = new Map<IdentityFlag, string>();
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const flag = IDENTITY_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
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

  const surface = values.get('--surface');
  if (surface !== undefined) return { ok: true, value: { surface, rest } };

  const session = values.get('--session');
  if (session !== undefined) return { ok: true, value: { session, rest } };

  const resolvedKey = key ?? 'default';
  return { ok: true, value: { key: resolvedKey, session: sessionForKey(resolvedKey), rest } };
}

// agent-browser's URL-navigation verbs. `goto` / `navigate` are documented
// aliases of `open`, so a Dormouse target resolves the same in all three.
const OPEN_SUBCOMMANDS = new Set(['open', 'goto', 'navigate']);

/**
 * Rewrite a forwarded navigation argv so agent-browser receives a URL:
 * `surface:` handles resolve via the host port scan, a bare `:port`/`host:port`
 * sugars to http. Non-navigation commands and plain URLs pass through unchanged.
 *
 * The target is matched by shape (not position), which is what lets `open
 * --headed surface:3` resolve — dor can't know agent-browser's flag arity, so it
 * can't reliably find "the positional". The trade-off is that a *flag value*
 * shaped like a target would be grabbed; this is safe because no agent-browser
 * `open` flag takes a `surface:`/`:port`/`host:port`-shaped value (`--headers` is
 * JSON, `--init-script` a path, `--enable` a feature name), and `inferredHttpUrl`
 * rejects a bare-integer host so a stray `n:n` value can't become a URL. Only the
 * first special-shaped arg is rewritten — these verbs take a single target.
 */
export async function resolveOpenTargetArgs(rest: string[], options: CliOptions, verbs = OPEN_SUBCOMMANDS): Promise<ParseResult<string[]>> {
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
    const resolved = await resolveSurfaceOpenTarget(raw, client);
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

export function resolveBinaryPath(binary: string, env: CliEnv): string | undefined {
  if (binary.includes('/') || binary.includes('\\')) return binary;
  const pathVar = env.PATH;
  if (!pathVar) return undefined;
  const isWindows = process.platform === 'win32';
  const names = isWindows ? WINDOWS_BIN_EXTS.map((ext) => `${binary}${ext}`) : [binary];
  for (const dir of pathVar.split(isWindows ? ';' : ':')) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = `${dir}${isWindows ? '\\' : '/'}${name}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function isMissingBinaryError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Whether the binary can be proven absent without spawning it, given the path
 * `resolveBinaryPath` already produced for it. Returns true only when the absence
 * is certain; ambiguous cases (no PATH to search) fall through to the spawn,
 * which still rejects with ENOENT.
 */
export function browserBinaryIsMissing(binary: string, env: CliEnv, resolvedPath: string | undefined): boolean {
  // Explicit path (e.g. a DORMOUSE_AGENT_BROWSER_BIN override): resolveBinaryPath
  // hands such a path back verbatim without touching disk, so check it (and
  // Windows launcher extensions) directly.
  if (binary.includes('/') || binary.includes('\\')) {
    return !existsCandidate(binary, process.platform === 'win32');
  }
  // Bare name: resolvedPath is the PATH walk's result. Without a PATH to search
  // we can't prove anything, so let the spawn decide.
  if (!env.PATH) return false;
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
