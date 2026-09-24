/** Host-owned operations for the Playwright provider. No arbitrary code or CDP crosses this boundary. */
export type { BrowserAutomationProvider } from 'dor/commands/types';
export type PlaywrightRequest = { binaryPath?: string; cwd?: string } & (
  | { op: 'open'; url: string; headed?: boolean; session?: string }
  | { op: 'streamUrl'; port: number }
  | { op: 'command'; session: string; args: string[] }
  | { op: 'edit'; session: string; edit: 'selectAll' | 'copy' | 'cut' }
  | { op: 'screenshot'; session: string; format?: 'jpeg' | 'png'; quality?: number }
  | { op: 'attach'; session: string; url?: string; headed?: boolean }
  | { op: 'popOut' | 'popIn'; session: string; url?: string }
);
export interface PlaywrightResult {
  headed?: boolean;
  nativeIdentity?: string;
  ok: boolean;
  error?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  text?: string;
  session?: string;
  cwd?: string;
  binaryPath?: string;
  wsPort?: number;
  /** `attach` only: see `AgentBrowserAttachResult`. */
  relaunched?: boolean;
  url?: string;
  bytes?: Uint8Array;
  path?: string;
  mime?: string;
}

/** How long the webview waits for any Playwright host request before its
 *  transport gives up. The host bounds a GUI launch to answer inside it, and
 *  every transport waits exactly this long (VS Code's `requestResponse`, the
 *  Tauri `playwright_request` command, the browser-dev harness). */
export const PLAYWRIGHT_REQUEST_TIMEOUT_MS = 40_000;

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
 *  untrimmed. The hosts refuse anything else (`parseWebviewCommand`), so the
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
