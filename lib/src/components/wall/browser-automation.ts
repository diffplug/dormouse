/** Provider adaptation beneath the shared automated-browser viewer. */
import { getPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import type { BrowserAutomationProvider, PlaywrightRequest } from '../../lib/platform/browser-automation';
import { isToolRender } from '../../lib/platform/tool-types';
import type { RenderMode } from './agent-browser-screen';

/** The automated render modes: which provider drives each, and whether its
 *  browser runs headed (popped out). Every other mode — `iframe`, or an
 *  unknown persisted string — is not automated. */
const AUTOMATION_MODES: Record<Exclude<RenderMode, 'iframe'>, { provider: BrowserAutomationProvider; headed: boolean }> = {
  'ab-screencast': { provider: 'agent-browser', headed: false },
  'ab-popout': { provider: 'agent-browser', headed: true },
  'pw-screencast': { provider: 'playwright', headed: false },
  'pw-popout': { provider: 'playwright', headed: true },
};

export type AutomationRenderMode = keyof typeof AUTOMATION_MODES;

/** Whether `mode` is one of the automated render modes. */
export function isAutomationMode(mode: unknown): mode is AutomationRenderMode {
  // Own keys only: a persisted `renderMode` of `constructor` must not match the prototype.
  return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(AUTOMATION_MODES, mode);
}

/** The provider driving `mode`, or null when it is not automated. */
export function automationProvider(mode: unknown): BrowserAutomationProvider | null {
  return isAutomationMode(mode) ? AUTOMATION_MODES[mode].provider : null;
}

export function isPopout(mode: unknown): boolean {
  return isAutomationMode(mode) && AUTOMATION_MODES[mode].headed;
}

export function isScreencast(mode: unknown): boolean {
  return isAutomationMode(mode) && !AUTOMATION_MODES[mode].headed;
}

/** The `dor` command that drives `provider`'s browsers. */
export function automationCli(provider: BrowserAutomationProvider): 'dor ab' | 'dor pw' {
  return provider === 'playwright' ? 'dor pw' : 'dor ab';
}

export function automationMode(provider: BrowserAutomationProvider, headed: boolean): AutomationRenderMode {
  if (provider === 'playwright') return headed ? 'pw-popout' : 'pw-screencast';
  return headed ? 'ab-popout' : 'ab-screencast';
}

/** Each provider's name in user-facing text. */
export const PROVIDER_LABEL: Record<BrowserAutomationProvider, string> = {
  'agent-browser': 'agent-browser',
  playwright: 'Playwright',
};

/** Both providers, in the order the GUI lists them. */
export const AUTOMATION_PROVIDERS = Object.keys(PROVIDER_LABEL) as BrowserAutomationProvider[];

/**
 * The render modes a browser Surface can take on this host — what its Display
 * modal offers (docs/specs/dor-browser.md → "Display Modal And Render Swaps").
 * A provider needs a host that can launch it, unless it is the one `current`
 * already runs, which relaunches in place; its popout needs one that can also
 * pop out. `iframe` is always available. A Tool takes only its declarable
 * renders (docs/specs/dor-tool.md → Declaring tools).
 */
export function offeredRenderModes(isTool: boolean, current: BrowserAutomationProvider | null): RenderMode[] {
  const modes: RenderMode[] = [];
  for (const provider of AUTOMATION_PROVIDERS) {
    const platform = browserPlatform(provider);
    if (provider !== current && !platform.agentBrowserOpen) continue;
    modes.push(automationMode(provider, false));
    if (platform.agentBrowserPopOut) modes.push(automationMode(provider, true));
  }
  modes.push('iframe');
  return isTool ? modes.filter(isToolRender) : modes;
}

export type BrowserPlatform = Pick<PlatformAdapter,
  | 'agentBrowserCommand' | 'agentBrowserEdit' | 'agentBrowserScreenshot'
  | 'agentBrowserStreamStatus' | 'getAgentBrowserStreamUrl' | 'agentBrowserOpen'
  | 'agentBrowserPopOut' | 'agentBrowserPopIn'
>;

export function browserPlatform(provider: BrowserAutomationProvider, cwd?: string): BrowserPlatform {
  const platform = getPlatform();
  if (provider === 'agent-browser') return platform;
  const invoke = platform.playwright;
  if (!invoke) return {};
  const call = (request: PlaywrightRequest) => invoke.call(platform, { cwd, ...request });
  return {
    agentBrowserCommand: async (session: string, args: string[], binaryPath?: string) => {
      const r = await call({ op: 'command', session, args, binaryPath });
      return { exitCode: r.exitCode ?? (r.ok ? 0 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? r.error ?? '' };
    },
    agentBrowserEdit: (session: string, edit: 'selectAll' | 'copy' | 'cut', binaryPath?: string) => call({ op: 'edit', session, edit, binaryPath }),
    agentBrowserScreenshot: async (session: string, opts: { format?: 'jpeg' | 'png'; quality?: number }, binaryPath?: string) => {
      const r = await call({ op: 'screenshot', session, ...opts, binaryPath });
      // JSON transports materialize Uint8Array as an ordinary array.
      if (r.bytes && !(r.bytes instanceof Uint8Array)) r.bytes = new Uint8Array(r.bytes);
      return r;
    },
    agentBrowserStreamStatus: (session: string, binaryPath?: string) => call({ op: 'streamStatus', session, binaryPath }),
    getAgentBrowserStreamUrl: async (port: number) => {
      const r = await call({ op: 'streamUrl', port });
      if (!r.ok || !r.url) throw new Error(r.error ?? 'Playwright stream unavailable');
      return r.url;
    },
    agentBrowserOpen: (url: string, opts: { headed?: boolean }, binaryPath?: string) => call({ op: 'open', url, ...opts, binaryPath }),
    agentBrowserPopOut: (session: string, opts: { url?: string }, binaryPath?: string) => call({ op: 'popOut', session, ...opts, binaryPath }),
    agentBrowserPopIn: (session: string, opts: { url?: string }, binaryPath?: string) => call({ op: 'popIn', session, ...opts, binaryPath }),
  };
}

/** The key of a session's closed mark (`agent-browser-sessions.ts`). Playwright
 *  session names are unique only within a CLI project scope, so they are keyed
 *  with their cwd. */
export function browserSessionKey(session: string, provider: BrowserAutomationProvider, cwd?: string): string {
  return provider === 'playwright' ? JSON.stringify(['playwright', cwd ?? '', session]) : session;
}

/**
 * The binary path a `dor ab` surface last resolved on a terminal's PATH,
 * re-used to spawn an agent-browser for a GUI launch (an embed swapped up to a
 * screencast, a port opened from the terminal context), since the webview/host
 * PATH may not find the binary itself. Agent-browser only: the Playwright host
 * resolves its own installation on every launch.
 */
export class LaunchBinaryPath {
  private last: string | undefined;

  /** The binary path a GUI launch of `provider` passes. */
  get(provider: BrowserAutomationProvider): string | undefined {
    return provider === 'agent-browser' ? this.last : undefined;
  }

  /** Record the binary path a `provider` session resolved. */
  remember(provider: BrowserAutomationProvider, binaryPath: string | undefined): void {
    if (binaryPath && provider === 'agent-browser') this.last = binaryPath;
  }
}
