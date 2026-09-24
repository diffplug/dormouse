/**
 * The one browser-automation host behind every webview
 * (docs/specs/dor-browser.md → "Agent-Browser Host Capabilities"), shared by
 * the VS Code extension host and the standalone sidecar. Every request arrives
 * as one provider-tagged `BrowserRequest`, is validated here once — the
 * security boundary for both providers — and only then reaches the provider
 * that runs it.
 */
import * as path from 'path';
import { isBrowserProvider, type BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import { messageOf } from '../lib/errors';
import {
  isBrowsableUrl,
  type BrowserOp,
  type BrowserRequest,
  type BrowserRequestBinding,
  type BrowserResult,
} from '../lib/platform/browser-automation';
import { createAgentBrowserHost } from './agent-browser-host';
import { captureFormat, editScript, isAgentBrowserSession, isPlaywrightSession, jpegQuality } from './browser-host-shared';
import type { createPlaywrightHost } from './playwright-host';

type PlaywrightHost = ReturnType<typeof createPlaywrightHost>;

export interface BrowserHostDeps {
  /** Write text to the OS clipboard (copy/cut land here). VS Code passes
   *  `vscode.env.clipboard.writeText`; the sidecar shells out (pbcopy/clip/…). */
  writeClipboardText(text: string): void | Promise<void>;
  log?(message: string): void;
  /** agent-browser's stream URL for a port. VS Code relays it, since the
   *  daemon refuses its webview's origin; absent, the webview dials the port
   *  directly. */
  agentBrowserStreamUrl?(port: number): Promise<string>;
  /** The Playwright host, made on its first request: its bundle carries `ws`,
   *  and most sessions never open a Playwright pane. */
  playwright(): PlaywrightHost;
}

/** Each provider's session charset — the name lands on its CLI's command
 *  line and, for agent-browser, in a socket-directory path. */
const SESSION_NAME: Record<BrowserAutomationProvider, (value: unknown) => value is string> = {
  'agent-browser': isAgentBrowserSession,
  playwright: isPlaywrightSession,
};

const TAB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// agent-browser's own `tab` verbs, which a tab id rendered after `tab` would run.
const TAB_VERBS = new Set(['new', 'close', 'list']);
const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ()._-]{0,63}$/;

function dimension(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

/**
 * `raw`, as a request the providers may run, or why it may not. The request
 * arrives from webview IPC unvalidated, so the result is rebuilt field by
 * field: a provider renders its own argv or client call from these values, and
 * no caller token reaches a CLI as it came — agent-browser reads launch
 * options anywhere on its command line (rationale in docs/specs/dor-browser.md
 * → "Agent-Browser Host Capabilities").
 */
export function parseBrowserRequest(raw: unknown): BrowserRequest | string {
  if (!raw || typeof raw !== 'object') return 'invalid browser request';
  const r = raw as Record<string, unknown>;
  const provider = r.provider;
  if (!isBrowserProvider(provider)) return 'unknown browser provider';
  const given = (r.binding && typeof r.binding === 'object' ? r.binding : {}) as Record<string, unknown>;
  const binding: BrowserRequestBinding = {};
  if (given.session !== undefined) {
    if (!SESSION_NAME[provider](given.session)) return 'a valid session name is required';
    binding.session = given.session;
  }
  if (typeof given.cwd === 'string' && path.isAbsolute(given.cwd)) binding.cwd = given.cwd;
  // Checked against the provider's allowlist where it is spawned.
  if (typeof given.binaryPath === 'string') binding.binaryPath = given.binaryPath;
  const op = parseOp(r);
  if (typeof op === 'string') return op;
  if (op.op === 'launch') {
    // A new session opens where it was asked; a relaunch only carries its page
    // along, reopening blank on one it may not navigate to.
    if (binding.session === undefined && !isBrowsableUrl(op.url)) return 'Browser navigation requires an http(s) URL';
  } else if (op.op !== 'streamUrl' && binding.session === undefined) {
    return 'a valid session name is required';
  }
  if (op.op === 'cdpUrl' && provider !== 'agent-browser') return `${provider} has no cdpUrl operation`;
  return { provider, binding, ...op };
}

function parseOp(r: Record<string, unknown>): BrowserOp | string {
  switch (r.op) {
    case 'launch':
      return { op: 'launch', ...(isBrowsableUrl(r.url) ? { url: r.url } : {}), headed: r.headed === true };
    case 'attach':
      return { op: 'attach', ...(isBrowsableUrl(r.url) ? { url: r.url } : {}), headed: r.headed === true };
    case 'streamUrl': {
      const port = r.port;
      return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? { op: 'streamUrl', port } : 'a stream port is required';
    }
    case 'screenshot':
      return { op: 'screenshot', format: captureFormat(r.format), quality: jpegQuality(r.quality) };
    case 'edit':
      return editScript(r.edit) !== undefined ? { op: 'edit', edit: r.edit as 'selectAll' | 'copy' | 'cut' } : `unknown edit op '${String(r.edit)}'`;
    case 'navigate':
      return isBrowsableUrl(r.url) ? { op: 'navigate', url: r.url } : 'Browser navigation requires an http(s) URL';
    case 'history':
      return r.dir === 'back' || r.dir === 'forward' || r.dir === 'reload' ? { op: 'history', dir: r.dir } : 'unknown history direction';
    case 'tab': {
      const { action, tabId } = r;
      if ((action !== 'select' && action !== 'close') || typeof tabId !== 'string' || !TAB_ID.test(tabId) || TAB_VERBS.has(tabId)) return 'invalid tab operation';
      return { op: 'tab', action, tabId };
    }
    case 'viewport': {
      const [width, height, dpr] = [dimension(r.width, 16384), dimension(r.height, 16384), dimension(r.dpr, 10)];
      return width && height && dpr ? { op: 'viewport', width, height, dpr } : 'invalid viewport';
    }
    case 'device':
      return typeof r.name === 'string' && DEVICE_NAME.test(r.name) ? { op: 'device', name: r.name } : 'invalid device name';
    case 'cdpUrl':
    case 'close':
      return { op: r.op };
    default:
      return `unsupported browser operation '${String(r.op)}'`;
  }
}

/** Screenshots answer with their bytes, or — to the sidecar, whose Rust
 *  caller reads the file itself — with the private file holding them. */
type Transport = 'bytes' | 'file';

export function createBrowserHost(deps: BrowserHostDeps) {
  const agentBrowser = createAgentBrowserHost(deps);
  let playwright: PlaywrightHost | undefined;

  async function agentBrowserRequest(r: BrowserRequest, transport: Transport): Promise<BrowserResult> {
    const { binaryPath } = r.binding;
    if (r.op === 'streamUrl') {
      return { ok: true, url: deps.agentBrowserStreamUrl ? await deps.agentBrowserStreamUrl(r.port) : `ws://127.0.0.1:${r.port}` };
    }
    if (r.op === 'launch' && r.binding.session === undefined) {
      const opened = await agentBrowser.open(r.url!, { headed: r.headed }, binaryPath);
      return opened.ok ? { ...opened, nativeIdentity: opened.session } : opened;
    }
    // Validation guarantees every other request names its session.
    const session = r.binding.session!;
    switch (r.op) {
      case 'launch':
      case 'attach': {
        const answer = r.op === 'attach'
          ? await agentBrowser.attach(session, { url: r.url, headed: r.headed }, binaryPath)
          : await (r.headed ? agentBrowser.popOut : agentBrowser.popIn)(session, { url: r.url }, binaryPath);
        // agent-browser's native identity is its session: one socket directory.
        return answer.ok ? { ...answer, session, nativeIdentity: session } : answer;
      }
      case 'screenshot': {
        if (transport === 'bytes') return agentBrowser.screenshot(session, r, binaryPath);
        const shot = await agentBrowser.screenshotToFile(session, r, binaryPath);
        return shot.ok ? { ok: true, path: shot.path, mime: shot.mime } : shot;
      }
      case 'edit':
        return agentBrowser.edit(session, r.edit, binaryPath);
      default:
        return agentBrowser.act(session, r, binaryPath);
    }
  }

  async function run(raw: unknown, transport: Transport): Promise<BrowserResult> {
    const r = parseBrowserRequest(raw);
    if (typeof r === 'string') return { ok: false, error: r };
    try {
      if (r.provider === 'agent-browser') return await agentBrowserRequest(r, transport);
      playwright ??= deps.playwright();
      return await (transport === 'file' ? playwright.requestFile(r) : playwright.request(r));
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  return {
    /** One request from the webview; a screenshot answers with its bytes. */
    request: (raw: unknown) => run(raw, 'bytes'),
    /** The same, but a screenshot answers with a private file's path. */
    requestFile: (raw: unknown) => run(raw, 'file'),
    /** Shutdown: close every headed window and drop the capture directories. */
    close: async () => {
      await Promise.all([agentBrowser.closePoppedOut(), playwright?.close()]);
    },
  };
}

export type BrowserHost = ReturnType<typeof createBrowserHost>;
