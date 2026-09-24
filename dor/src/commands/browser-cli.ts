/** Shared CLI addressing, navigation and executable plumbing for browser providers. */
import { spawnAndCapture } from 'dor-lib-common';
import type { CliOptions, ParseResult, AgentBrowserExecResult } from './types.js';
import { requireControlClient, workspaceParam } from './shared.js';
import { inferredHttpUrl, isSpecialOpenTarget, isSurfaceOpenTarget, resolveSurfaceOpenTarget } from './open-target.js';

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

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

/** What differs between the providers sharing the identity flags. */
export interface SessionFlagOptions {
  /** How the `--key` charset error names the provider's sessions. */
  sessionNoun?: string;
  /** The provider CLI's own spellings of `--session` (Playwright's `-s`);
   *  reported as `--session` in errors. */
  sessionAliases?: readonly string[];
}

export function extractSessionFlags(
  args: string[],
  { sessionNoun = 'an agent-browser session name', sessionAliases = [] }: SessionFlagOptions = {},
): ParseResult<ResolvedSessionFlags> {
  const values = new Map<InterceptedFlag, string>();
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const spells = (name: string) => arg === name || arg.startsWith(`${name}=`);
    const flag = INTERCEPTED_FLAGS.find(spells) ?? (sessionAliases.some(spells) ? '--session' : undefined);
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
    return { ok: false, message: `--key must match ${KEY_PATTERN} (it becomes part of ${sessionNoun})` };
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

// Narrow, now that an unresolvable name never reaches the spawn: this catches a
// binary that disappeared between the PATH walk and the spawn, plus a stub exec's
// injected ENOENT.
export function isMissingBinaryError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
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
