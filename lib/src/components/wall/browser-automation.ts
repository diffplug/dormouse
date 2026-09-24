/**
 * The GUI half of the browser-provider registry (docs/specs/dor-browser.md →
 * "Providers") — what `dor` and the hosts need too (CLI, render modes,
 * binaries) lives in `dor-lib-common/src/browser-providers.ts` — and the
 * webview's handle on the host's one browser request.
 */
import {
  BROWSER_PROVIDER_IDS,
  BROWSER_PROVIDERS,
  parseRenderMode,
  renderModeFor,
  type BrowserAutomationProvider,
} from 'dor-lib-common/browser-providers';
import { getPlatform } from '../../lib/platform';
import {
  type BrowserEditOp,
  type BrowserOp,
  type BrowserRequest,
  type BrowserRequestBinding,
  type BrowserResult,
} from '../../lib/platform/browser-automation';
import { isAllowedBinaryFor } from '../../lib/agent-browser-binary';
import { messageOf } from '../../lib/errors';
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

function gui(provider: BrowserAutomationProvider, fields: { devices: readonly string[]; viewportVerb: string }): BrowserProviderGui {
  const cli = `dor ${BROWSER_PROVIDERS[provider].alias}`;
  return { label: BROWSER_PROVIDERS[provider].label, cli, devices: fields.devices, viewportHint: `${cli} ${fields.viewportVerb} …` };
}

export const BROWSER_PROVIDER_GUI: Record<BrowserAutomationProvider, BrowserProviderGui> = {
  'agent-browser': gui('agent-browser', {
    // Touch and the mobile UA come only bundled inside `set device` (verified
    // against 0.27.0).
    devices: ['iPhone 15', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 17', 'iPad', 'iPad Pro', 'Pixel 9', 'Galaxy S25'],
    viewportVerb: 'set',
  }),
  playwright: gui('playwright', {
    devices: ['iPhone 15', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 17', 'iPad (gen 11)', 'iPad Pro 11', 'Pixel 9', 'Galaxy S24'],
    viewportVerb: 'resize',
  }),
};

/** Why a GUI entry point cannot open `provider`'s browser here. */
export function providerUnavailable(provider: BrowserAutomationProvider): string {
  return `${BROWSER_PROVIDERS[provider].label} is unavailable on this host`;
}

/** The render mode showing `provider`'s browser headed or in the pane. */
export function headedRenderMode(provider: BrowserAutomationProvider, headed: boolean): RenderMode {
  return renderModeFor(provider, headed ? 'popout' : 'screencast');
}

/** Whether `mode` shows its browser as its own headed window. */
export function isHeadedMode(mode: unknown): boolean {
  return parseRenderMode(mode).presentation === 'popout';
}

/** The provider an automated browser Surface drives; an unset mode (a direct
 *  mount in tests) is agent-browser. */
export function surfaceProvider(mode: unknown): BrowserAutomationProvider {
  return parseRenderMode(mode).provider ?? 'agent-browser';
}

/** Whether this host can drive `provider`'s browsers. */
export function hostSupportsBrowser(provider: BrowserAutomationProvider): boolean {
  const platform = getPlatform();
  return !!platform.browser && !!platform.browserProviders?.includes(provider);
}

/** The providers this host can launch a browser with. */
export function hostBrowserProviders(): BrowserAutomationProvider[] {
  return BROWSER_PROVIDER_IDS.filter(hostSupportsBrowser);
}

/**
 * The render modes a browser Surface can take on this host — what its Display
 * modal offers (docs/specs/dor-browser.md → "Display Modal And Render Swaps").
 * A provider needs a host that can drive it, unless it is the one `current`
 * already runs, which keeps its screencast. `iframe` is always available. A
 * Tool takes only its declarable renders (docs/specs/dor-tool.md → Declaring
 * tools).
 */
export function offeredRenderModes(isTool: boolean, current: BrowserAutomationProvider | null): RenderMode[] {
  const modes: RenderMode[] = [];
  for (const provider of BROWSER_PROVIDER_IDS) {
    const hosted = hostSupportsBrowser(provider);
    if (!hosted && provider !== current) continue;
    modes.push(renderModeFor(provider, 'screencast'));
    if (hosted) modes.push(renderModeFor(provider, 'popout'));
  }
  modes.push('iframe');
  return isTool ? modes.filter(isToolRender) : modes;
}

/**
 * One provider's browser, as the webview drives it: typed operations on the
 * host's one `browser` request (docs/specs/dor-browser.md → "Browser Host").
 * A request that cannot reach the host answers `{ ok: false }`
 * rather than rejecting.
 */
export interface BrowserHandle {
  readonly provider: BrowserAutomationProvider;
  launch(url: string | undefined, headed: boolean, requestId?: string): Promise<BrowserResult>;
  attach(opts?: { url?: string; headed?: boolean; requestId?: string }): Promise<BrowserResult>;
  /** A viewer socket URL on the browser at `stream`. */
  view(stream: number, opts: { headed: boolean; debug: boolean }): Promise<BrowserResult>;
  edit(edit: BrowserEditOp): Promise<BrowserResult>;
  navigate(url: string): Promise<BrowserResult>;
  history(dir: 'back' | 'forward' | 'reload'): Promise<BrowserResult>;
  tab(action: 'select' | 'close', tabId: string): Promise<BrowserResult>;
  viewport(width: number, height: number, dpr: number, endsSync?: string): Promise<BrowserResult>;
  device(name: string, endsSync?: string): Promise<BrowserResult>;
  /** `cancels`: the closing Surface's own requests still unanswered. */
  close(cancels?: readonly string[]): Promise<BrowserResult>;
}

/**
 * `provider`'s browser bound to `binding`, or null where this host cannot
 * drive it. `binaryPath` names a program the host will spawn and may come off
 * the persisted session blob, so a path the provider's gate refuses is dropped
 * here, before it is ever sent (`lib/src/lib/agent-browser-binary.ts`); the host
 * then resolves its own.
 */
export function browserHandle(provider: BrowserAutomationProvider, binding: Omit<BrowserRequestBinding, 'binaryPath'> & { binaryPath?: unknown }): BrowserHandle | null {
  if (!hostSupportsBrowser(provider)) return null;
  const platform = getPlatform();
  const sent: BrowserRequestBinding = {
    ...(binding.session !== undefined ? { session: binding.session } : {}),
    ...(binding.cwd !== undefined ? { cwd: binding.cwd } : {}),
    ...(isAllowedBinaryFor(provider, binding.binaryPath) ? { binaryPath: binding.binaryPath } : {}),
  };
  const send = (op: BrowserOp): Promise<BrowserResult> => {
    let answer: Promise<BrowserResult>;
    try {
      answer = platform.browser!({ provider, binding: sent, ...op } as BrowserRequest);
    } catch (error) {
      answer = Promise.reject(error);
    }
    return answer.then(
      (result) => result ?? { ok: false, error: 'no answer from the browser host' },
      (error: unknown) => ({ ok: false, error: messageOf(error) }),
    );
  };
  return {
    provider,
    launch: (url, headed, requestId) => send({ op: 'launch', ...(url !== undefined ? { url } : {}), headed, ...(requestId !== undefined ? { requestId } : {}) }),
    attach: (opts = {}) => send({ op: 'attach', ...opts }),
    view: (stream, { headed, debug }) => send({ op: 'view', stream, ...(headed ? { headed } : {}), ...(debug ? { debug } : {}) }),
    edit: (edit) => send({ op: 'edit', edit }),
    navigate: (url) => send({ op: 'navigate', url }),
    history: (dir) => send({ op: 'history', dir }),
    tab: (action, tabId) => send({ op: 'tab', action, tabId }),
    viewport: (width, height, dpr, endsSync) => send({ op: 'viewport', width, height, dpr, ...(endsSync !== undefined ? { endsSync } : {}) }),
    device: (name, endsSync) => send({ op: 'device', name, ...(endsSync !== undefined ? { endsSync } : {}) }),
    close: (cancels = []) => send({ op: 'close', ...(cancels.length ? { cancels: [...cancels] } : {}) }),
  };
}

// The binary path each provider's `dor` command last resolved on a terminal's
// PATH, one per webview (its Walls share one host).
const lastBinaryPaths = new Map<BrowserAutomationProvider, string>();

/**
 * The binary path a GUI launch of `provider` passes: the one its `dor` command
 * last resolved on a terminal's PATH, since the webview/host PATH may not find
 * the binary itself.
 */
export function launchBinaryPath(provider: BrowserAutomationProvider): string | undefined {
  return lastBinaryPaths.get(provider);
}

/** Record the binary path a `provider` session resolved or launched with. */
export function rememberLaunchBinaryPath(provider: BrowserAutomationProvider, binaryPath: string | undefined): void {
  if (binaryPath) lastBinaryPaths.set(provider, binaryPath);
}

/** For tests: the memo outlives the Wall that filled it. */
export function forgetLaunchBinaryPaths(): void {
  lastBinaryPaths.clear();
}
