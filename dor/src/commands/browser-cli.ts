/**
 * One runner for every browser provider's `dor` passthrough (`dor agent-browser`,
 * `dor playwright`): identity flags, the host's binding, open-target resolution, the
 * executable, the forwarded run, and the Surface it binds — each provider a
 * `BrowserCliDescriptor` of what genuinely differs (docs/specs/dor-cli.md →
 * "Browser Surface Addressing").
 */
import {
  BROWSER_PROVIDERS,
  browserBinaryIsMissing,
  isDirectory,
  parseStreamPort,
  resolveBinaryPath,
  sessionForKey,
  spawnAndCapture,
  type BrowserAutomationProvider,
} from 'dor-lib-common';
import { isFixedBrowserViewport, type BrowserViewportSetting } from 'dor-lib-common/browser-viewports';
import type {
  BrowserBinding,
  BrowserExec,
  BrowserExecResult,
  BrowserViewportRequest,
  ResolveBrowserResponse,
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
  const subcommand = rest.find((arg) => verbs.has(arg));
  if (subcommand === undefined || !verbs.has(subcommand)) return { ok: true, value: rest };

  const commandIndex = rest.findIndex((arg) => verbs.has(arg));
  const valueFlags = verbs.has('navigate') ? AGENT_BROWSER_VALUE_FLAGS : PLAYWRIGHT_OPEN_VALUE_FLAGS;
  const booleanFlags = verbs.has('navigate') ? AGENT_BROWSER_BOOLEAN_FLAGS : PLAYWRIGHT_OPEN_BOOLEAN_FLAGS;
  let index = -1;
  for (let i = commandIndex + 1; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg.startsWith('-')) {
      const [name] = arg.split('=', 1);
      if (valueFlags.has(name)) { if (!arg.includes('=')) i += 1; continue; }
      if (booleanFlags.has(name)) { if (rest[i + 1] === 'true' || rest[i + 1] === 'false') i += 1; continue; }
      return { ok: true, value: rest };
    }
    if (isSpecialOpenTarget(arg)) { index = i; break; }
  }
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
export async function execBrowserProcess(binary: string, args: string[], cwd?: string, env?: Record<string, string>): Promise<BrowserExecResult> {
  const result = await spawnAndCapture(binary, args, { cwd, env: env ? { ...process.env, ...env } : undefined });
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
  /** The argv that reads the session's stream port once a command has
   *  succeeded — the browser exists then, so asking starts none — under the
   *  caller's own environment; the port it prints is handed over with the
   *  bind. Absent when the host reports the port. */
  streamStatus?(session: string): string[];
}

const AGENT_BROWSER_VALUE_FLAGS = new Set([
  '--headers', '--profile', '--restore-save', '--restore-check-url', '--restore-check-text', '--restore-check-fn',
  '--session-name', '--state', '--namespace', '--executable-path', '--extension', '--init-script', '--enable',
  '--args', '--user-agent', '--proxy', '--proxy-bypass', '--hide-scrollbars', '--provider', '-p', '--device',
  '--screenshot-dir', '--screenshot-quality', '--screenshot-format', '--cdp', '--color-scheme', '--download-path',
  '--max-output', '--allowed-domains', '--action-policy', '--confirm-actions', '--engine', '--model', '--config',
]);
const AGENT_BROWSER_BOOLEAN_FLAGS = new Set([
  '--headed', '--ignore-https-errors', '--allow-file-access', '--json', '--annotate', '--auto-connect', '--content-boundaries',
  '--confirm-interactive', '--no-auto-dialog', '--verbose', '-v', '--quiet', '-q', '--debug', '--restore',
]);

/** Build a blank navigation with every launch option preserved. Unknown flags
 * are refused: guessing their arity could replace a flag value and let the
 * destination page run before its viewport is ready. */
function blankNavigationArgs(args: string[]): string[] | Error {
  const result = [...args];
  const verbIndex = result.findIndex((arg) => arg === 'open' || arg === 'goto' || arg === 'navigate');
  if (verbIndex < 0) return new Error('No navigation command to prepare');
  const positions: number[] = [];
  for (let i = 0; i < result.length; i += 1) {
    const arg = result[i] ?? '';
    if (i === verbIndex) continue;
    if (arg.startsWith('-')) {
      const [name] = arg.split('=', 1);
      if (AGENT_BROWSER_VALUE_FLAGS.has(name)) {
        if (!arg.includes('=')) { if (i + 1 >= result.length) return new Error(`${name} requires a value`); i += 1; }
      } else if (AGENT_BROWSER_BOOLEAN_FLAGS.has(name)) {
        if (result[i + 1] === 'true' || result[i + 1] === 'false') i += 1;
      } else return new Error(`Cannot prepare viewport with unknown agent-browser option '${arg}'`);
    } else {
      positions.push(i);
    }
  }
  if (positions.length !== 1) return new Error('Cannot determine the agent-browser navigation URL for viewport preparation');
  result[positions[0]!] = 'about:blank';
  return result;
}

function hasExplicitAgentBrowserDevice(args: string[], env: Record<string, string | undefined>): boolean {
  const special = ['--device', '--cdp', '--auto-connect', '--provider', '-p'];
  return args.some((arg) => special.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
    || args.some((arg, index) => arg === '--headed' && args[index + 1] !== 'false' || arg === '--headed=true')
    || Boolean(env.AGENT_BROWSER_IOS_DEVICE || env.AGENT_BROWSER_CDP || env.AGENT_BROWSER_AUTO_CONNECT || env.AGENT_BROWSER_PROVIDER)
    || env.AGENT_BROWSER_HEADED === 'true';
}

function hasExplicitPlaywrightLaunch(args: string[]): boolean {
  const special = ['--device', '--mobile', '--headed'];
  return args.some((arg) => special.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function parseNativeDpr(output: string): number | undefined {
  const value = output.trim();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = value; }
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof parsed === 'number' || typeof parsed === 'string') {
      const number = Number(parsed);
      return Number.isFinite(number) && number > 0 && number <= 10 ? number : undefined;
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const object = parsed as Record<string, unknown>;
    parsed = object.result ?? object.value ?? object.data;
  }
  return undefined;
}

const PLAYWRIGHT_OPEN_VALUE_FLAGS = new Set(['--browser', '--config', '--device', '--idle-timeout', '--profile']);
const PLAYWRIGHT_OPEN_BOOLEAN_FLAGS = new Set(['--headed', '--mobile', '--persistent', '--json', '--raw']);

function playwrightDestination(args: string[]): { blank: string[]; goto: string[] } | Error {
  const openIndex = args.indexOf('open');
  if (openIndex < 0) return new Error('No playwright open command to prepare');
  const targetIndices: number[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (i === openIndex) continue;
    const arg = args[i] ?? '';
    if (arg.startsWith('-')) {
      const [name] = arg.split('=', 1);
      if (PLAYWRIGHT_OPEN_VALUE_FLAGS.has(name)) {
        if (!arg.includes('=')) { if (i + 1 >= args.length) return new Error(`${name} requires a value`); i += 1; }
      } else if (!PLAYWRIGHT_OPEN_BOOLEAN_FLAGS.has(name)) {
        return new Error(`Cannot prepare playwright viewport with option '${arg}'`);
      }
    } else targetIndices.push(i);
  }
  if (targetIndices.length !== 1) return new Error('Cannot determine the playwright navigation URL for viewport preparation');
  const blank = [...args];
  blank[targetIndices[0]!] = 'about:blank';
  const goto = ['goto', args[targetIndices[0]!]!, ...args.filter((arg) => arg === '--json' || arg === '--raw')];
  return { blank, goto };
}

function nativeCommand(provider: BrowserAutomationProvider, args: string[]): string | undefined {
  if (provider === 'playwright') {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] ?? '';
      if (!arg.startsWith('-')) return arg;
      const [name] = arg.split('=', 1);
      if (PLAYWRIGHT_OPEN_VALUE_FLAGS.has(name)) { if (!arg.includes('=')) i += 1; continue; }
      if (!PLAYWRIGHT_OPEN_BOOLEAN_FLAGS.has(name)) return undefined;
    }
    return undefined;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) return arg;
    const [name] = arg.split('=', 1);
    if (AGENT_BROWSER_VALUE_FLAGS.has(name)) { if (!arg.includes('=')) i += 1; continue; }
    if (AGENT_BROWSER_BOOLEAN_FLAGS.has(name)) {
      if (args[i + 1] === 'true' || args[i + 1] === 'false') i += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
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

  if (flags.rest[0] === 'dor-embed-size') return runEmbedSize(d.provider, flags, options);

  const command = nativeCommand(d.provider, flags.rest);
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
  const resolved: ParseResult<ResolveBrowserResponse> = informational
    ? { ok: true, value: { binding: { session: flags.session ?? (flags.key === undefined ? '' : sessionForKey(flags.key)) } } }
    : await resolveBinding(d, flags, client, mayBind ? { cwd: callerCwd, ...(defaultBinaryPath ? { binaryPath: defaultBinaryPath } : {}) } : undefined);
  if (!resolved.ok) return fail(resolved.message);
  const { binding, fresh, initialViewport, launchViewport } = resolved.value;
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
  // Spawn the resolved path, never the bare name: cross-spawn resolves a bare
  // name through `which`, which checks `process.cwd()` *before* PATH on
  // Windows, so an `agent-browser.cmd` sitting in a cloned repository would
  // win the race against the real install (docs/specs/dor-cli.md ->
  // "Spawning External Binaries"). `?? binary` is reached only by a stub.
  const run = (argv: string[], envOverride?: Record<string, string>) => envOverride
    ? exec(binaryPath ?? binary, argv, cwd, envOverride)
    : cwd === undefined ? exec(binaryPath ?? binary, argv) : exec(binaryPath ?? binary, argv, cwd);

  let result: BrowserExecResult;
  let prebound = false;
  const explicitDevice = d.provider === 'agent-browser'
    ? hasExplicitAgentBrowserDevice(rest, env)
    : hasExplicitPlaywrightLaunch(rest);
  try {
    const sessionArgs = binding.session ? spec.sessionArgs(binding.session) : [];
    const launching = fresh === true && d.provider === 'agent-browser' && d.navigationVerbs.has(command ?? '')
      && launchViewport !== undefined && !explicitDevice;
    if (launching) {
      const blankArgs = blankNavigationArgs(rest);
      if (blankArgs instanceof Error) return fail(blankArgs.message);
      const blank = await run([...sessionArgs, ...blankArgs]);
      if (blank.exitCode !== 0) return fail(`Could not prepare the agent-browser viewport before navigation: ${blank.stderr.trim() || `agent-browser exited ${blank.exitCode}`}`);
      let dpr = launchViewport.dpr;
      if (dpr === undefined) {
        const ratio = await run([...sessionArgs, 'eval', 'window.devicePixelRatio']);
        dpr = ratio.exitCode === 0 ? parseNativeDpr(ratio.stdout) : undefined;
        if (dpr === undefined) return fail('Could not measure agent-browser DPR before navigation');
      }
      const viewport = await run([...sessionArgs, 'set', 'viewport', String(launchViewport.width), String(launchViewport.height), String(dpr)]);
      if (viewport.exitCode !== 0) return fail(`Could not set the agent-browser viewport before navigation: ${viewport.stderr.trim() || `agent-browser exited ${viewport.exitCode}`}`);
    }
    const playwrightOpen = d.provider === 'playwright' && command === 'open' && launchViewport !== undefined && !explicitDevice;
    const launchEnv = playwrightOpen
      ? { PLAYWRIGHT_MCP_VIEWPORT_SIZE: `${launchViewport.width}x${launchViewport.height}` }
      : undefined;
    const requestedDpr = playwrightOpen && initialViewport?.mode === 'fixed' ? initialViewport.dpr : undefined;
    if (requestedDpr !== undefined && client instanceof Error) return fail(client.message);
    if (requestedDpr !== undefined && !(client instanceof Error)) {
      const navigation = playwrightDestination(rest);
      if (navigation instanceof Error) return fail(navigation.message);
      const blank = await run([...sessionArgs, ...navigation.blank], launchEnv);
      if (blank.exitCode !== 0) return fail(`Could not prepare the playwright viewport before navigation: ${blank.stderr.trim() || `playwright exited ${blank.exitCode}`}`);
      const preparedSurface = await client.browserSurface({
        provider: d.provider, key: flags.key, session: binding.session, cwd: cwd ?? callerCwd,
        ...(binaryPath ? { binaryPath } : {}), ...(fresh && initialViewport ? { initialViewport } : {}),
        ...workspaceParam(flags.workspace),
      });
      prebound = true;
      const measured = await client.browserViewport({
        provider: d.provider,
        ...(flags.key === undefined ? flags.surface === undefined ? { session: flags.session! } : { surface: flags.surface } : { key: flags.key }),
        ...workspaceParam(flags.workspace),
      } as BrowserViewportRequest);
      if (!measured.actual || Math.abs(measured.actual.dpr - requestedDpr) > 0.001) {
        if (preparedSurface.status === 'created') {
          try {
            await client.killSurface({ surface: preparedSurface.surfaceId, confirmation: { mode: 'dangerously' }, ...workspaceParam(flags.workspace) });
          } catch {
            // The DPR refusal remains the useful error even if cleanup loses
            // a race with the user closing the preparatory Surface.
          }
        }
        return fail(`playwright context DPR is ${measured.actual?.dpr ?? 'unavailable'}; requested ${requestedDpr}. The destination was not opened.`);
      }
      result = await run([...sessionArgs, ...navigation.goto]);
    } else {
      result = await run([...sessionArgs, ...rest], launchEnv);
    }
  } catch (error) {
    return isMissingBinaryError(error) ? fail(d.missingBinaryMessage(binary)) : fail(errorMessage(error));
  }
  result.stderr = replacedPin + result.stderr;

  // Outside a Dormouse terminal there is no control endpoint; stay a pure
  // passthrough rather than nagging about the missing surface.
  if (result.exitCode === 0 && mayBind && binding.session !== undefined && !(client instanceof Error) && !prebound) {
    try {
      const statusArgs = d.streamStatus?.(binding.session);
      const wsPort = statusArgs === undefined ? undefined : parseStreamPort((await run(statusArgs)).stdout);
      await client.browserSurface({
        provider: d.provider,
        key: flags.key,
        session: binding.session,
        cwd: cwd ?? callerCwd,
        ...(binaryPath ? { binaryPath } : {}),
        ...(wsPort === undefined ? {} : { wsPort }),
        ...(fresh && initialViewport && !explicitDevice ? { initialViewport } : {}),
        ...workspaceParam(flags.workspace),
      });
    } catch (error) {
      result.stderr += `Warning: could not open the Dormouse browser surface: ${errorMessage(error)}\n`;
    }
  }
  return result;
}

function parseEmbedSize(rest: string[]): ParseResult<{ setting?: BrowserViewportRequest['setting']; json: boolean }> {
  const positional: string[] = [];
  let preset: string | undefined;
  let dpr: number | undefined;
  let json = false;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg === '--json') { json = true; continue; }
    if (arg === '--preset' || arg.startsWith('--preset=')) {
      if (preset !== undefined) return { ok: false, message: '--preset may be given only once' };
      preset = arg === '--preset' ? rest[++i] : arg.slice('--preset='.length);
      if (!preset || preset.startsWith('-')) return { ok: false, message: '--preset requires a name' };
      continue;
    }
    if (arg === '--dpr' || arg.startsWith('--dpr=')) {
      if (dpr !== undefined) return { ok: false, message: '--dpr may be given only once' };
      const raw = arg === '--dpr' ? rest[++i] : arg.slice('--dpr='.length);
      dpr = Number(raw);
      if (!raw || !Number.isFinite(dpr) || dpr <= 0 || dpr > 10) return { ok: false, message: '--dpr must be greater than 0 and at most 10' };
      continue;
    }
    if (arg.startsWith('-')) return { ok: false, message: `unknown dor-embed-size option '${arg}'` };
    positional.push(arg);
  }
  if (preset !== undefined && positional.length) return { ok: false, message: 'dimensions and --preset are mutually exclusive' };
  if (preset === 'pane-sync' && dpr !== undefined) return { ok: false, message: '--dpr cannot be used with pane-sync' };
  if (preset !== undefined) return { ok: true, value: { setting: { preset, ...(dpr === undefined ? {} : { dpr }) }, json } };
  if (positional.length === 0) return dpr === undefined
    ? { ok: true, value: { json } }
    : { ok: false, message: '--dpr requires dimensions or --preset' };
  if (positional.length !== 2) return { ok: false, message: 'dor-embed-size requires width and height' };
  if (!positional.every((v) => /^\d+$/.test(v))) return { ok: false, message: 'width and height must be whole CSS pixels' };
  const setting: BrowserViewportSetting = { mode: 'fixed', width: Number(positional[0]), height: Number(positional[1]), ...(dpr === undefined ? {} : { dpr }) };
  if (!isFixedBrowserViewport(setting)) return { ok: false, message: 'width and height must be 1–16384 CSS pixels' };
  return { ok: true, value: { setting, json } };
}

async function runEmbedSize(provider: BrowserAutomationProvider, flags: ResolvedSessionFlags, options: CliOptions): Promise<CliResult> {
  const parsed = parseEmbedSize(flags.rest);
  if (!parsed.ok) return fail(parsed.message);
  const client = requireControlClient(options);
  if (client instanceof Error) return fail(client.message);
  const request = {
    provider,
    ...(flags.key === undefined ? flags.surface === undefined ? { session: flags.session! } : { surface: flags.surface } : { key: flags.key }),
    ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
    ...(parsed.value.setting === undefined ? {} : { setting: parsed.value.setting }),
  } as BrowserViewportRequest;
  try {
    const result = await client.browserViewport(request);
    if (parsed.value.json) return { exitCode: 0, stdout: `${JSON.stringify({
      surface_id: result.surfaceId, surface_ref: result.surfaceRef, provider: result.provider,
      render_mode: result.renderMode, requested: result.requested, actual: result.actual, ready: result.ready,
    })}\n`, stderr: '' };
    const setting = result.requested.mode === 'pane-sync'
      ? 'pane-sync'
      : `fixed ${result.requested.width} × ${result.requested.height} CSS px${result.requested.dpr === undefined ? '' : ` @ ${result.requested.dpr} DPR`}`;
    const actual = result.actual
      ? `${result.actual.width} × ${result.actual.height} CSS px @ ${result.actual.dpr} DPR`
      : 'unavailable';
    return { exitCode: 0, stdout: `${result.surfaceRef} ${provider} ${result.renderMode}: ${setting} (${result.ready ? 'ready' : 'not ready'}; actual ${actual})\n`, stderr: '' };
  } catch (error) {
    return fail(errorMessage(error));
  }
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
): Promise<ParseResult<ResolveBrowserResponse>> {
  if (flags.session !== undefined) return { ok: true, value: { binding: { session: flags.session } } };
  if (client instanceof Error) {
    return flags.key === undefined
      ? { ok: false, message: client.message }
      : { ok: true, value: { binding: { session: sessionForKey(flags.key) } } };
  }
  try {
    const response = await client.resolveBrowser({
      provider: d.provider,
      ...(flags.key === undefined ? { surface: flags.surface } : { key: flags.key, ...(proposed ? { proposed } : {}) }),
      ...workspaceParam(flags.workspace),
    });
    return { ok: true, value: response };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}
