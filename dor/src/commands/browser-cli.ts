/**
 * One runner for every browser provider's `dor` passthrough (`dor ab`,
 * `dor pw`): identity flags, the host's binding, open-target resolution, the
 * executable, the forwarded run, and the Surface it binds — each provider a
 * `BrowserCliDescriptor` of what genuinely differs (docs/specs/dor-cli.md →
 * "Browser Surface Addressing").
 */
import {
  BROWSER_PROVIDERS,
  browserBinaryIsMissing,
  isDirectory,
  resolveBinaryPath,
  sessionForKey,
  spawnAndCapture,
  type BrowserAutomationProvider,
} from 'dor-lib-common';
import type {
  BrowserBinding,
  BrowserExec,
  BrowserExecResult,
  CliOptions,
  CliResult,
  ControlClient,
  ParseResult,
} from './types.js';
import { callerWorkingDirectory, errorMessage, fail, requireControlClient, workspaceParam } from './shared.js';
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

export function extractSessionFlags(
  args: string[],
  { sessionNoun, sessionAliases = [] }: Pick<BrowserCliDescriptor, 'sessionNoun' | 'sessionAliases'>,
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
  workspace: string | undefined,
  verbs: ReadonlySet<string>,
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
export async function execBrowserProcess(binary: string, args: string[], cwd?: string): Promise<BrowserExecResult> {
  const result = await spawnAndCapture(binary, args, { cwd });
  if (!result.ok) {
    const error: Error & { code?: string } = new Error(result.error.message);
    error.code = result.error.code;
    throw error;
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** What differs between the providers `runBrowserCli` drives. Their binary
 *  override, default name and allowlist come from the provider registry. */
export interface BrowserCliDescriptor {
  provider: BrowserAutomationProvider;
  /** How the `--key` charset error names the provider's sessions. */
  sessionNoun: string;
  /** The provider CLI's own spellings of `--session` (Playwright's `-s`);
   *  reported as `--session` in errors. */
  sessionAliases?: readonly string[];
  /** The verbs whose target `resolveOpenTargetArgs` rewrites. */
  navigationVerbs: ReadonlySet<string>;
  /** Native commands that never create or resurrect a Surface. */
  noBind: ReadonlySet<string>;
  /** Flags that make any command informational: nothing binds, and nothing
   *  is asked of the host. */
  informational: ReadonlySet<string>;
  /** Whether a session lives in its CLI's project scope, so every command
   *  runs in the binding's directory with its executable. Otherwise a command
   *  runs where and with what the caller has. */
  projectScoped: boolean;
  /** The guidance printed when the binary is not installed. */
  missingBinaryMessage(binary: string): string;
  /** A test's stand-in for the spawn. */
  exec(options: CliOptions): BrowserExec | undefined;
}

/**
 * Forward `args` to the provider's CLI against the session the identity flags
 * name, then open or reuse the Surface bound to it (docs/specs/dor-browser.md
 * → "Managed identity").
 */
export async function runBrowserCli(d: BrowserCliDescriptor, args: string[], options: CliOptions): Promise<CliResult> {
  const parsed = extractSessionFlags(args, d);
  if (!parsed.ok) return fail(parsed.message);
  const flags = parsed.value;

  const command = flags.rest.find((arg) => !arg.startsWith('-'));
  const informational = flags.rest.some((arg) => d.informational.has(arg));
  const mayBind = command !== undefined && !d.noBind.has(command) && !informational;

  const spec = BROWSER_PROVIDERS[d.provider];
  const env = options.env ?? {};
  // An empty override is unset, as for the host.
  const defaultBinary = env[spec.binEnv] || spec.defaultBin;
  // Resolve the binary to an absolute path once: it proves the install present
  // (below), is what we spawn, and travels to the host as `binaryPath` (a GUI
  // host may not share this terminal's PATH). undefined means "not found on
  // PATH" — or, for an explicit path, simply "returned verbatim", which
  // browserBinaryIsMissing re-checks on disk.
  const defaultBinaryPath = resolveBinaryPath(defaultBinary, env);
  const client = requireControlClient(options);
  const callerCwd = callerWorkingDirectory(undefined, env);

  // An informational command needs no binding: nothing binds, and a
  // `--surface` one names no session at all.
  const resolved: ParseResult<Partial<BrowserBinding>> = informational
    ? { ok: true, value: { session: flags.session ?? (flags.key === undefined ? undefined : sessionForKey(flags.key)) } }
    : await resolveBinding(d, flags, client, mayBind ? { cwd: callerCwd, ...(defaultBinaryPath ? { binaryPath: defaultBinaryPath } : {}) } : undefined);
  if (!resolved.ok) return fail(resolved.message);
  const binding = resolved.value;
  // A binding comes off saved pane params, so its directory can be gone (a
  // removed worktree). Say so, rather than let the spawn's ENOENT read as a
  // missing CLI on every later command.
  if (d.projectScoped && binding.cwd !== undefined && !isDirectory(binding.cwd)) {
    return fail(`The directory this ${spec.label} browser was first opened in no longer exists: ${binding.cwd}\nClose its Dormouse pane, or use another --key.`);
  }
  const cwd = d.projectScoped ? binding.cwd ?? callerCwd : undefined;

  // A Dormouse target (a Surface handle, a bare :port) resolves to a URL
  // before forwarding, because the provider only understands URLs. Every other
  // command's args pass through untouched.
  const resolvedRest = await resolveOpenTargetArgs(flags.rest, options, flags.workspace, d.navigationVerbs);
  if (!resolvedRest.ok) return fail(resolvedRest.message);
  const rest = resolvedRest.value;

  // A project-scoped binding's pinned executable replaces the caller's, but it
  // comes back from the host (and off a hand-editable session file), so it
  // passes the same allowlist the host spawns under or the caller's own runs
  // instead — as it also does once the pinned one is gone (an uninstall, a Node
  // version switch). A pin that is the caller's own executable changes nothing.
  let pinned = d.projectScoped && binding.binaryPath !== defaultBinaryPath && spec.isAllowedBinary(binding.binaryPath, env[spec.binEnv])
    ? binding.binaryPath
    : undefined;
  let replacedPin = '';
  if (pinned !== undefined && browserBinaryIsMissing(pinned, env, resolveBinaryPath(pinned, env))) {
    replacedPin = `Warning: this browser's ${spec.defaultBin} (${pinned}) is gone; ran ${defaultBinaryPath ?? defaultBinary} instead.\n`;
    pinned = undefined;
  }
  const binary = pinned ?? defaultBinary;
  const binaryPath = binary === defaultBinary ? defaultBinaryPath : resolveBinaryPath(binary, env);

  // Detect a missing install deterministically, before spawning. A failed
  // spawn on Windows emits BOTH 'error' (ENOENT) and 'close'; if 'close' wins
  // that race the process resolves with a bogus exit code and no output.
  // Skipped when a stub exec is injected (tests), which supplies its own
  // ENOENT behavior via the catch below.
  const stub = d.exec(options);
  if (stub === undefined && browserBinaryIsMissing(binary, env, binaryPath)) return fail(d.missingBinaryMessage(binary));
  const exec = stub ?? execBrowserProcess;

  let result: BrowserExecResult;
  try {
    // Spawn the resolved path, never the bare name: cross-spawn resolves a bare
    // name through `which`, which checks `process.cwd()` *before* PATH on
    // Windows, so an `agent-browser.cmd` sitting in a cloned repository would
    // win the race against the real install (docs/specs/dor-cli.md ->
    // "Spawning External Binaries"). `?? binary` is reached only by a stub.
    const forwarded = [...(binding.session === undefined ? [] : spec.sessionArgs(binding.session)), ...rest];
    result = await (cwd === undefined ? exec(binaryPath ?? binary, forwarded) : exec(binaryPath ?? binary, forwarded, cwd));
  } catch (error) {
    return isMissingBinaryError(error) ? fail(d.missingBinaryMessage(binary)) : fail(errorMessage(error));
  }
  result.stderr = replacedPin + result.stderr;

  // Outside a Dormouse terminal there is no control endpoint; stay a pure
  // passthrough rather than nagging about the missing surface.
  if (result.exitCode === 0 && mayBind && binding.session !== undefined && !(client instanceof Error)) {
    try {
      await client.browserSurface({
        provider: d.provider,
        key: flags.key,
        session: binding.session,
        cwd: cwd ?? callerCwd,
        ...(binaryPath ? { binaryPath } : {}),
        ...workspaceParam(flags.workspace),
      });
    } catch (error) {
      result.stderr += `Warning: could not open the Dormouse browser surface: ${errorMessage(error)}\n`;
    }
  }
  return result;
}

/**
 * The binding to run with — one `surface.resolveBrowser` round trip for the two
 * forms only the host can name:
 *
 * - `--session <name>` is already the session; nothing is asked.
 * - `--key <name>` is namespaced under the Workspace that will hold the
 *   browser, which only that Workspace knows: the host answers with the
 *   binding of the Surface holding the key, or mints one, pinning `proposed`
 *   for a command that may bind. **Outside Dormouse the CLI namespaces it
 *   itself**, so the command stays a passthrough with no control endpoint.
 * - `--surface <handle>` is that Surface's binding. The host owns the gating:
 *   the target must have a browser of this provider with a session.
 *
 * The host's messages are printed verbatim. **A host that refuses fails the
 * command** before the binary runs — there is no fallback to a CLI-namespaced
 * key, which would name the wrong Workspace's browser
 * (`docs/specs/dor-browser.md` → "Managed identity").
 */
async function resolveBinding(
  d: BrowserCliDescriptor,
  flags: ResolvedSessionFlags,
  client: ControlClient | Error,
  proposed: Omit<BrowserBinding, 'session'> | undefined,
): Promise<ParseResult<BrowserBinding>> {
  if (flags.session !== undefined) return { ok: true, value: { session: flags.session } };
  if (client instanceof Error) {
    return flags.key === undefined
      ? { ok: false, message: client.message }
      : { ok: true, value: { session: sessionForKey(flags.key) } };
  }
  try {
    const { binding } = await client.resolveBrowser({
      provider: d.provider,
      ...(flags.key === undefined ? { surface: flags.surface } : { key: flags.key, ...(proposed ? { proposed } : {}) }),
      ...workspaceParam(flags.workspace),
    });
    return { ok: true, value: binding };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
