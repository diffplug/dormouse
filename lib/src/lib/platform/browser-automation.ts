/**
 * The one webview → host channel for browser automation
 * (docs/specs/dor-browser.md → "Browser Host"): a typed,
 * provider-tagged request the host validates once and turns into fixed
 * operations — no CLI argv, script or CDP method crosses it.
 */
import type { BrowserAutomationProvider, BrowserBinding } from 'dor-lib-common/browser-providers';
import type { BrowserViewportSetting } from 'dor-lib-common/browser-viewports';
import type { AgentBrowserTab } from '../agent-browser-tab';

export type { BrowserAutomationProvider };
export { BROWSER_REQUEST_TIMEOUT_MS } from 'dor-lib-common/browser-providers';

/** What a request names its browser by. Only a `launch` may omit the session,
 *  and the host then mints one. */
export type BrowserRequestBinding = Partial<BrowserBinding>;

/** A native editing operation the stream's input path cannot dispatch
 *  (CDP drops the `commands` field on macOS). The host owns the script for
 *  each; the webview only names one. */
export type BrowserEditOp = 'selectAll' | 'copy' | 'cut';

/** One operation on a provider's browser. */
export type BrowserOp =
  /** Open `url` — blank when it is not http(s) — in a new session, or in the
   *  named one: navigating it when it is up in the mode asked for, else
   *  relaunching it headed or headless. Answers once the browser is up, never
   *  waiting for the page. */
  | { op: 'launch'; url?: string; headed: boolean; requestId?: string; initialViewport?: BrowserViewportSetting }
  /** Where the session streams now, found without starting a browser; one
   *  that is gone relaunches at `url` when the caller names one. */
  | { op: 'attach'; url?: string; headed?: boolean; requestId?: string; initialViewport?: BrowserViewportSetting }
  /** A single-use URL for one viewer socket on the browser at `stream` (what
   *  a launch or attach answered): its frames, state and input. `headed`: the
   *  Surface shows it as its own window, so no frame is sent. `debug` logs the
   *  socket's rates host-side. */
  | { op: 'view'; stream: number; headed?: boolean; debug?: boolean }
  | { op: 'edit'; edit: BrowserEditOp }
  | { op: 'navigate'; url: string }
  | { op: 'history'; dir: 'back' | 'forward' | 'reload' }
  | { op: 'tab'; action: 'select' | 'close'; tabId: string }
  /** `endsSync` cancels this pane's engagement even before its first socket
   *  intent reaches the host. */
  | { op: 'viewport'; width: number; height: number; dpr?: number; endsSync?: string }
  | { op: 'device'; name: string; endsSync?: string }
  /** Read the active page's CSS viewport and effective device pixel ratio. */
  | { op: 'measure' }
  /** Close the session — after the launch or attach of it running now — and
   *  cancel `cancels`: requests the closing Surface sent that can bring the
   *  browser up, by their `requestId`, however late the transport delivers
   *  them. */
  | { op: 'close'; cancels?: string[] };

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
  /** `launch` / `attach`: the live browser's stream — agent-browser's daemon
   *  stream port, or the host's number for a Playwright connection — which
   *  `view` takes back; and whether it runs headed, when the host knows. */
  stream?: number;
  headed?: boolean;
  /** `attach`: the session was gone, and the host started a browser at the
   *  caller's `url`, so that page is already open. */
  relaunched?: boolean;
  /** `view`: the viewer socket's URL. */
  url?: string;
  /** `edit`: the text copy/cut placed on the OS clipboard. */
  text?: string;
  /** `measure`: the active page's own values, not frame or pane dimensions. */
  viewport?: { width: number; height: number; dpr: number };
}


/** The most requests one `close` may cancel; the host refuses a longer list. */
export const BROWSER_CLOSE_MAX_CANCELS = 32;

/** The largest viewport side and device pixel ratio a `viewport` request may
 *  set. */
export const VIEWPORT_MAX_SIDE = 16384;
export const VIEWPORT_MAX_DPR = 10;

/** The JPEG quality of a crisp capture, for either provider. */
export const CAPTURE_JPEG_QUALITY = 85;

// --- the viewer socket (docs/specs/dor-browser.md → "Viewer Socket") ---

/** Host → webview, as JSON text: the browser's state, sent only on change. */
export type ViewerState =
  /** Whether the browser is up, and its viewport's CSS size and device pixel
   *  ratio when known — a popped-out window's own, as its page reports them. */
  | { type: 'status'; connected: boolean; screencasting: boolean; viewportWidth?: number; viewportHeight?: number; devicePixelRatio?: number }
  | { type: 'tabs'; tabs: AgentBrowserTab[] }
  /** The active tab committed a navigation (before its load completes). */
  | { type: 'url'; url: string }
  /** A popped-out window's page as its browser reports it: URL and title. */
  | { type: 'page'; url: string; title: string | null }
  /** Where the host's sync-to-pane stands for `engagement`: writing the
   *  pane's size, the browser confirmed at it, or stopped because another
   *  writer set the viewport. */
  | { type: 'sync'; state: ViewerSyncState; engagement: string };

export type ViewerSyncState = 'applying' | 'synced' | 'off';

/** The pane's size while Resize with pane is engaged, for the host to size
 *  the browser to. `engagement` names the choice of Resize with pane it
 *  belongs to: a new one reclaims the viewport. */
export type ViewerSyncIntent = { type: 'sync'; width: number; height: number; dpr: number; engagement: string };

/** Webview → host, as JSON text: native input, the pane's size to sync to,
 *  and a request to resend the last frame to a canvas that mounted blank. */
export type ViewerInput =
  | {
      type: 'input_mouse';
      eventType: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
      x: number;
      y: number;
      button: 'left' | 'right' | 'middle' | 'none';
      buttons: number;
      clickCount: number;
      modifiers: number;
      deltaX?: number;
      deltaY?: number;
    }
  | { type: 'input_keyboard'; eventType: 'keyDown' | 'keyUp'; key: string; code: string; text: string; windowsVirtualKeyCode: number; modifiers: number }
  /** A paste, inserted whole. */
  | { type: 'input_text'; text: string }
  | ViewerSyncIntent
  | { type: 'repaint' };

/** The input a provider forwards to its browser. */
export type ViewerBrowserInput = Exclude<ViewerInput, { type: 'repaint' | 'sync' }>;

/** A frame: a CSS-resolution stream frame painted at once, or the
 *  device-resolution capture that replaces it. */
export type ViewerFrameKind = 'provisional' | 'crisp';

export interface ViewerFrame {
  kind: ViewerFrameKind;
  jpeg: Uint8Array;
  /** The viewport's CSS size, when the host knows it. */
  size?: { width: number; height: number };
}

/** A frame travels as one binary message: this header, then the JPEG. Byte 0
 *  is the kind, bytes 4-11 the viewport's CSS width and height (u32 LE, 0 when
 *  unknown). */
export const VIEWER_FRAME_HEADER_BYTES = 12;
const FRAME_KIND_CODE: Record<ViewerFrameKind, number> = { provisional: 1, crisp: 2 };

export function encodeViewerFrame({ kind, jpeg, size }: ViewerFrame): Uint8Array {
  const message = new Uint8Array(VIEWER_FRAME_HEADER_BYTES + jpeg.byteLength);
  const header = new DataView(message.buffer);
  header.setUint8(0, FRAME_KIND_CODE[kind]);
  header.setUint32(4, size?.width ?? 0, true);
  header.setUint32(8, size?.height ?? 0, true);
  message.set(jpeg, VIEWER_FRAME_HEADER_BYTES);
  return message;
}

/** The frame a binary message carries — its JPEG a view, not a copy — or
 *  null for one that is not a frame. */
export function decodeViewerFrame(message: ArrayBuffer): ViewerFrame | null {
  if (message.byteLength <= VIEWER_FRAME_HEADER_BYTES) return null;
  const header = new DataView(message, 0, VIEWER_FRAME_HEADER_BYTES);
  const code = header.getUint8(0);
  const kind = code === FRAME_KIND_CODE.provisional ? 'provisional' : code === FRAME_KIND_CODE.crisp ? 'crisp' : null;
  if (!kind) return null;
  const width = header.getUint32(4, true);
  const height = header.getUint32(8, true);
  return {
    kind,
    jpeg: new Uint8Array(message, VIEWER_FRAME_HEADER_BYTES),
    ...(width > 0 && height > 0 ? { size: { width, height } } : {}),
  };
}

/** The most characters one `input_text` message carries. A paste takes as
 *  many messages as it needs, each under the viewer socket's 64 KiB payload
 *  cap even when every character JSON-escapes to six bytes. */
export const VIEWER_TEXT_INPUT_MAX = 8192;

/**
 * A paste as viewer socket messages, each inserted whole by the host
 * (Playwright: CDP `Input.insertText`; agent-browser: a key pair per
 * character, sent to its daemon host-side): one message per
 * `VIEWER_TEXT_INPUT_MAX` characters, never a key down and up per character
 * from the webview, which a long paste would push past the host's input queue
 * cap. Line endings become `\n`, and a message never ends inside a surrogate
 * pair.
 */
export function viewerTextInputs(text: string): { type: 'input_text'; text: string }[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const messages: { type: 'input_text'; text: string }[] = [];
  for (let start = 0; start < normalized.length;) {
    let end = Math.min(start + VIEWER_TEXT_INPUT_MAX, normalized.length);
    const last = normalized.charCodeAt(end - 1);
    if (end < normalized.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    messages.push({ type: 'input_text', text: normalized.slice(start, end) });
    start = end;
  }
  return messages;
}

// The browsers' own new-tab pages, which a launch leaves beside its page.
const NEW_TAB_URLS = new Set(['about:newtab', 'chrome://newtab', 'chrome://new-tab-page', 'edge://newtab']);

/** Whether a tab shows nothing: empty, or the blank or new-tab page a launch
 *  can leave. */
export function isBlankUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed === '' || trimmed === 'about:blank' || NEW_TAB_URLS.has(trimmed.replace(/\/$/, ''));
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
