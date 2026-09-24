/**
 * The GUI half of the browser-provider registry (docs/specs/dor-browser.md →
 * "Providers"), beside provider adaptation beneath the shared automated-browser
 * viewer. What `dor` and the hosts need too — CLI, render modes, binaries —
 * lives in `dor-lib-common/src/browser-providers.ts`.
 */
import {
  BROWSER_PROVIDER_IDS,
  BROWSER_PROVIDERS,
  parseRenderMode,
  renderModeFor,
  type BrowserAutomationProvider,
} from 'dor-lib-common/browser-providers';
import { getPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import type { PlaywrightRequest } from '../../lib/platform/browser-automation';
import { isToolRender } from '../../lib/platform/tool-types';
import type { RenderMode } from './agent-browser-screen';

interface BrowserProviderGui {
  /** The provider's name in user-facing text. */
  label: string;
  /** The `dor` command that drives it. */
  cli: string;
  /** The device presets its `set device` accepts, as the Display modal lists
   *  them — the CLI's own registry, no custom descriptors. */
  devices: readonly string[];
  /** What to run from a terminal to size the viewport on a host that cannot. */
  viewportHint: string;
}

export const BROWSER_PROVIDER_GUI: Record<BrowserAutomationProvider, BrowserProviderGui> = {
  'agent-browser': {
    label: 'agent-browser',
    cli: `dor ${BROWSER_PROVIDERS['agent-browser'].alias}`,
    // Touch and the mobile UA come only bundled inside `set device` (verified
    // against 0.27.0).
    devices: ['iPhone 15', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 17', 'iPad', 'iPad Pro', 'Pixel 9', 'Galaxy S25'],
    viewportHint: 'dor ab set …',
  },
  playwright: {
    label: 'Playwright',
    cli: `dor ${BROWSER_PROVIDERS.playwright.alias}`,
    devices: ['iPhone 15', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 17', 'iPad (gen 11)', 'iPad Pro 11', 'Pixel 9', 'Galaxy S24'],
    viewportHint: 'dor pw resize …',
  },
};

/** The provider an automated browser Surface drives; an unset mode (a direct
 *  mount in tests) is agent-browser. */
export function surfaceProvider(mode: unknown): BrowserAutomationProvider {
  return parseRenderMode(mode).provider ?? 'agent-browser';
}

/** The providers this host can launch a browser with. */
export function hostBrowserProviders(): BrowserAutomationProvider[] {
  return BROWSER_PROVIDER_IDS.filter((provider) => !!browserPlatform(provider).agentBrowserOpen);
}

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
  for (const provider of BROWSER_PROVIDER_IDS) {
    const platform = browserPlatform(provider);
    if (provider !== current && !platform.agentBrowserOpen) continue;
    modes.push(renderModeFor(provider, 'screencast'));
    if (platform.agentBrowserPopOut) modes.push(renderModeFor(provider, 'popout'));
  }
  modes.push('iframe');
  return isTool ? modes.filter(isToolRender) : modes;
}

export type BrowserPlatform = Pick<PlatformAdapter,
  | 'agentBrowserCommand' | 'agentBrowserEdit' | 'agentBrowserScreenshot'
  | 'agentBrowserAttach' | 'getAgentBrowserStreamUrl' | 'agentBrowserOpen'
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
    agentBrowserAttach: (session: string, opts: { url?: string; headed?: boolean }, binaryPath?: string) => call({ op: 'attach', session, ...opts, binaryPath }),
    getAgentBrowserStreamUrl: async (port: number) => {
      const r = await call({ op: 'streamUrl', port });
      if (!r.ok || !r.url) throw new Error(r.error ?? 'Playwright stream unavailable');
      return r.url;
    },
    agentBrowserOpen: (url: string, opts: { headed?: boolean; session?: string }, binaryPath?: string) => call({ op: 'open', url, ...opts, binaryPath }),
    agentBrowserPopOut: (session: string, opts: { url?: string }, binaryPath?: string) => call({ op: 'popOut', session, ...opts, binaryPath }),
    agentBrowserPopIn: (session: string, opts: { url?: string }, binaryPath?: string) => call({ op: 'popIn', session, ...opts, binaryPath }),
  };
}

// The binary path a `dor ab` surface last resolved on a terminal's PATH, one per
// webview (its Walls share one host).
let lastAgentBrowserBinaryPath: string | undefined;

/**
 * The binary path a GUI launch of `provider` passes: the one a `dor ab`
 * surface last resolved on a terminal's PATH, since the webview/host PATH may
 * not find the binary itself. Agent-browser only: the Playwright host resolves
 * its own installation on every launch.
 */
export function launchBinaryPath(provider: BrowserAutomationProvider): string | undefined {
  return provider === 'agent-browser' ? lastAgentBrowserBinaryPath : undefined;
}

/** Record the binary path a `provider` session resolved or launched with. */
export function rememberLaunchBinaryPath(provider: BrowserAutomationProvider, binaryPath: string | undefined): void {
  if (binaryPath && provider === 'agent-browser') lastAgentBrowserBinaryPath = binaryPath;
}

/** For tests: the memo outlives the Wall that filled it. */
export function forgetLaunchBinaryPaths(): void {
  lastAgentBrowserBinaryPath = undefined;
}
