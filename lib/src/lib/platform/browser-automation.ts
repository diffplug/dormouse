/**
 * The one webview → host channel for browser automation
 * (docs/specs/dor-browser.md → "Browser Host"): a typed,
 * provider-tagged request the host validates once and turns into fixed
 * operations — no CLI argv, script or CDP method crosses it.
 */
import type { BrowserAutomationProvider } from 'dor-lib-common/browser-providers';

export type { BrowserAutomationProvider };

/** What a request names its browser by: the provider's native session, the
 *  directory its CLI runs in, and the executable. Only a `launch` may omit the
 *  session, and the host then mints one. */
export interface BrowserRequestBinding {
  session?: string;
  cwd?: string;
  binaryPath?: string;
}

/** A native editing operation the stream's input path cannot dispatch
 *  (CDP drops the `commands` field on macOS). The host owns the script for
 *  each; the webview only names one. */
export type BrowserEditOp = 'selectAll' | 'copy' | 'cut';

/** One operation on a provider's browser. */
export type BrowserOp =
  /** Open `url` — blank when it is not http(s) — in a new session, or
   *  relaunch the named one there, headed or headless. Answers once the
   *  browser is up, never waiting for the page. */
  | { op: 'launch'; url?: string; headed: boolean }
  /** Where the session streams now, found without starting a browser; one
   *  that is gone relaunches at `url` when the caller names one. */
  | { op: 'attach'; url?: string; headed?: boolean }
  /** The URL the webview connects to for a stream port. */
  | { op: 'streamUrl'; port: number }
  /** One device-resolution frame. */
  | { op: 'screenshot'; format?: 'jpeg' | 'png'; quality?: number }
  | { op: 'edit'; edit: BrowserEditOp }
  | { op: 'navigate'; url: string }
  | { op: 'history'; dir: 'back' | 'forward' | 'reload' }
  | { op: 'tab'; action: 'select' | 'close'; tabId: string }
  | { op: 'viewport'; width: number; height: number; dpr: number }
  | { op: 'device'; name: string }
  /** agent-browser only: the browser's CDP endpoint, for the popped-out URL
   *  observer. */
  | { op: 'cdpUrl' }
  | { op: 'close' };

export type BrowserRequest = { provider: BrowserAutomationProvider; binding: BrowserRequestBinding } & BrowserOp;

export interface BrowserResult {
  ok: boolean;
  error?: string;
  /** `launch` / `attach`: what the browser is bound to — the session (minted
   *  or named), the directory and executable the host ran it with, and the
   *  provider's native identity for it. */
  session?: string;
  cwd?: string;
  binaryPath?: string;
  nativeIdentity?: string;
  /** `launch` / `attach`: the stream port, and whether the browser runs
   *  headed, when the host knows. */
  wsPort?: number;
  headed?: boolean;
  /** `attach`: the session was gone, and the host started a browser at the
   *  caller's `url`, so that page is already open. */
  relaunched?: boolean;
  /** `streamUrl` / `cdpUrl`. */
  url?: string;
  /** `edit`: the text copy/cut placed on the OS clipboard. */
  text?: string;
  /** `screenshot`: the image bytes, or — to the standalone sidecar's caller —
   *  the private file holding them. */
  bytes?: Uint8Array;
  path?: string;
  mime?: string;
}

/** How long the webview waits for any browser request before its transport
 *  gives up. The host bounds a launch to answer inside it, and every transport
 *  waits exactly this long (VS Code's `requestResponse`, the Tauri
 *  `browser_request` command, the browser-dev harness). */
export const BROWSER_REQUEST_TIMEOUT_MS = 40_000;

/** The most characters one Playwright viewer `input_text` message carries. A
 *  paste takes as many messages as it needs, each under the viewer socket's
 *  64 KiB payload cap even when every character JSON-escapes to six bytes. */
export const PLAYWRIGHT_TEXT_INPUT_MAX = 8192;

/**
 * A paste as Playwright viewer messages, each inserted whole by the host (CDP
 * `Input.insertText`): one queued message per `PLAYWRIGHT_TEXT_INPUT_MAX`
 * characters, not a key down and up per character, which a long paste would
 * push past the host's input queue cap. Line endings become `\n`, and a
 * message never ends inside a surrogate pair.
 */
export function playwrightTextInputs(text: string): { type: 'input_text'; text: string }[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const messages: { type: 'input_text'; text: string }[] = [];
  for (let start = 0; start < normalized.length;) {
    let end = Math.min(start + PLAYWRIGHT_TEXT_INPUT_MAX, normalized.length);
    const last = normalized.charCodeAt(end - 1);
    if (end < normalized.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    messages.push({ type: 'input_text', text: normalized.slice(start, end) });
    start = end;
  }
  return messages;
}

/** A URL a browser provider may launch, relaunch or navigate to: http(s) only,
 *  untrimmed. The hosts refuse anything else (`parseBrowserRequest`), so the
 *  webview must never offer one — a relaunch would land on about:blank. */
export function isBrowsableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
