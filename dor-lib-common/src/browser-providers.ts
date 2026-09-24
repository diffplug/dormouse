/**
 * The browser-automation providers, as `dor`, the Node hosts and the webview
 * all need them: each one's persisted render modes, its CLI, and what may be
 * spawned as that CLI (docs/specs/dor-browser.md → "Providers"). The GUI half
 * of the registry — labels, device lists — lives in lib
 * (`lib/src/components/wall/browser-automation.ts`).
 *
 * Free of Node dependencies (no `node:path`), so the same module runs in the
 * webview, the Node hosts, and `dor`.
 */

/** A browser-automation provider: whose CLI drives a browser Surface. */
export type BrowserAutomationProvider = 'agent-browser' | 'playwright';

/** Where an automated browser is shown: streamed into the pane, or as its own
 *  headed OS window. */
export type BrowserPresentation = 'screencast' | 'popout';

// The scope a caller with no scope of its own names: `dor` outside Dormouse,
// and the host's GUI sessions. Private: callers build session names through
// sessionForKey, never by hand.
const BARE_WALL_SCOPE = '1';

// A session name becomes a filesystem path (the daemon's socket dir), so both
// halves are held to the charset `dor ab --key` enforces CLI-side: the key
// arrives over the control socket too, from clients that are not `dor`.
const UNSAFE_SESSION_CHARS = /[^A-Za-z0-9._-]/g;

/** Env var that overrides which agent-browser binary to run; shared so `dor ab`
 * and the host key off the same name. */
export const AGENT_BROWSER_BIN_ENV = 'DORMOUSE_AGENT_BROWSER_BIN';

/** Default binary name, resolved on PATH when no override/explicit path is given. */
export const DEFAULT_AGENT_BROWSER_BIN = 'agent-browser';

/** The Playwright provider's counterparts: the `@playwright/cli` override env
 * var and the binary name resolved on PATH. */
export const PLAYWRIGHT_BIN_ENV = 'DORMOUSE_PLAYWRIGHT_BIN';
export const DEFAULT_PLAYWRIGHT_BIN = 'playwright-cli';

/*
 * What may be spawned as a browser provider's CLI (docs/specs/dor-browser.md →
 * "Browser Host").
 *
 * `binaryPath` exists because the GUI host's `PATH` is often the login `PATH`
 * with no nvm/volta shims, so `dor ab` / `dor pw` resolve an absolute path in
 * the user's terminal and hand it along. That makes it an **exec channel**
 * rather than a hint: it crosses the webview boundary, it is persisted into a
 * pane's Lath params, and the host hands it back to `dor pw`, so a compromised
 * webview realm and a hand-edited session file could otherwise choose what the
 * extension host, the Tauri sidecar, or `dor` spawns.
 *
 * The rule is therefore not "trust the caller" but "the caller may only pick
 * the provider's CLI": an absolute path whose file name is that CLI, the
 * operator's own override variable, or the bare name resolved on `PATH`.
 * Everything else is refused and the spawner falls through to its own
 * candidates.
 *
 * The same predicate runs in the webview — which validates persisted params
 * before they are ever sent — in the Node hosts, which validate again at the
 * spawn, and in `dor`.
 */

// The Windows PATH shims npm/vfox install alongside the POSIX executable.
// `spawnAndCapture` routes `.cmd`/`.bat` through cmd.exe (docs/specs/dor-cli.md
// → "Spawning External Binaries"), so those spellings are legitimate targets.
const PLAYWRIGHT_FILENAME_RE = /^playwright-cli(?:\.(?:cmd|bat|exe|com|ps1))?$/i;
const AGENT_BROWSER_FILENAME_RE = /^agent-browser(?:\.(?:cmd|bat|exe|com|ps1))?$/i;

// POSIX absolute, Windows drive-absolute, or a UNC share. A relative path is
// refused outright: it would resolve against the spawner's cwd, which the
// caller does not know and must not be able to aim at.
const ABSOLUTE_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * True when `candidate` may be spawned as agent-browser.
 *
 * `configuredPath` is the spawner's own `DORMOUSE_AGENT_BROWSER_BIN`, accepted
 * by exact match because the operator chose it deliberately; pass `undefined`
 * in the webview, which cannot read the host's environment.
 */
export function isAllowedAgentBrowserBinary(
  candidate: unknown,
  configuredPath?: string,
): candidate is string {
  return isAllowedBrowserBinary(candidate, configuredPath, DEFAULT_AGENT_BROWSER_BIN, AGENT_BROWSER_FILENAME_RE);
}

/** The same executable gate for the parallel Playwright provider, whose
 *  override is `DORMOUSE_PLAYWRIGHT_BIN`. */
export function isAllowedPlaywrightBinary(candidate: unknown, configuredPath?: string): candidate is string {
  return isAllowedBrowserBinary(candidate, configuredPath, DEFAULT_PLAYWRIGHT_BIN, PLAYWRIGHT_FILENAME_RE);
}

function isAllowedBrowserBinary(candidate: unknown, configuredPath: string | undefined, name: string, filename: RegExp): candidate is string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4096) return false;
  // Control characters have no place in a path and are how one argument
  // becomes two on the platforms that take a command string.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;
  if (configuredPath && candidate === configuredPath) return true;
  if (candidate === name) return true;
  if (!ABSOLUTE_RE.test(candidate)) return false;
  const segments = candidate.split(/[\\/]/);
  if (segments.includes('..')) return false;
  return filename.test(segments[segments.length - 1] ?? '');
}

/** What a provider's CLI command runs with: its native session, the project
 *  directory it runs in, and the executable. */
export interface BrowserBinding {
  session: string;
  cwd?: string;
  binaryPath?: string;
}

/** An agent-browser session name. `dor ab --session` passes a user's raw name
 *  through, so anything goes but what agent-browser would read as an option or
 *  its socket directory as a path: the name lands after `--session` and in
 *  `<socket dir>/<session>.pid`, whose pid a relaunch signals. */
function isAgentBrowserSession(value: unknown): value is string {
  return typeof value === 'string' && /^(?!-)[^/\\\x00-\x1f\x7f]{1,200}$/.test(value);
}

/** A Playwright session name: Dormouse mints these, and the CLI takes them
 *  as `--session=<name>`, so a strict charset costs nothing. */
function isPlaywrightSession(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value);
}

/** One provider's row. The provider's id is also its long `dor` command;
 *  `alias` is its short one and the prefix of its render modes; `modes` are the
 *  persisted `renderMode` strings, which are also the public `render_mode` and
 *  `dormouse.yml` `render` values. */
interface BrowserProviderSpec {
  /** The provider's name in user-facing text. */
  label: string;
  alias: string;
  modes: Readonly<Record<BrowserPresentation, string>>;
  /** The CLI's session flag, as argv. */
  sessionArgs(session: string): string[];
  /** A session name the CLI reads as neither an option nor a path. */
  isSessionName(value: unknown): value is string;
  binEnv: string;
  defaultBin: string;
  installHint: string;
  isAllowedBinary(candidate: unknown, configuredPath?: string): candidate is string;
}

export const BROWSER_PROVIDERS = {
  'agent-browser': {
    label: 'agent-browser',
    alias: 'ab',
    modes: { screencast: 'ab-screencast', popout: 'ab-popout' },
    sessionArgs: (session: string) => ['--session', session],
    isSessionName: isAgentBrowserSession,
    binEnv: AGENT_BROWSER_BIN_ENV,
    defaultBin: DEFAULT_AGENT_BROWSER_BIN,
    installHint: 'npm i -g agent-browser',
    isAllowedBinary: isAllowedAgentBrowserBinary,
  },
  playwright: {
    label: 'Playwright',
    alias: 'pw',
    modes: { screencast: 'pw-screencast', popout: 'pw-popout' },
    sessionArgs: (session: string) => [`--session=${session}`],
    isSessionName: isPlaywrightSession,
    binEnv: PLAYWRIGHT_BIN_ENV,
    defaultBin: DEFAULT_PLAYWRIGHT_BIN,
    installHint: 'npm i -g @playwright/cli',
    isAllowedBinary: isAllowedPlaywrightBinary,
  },
} as const satisfies Record<BrowserAutomationProvider, BrowserProviderSpec>;

/** Every provider, in the order the GUI lists them. */
export const BROWSER_PROVIDER_IDS = Object.keys(BROWSER_PROVIDERS) as BrowserAutomationProvider[];

/** An automated render mode: a provider's screencast or popout. */
export type AutomatedRenderMode = (typeof BROWSER_PROVIDERS)[BrowserAutomationProvider]['modes'][BrowserPresentation];

/** Every render mode a browser Surface can take; `iframe` is the embed. */
export type SurfaceRenderMode = 'iframe' | AutomatedRenderMode;

/** A render mode decoded: its provider and presentation, or the embed. */
export type ParsedRenderMode =
  | { provider: BrowserAutomationProvider; presentation: BrowserPresentation; mode: AutomatedRenderMode }
  | { provider: null; presentation: 'iframe'; mode: 'iframe' };

const PARSED_MODES = new Map<string, ParsedRenderMode>(BROWSER_PROVIDER_IDS.flatMap((provider) =>
  (Object.keys(BROWSER_PROVIDERS[provider].modes) as BrowserPresentation[]).map((presentation) => {
    const mode = BROWSER_PROVIDERS[provider].modes[presentation];
    return [mode, { provider, presentation, mode }] as const;
  })));
const EMBED: ParsedRenderMode = { provider: null, presentation: 'iframe', mode: 'iframe' };

/** Decode a render mode. Anything but an automated mode — `iframe`, an absent
 *  one, or an unknown persisted string — is the embed. */
export function parseRenderMode(mode: unknown): ParsedRenderMode {
  return (typeof mode === 'string' && PARSED_MODES.get(mode)) || EMBED;
}

/** The render mode showing `provider`'s browser as `presentation`. */
export function renderModeFor(provider: BrowserAutomationProvider, presentation: BrowserPresentation): AutomatedRenderMode {
  return BROWSER_PROVIDERS[provider].modes[presentation];
}

/** Whether `value` names a provider. */
export function isBrowserProvider(value: unknown): value is BrowserAutomationProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BROWSER_PROVIDERS, value);
}

/**
 * Managed, scoped browser session name, `dormouse.<scope>.<key>`, for either
 * provider: the host passes the Workspace's id, or the scope a bare Wall mints
 * for itself; `dormouse.1.<key>` is what a caller with no host — `dor` outside
 * Dormouse — names. The scope is what keeps one `--key default` per Workspace
 * from being one shared browser (`docs/specs/dor-browser.md` → Managed
 * identity).
 *
 * agent-browser session names become filesystem paths (the socket dir), so `/`
 * can't separate the namespace — the daemon fails to start; dots keep it
 * readable. Shared by `dor` (--key outside Dormouse) and the lib host (key
 * and GUI sessions).
 */
export function sessionForKey(key: string, workspaceId?: string): string {
  const scope = workspaceId ? workspaceId.replace(UNSAFE_SESSION_CHARS, '-') : BARE_WALL_SCOPE;
  return `dormouse.${scope}.${key.replace(UNSAFE_SESSION_CHARS, '-')}`;
}
