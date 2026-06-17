import type { AlertState } from '../alert-manager';
import type { VSCodeWorkbenchCommand } from '../vscode-keybindings';

export interface PtyInfo {
  id: string;
  alive: boolean;
  exitCode?: number;
}

/**
 * A TCP socket in the LISTEN state opened by a terminal's shell process or any
 * of its descendant subprocesses. `address` is the bind interface — `0.0.0.0`
 * / `::` mean all interfaces, `127.0.0.1` / `::1` mean loopback-only.
 */
export interface OpenPort {
  protocol: 'tcp';
  family: 'IPv4' | 'IPv6';
  address: string;
  port: number;
  pid: number;
  processName?: string;
}

/**
 * End-to-end budget for `getOpenPorts()` at every transport boundary
 * (webview → host adapter, host → pty-host child, Tauri command → sidecar) and
 * for the per-subprocess execs inside `getOpenPortsForPid()` (lsof, PowerShell,
 * `Get-NetTCPConnection`, `netstat`). Wider than the 1 s cwd query because
 * enumeration shells out on macOS/Windows; tight enough to fail visibly rather
 * than hang a pane header. Mirrored as `OPEN_PORT_TIMEOUT_MS` in
 * `standalone/sidecar/pty-core.js` and `standalone/src-tauri/src/lib.rs`.
 */
export const OPEN_PORT_TIMEOUT_MS = 3000;

export type AlertStateDetail = { id: string } & AlertState;

export interface AgentBrowserCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Subcommands the host will run on the webview's behalf — this is a narrow
 * channel for tab actions, screen-mode resizing (`set viewport` / `set
 * device`), HiDPI frame capture (`screenshot`), navigation (`open <url>`,
 * `reload` / `back` / `forward`), and session teardown, not a general exec
 * path. */
export const AGENT_BROWSER_ALLOWED_SUBCOMMANDS = ['tab', 'set', 'screenshot', 'open', 'reload', 'back', 'forward', 'close'] as const;

export interface AgentBrowserScreenshotResult {
  ok: boolean;
  /** Raw image bytes (transferred over the host↔webview channel via structured
   *  clone, so no base64 round-trip); present iff ok. */
  bytes?: Uint8Array;
  /** e.g. 'image/jpeg' | 'image/png'. */
  mime?: string;
  error?: string;
}

/** Native editing operations that the stream's input_keyboard path cannot
 * trigger on macOS (CDP drops the `commands` field — see
 * docs/specs/dor-agent-browser.md and the upstream issue). The host owns the
 * exact JS for each; the webview only picks one of these names, so this stays
 * a purpose-built channel rather than an arbitrary-eval one. */
export type AgentBrowserEditOp = 'selectAll' | 'copy' | 'cut';

export interface AgentBrowserEditResult {
  ok: boolean;
  /** Text the host placed on the OS clipboard (copy/cut); omitted for selectAll. */
  text?: string;
  error?: string;
}

/**
 * Result of asking the host to front a `dor iframe` target with its transparent
 * proxy (docs/specs/dor-iframe.md → "The Transparent Proxy"). On `ok` the panel
 * points the `<iframe>` at `url` — a loopback proxy origin that fetches the
 * target, strips frame-blocking headers (loopback only), and injects the
 * Dormouse shim. On failure `reason` says why there is nothing to frame:
 * `scheme` (not a proxyable `http://` upstream — e.g. an `https://` target,
 * which v1 defers), `unreachable` (nothing answered), or `frame-refused` (a
 * remote that forbids embedding — use `dor ab` instead). Reachability and
 * frame-refusal are normally diagnosed lazily and surfaced as a served error
 * *page* inside the frame, so v1 mostly returns `ok` or `scheme` here.
 */
export type IframeProxyResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'frame-refused' | 'unreachable' | 'scheme'; detail?: string };

export interface PlatformAdapter {
  // Lifecycle
  init(): Promise<void>;
  shutdown(): void;

  // Shell detection
  getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]>;

  // PTY operations
  spawnPty(id: string, options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] }): void;
  writePty(id: string, data: string): void;
  resizePty(id: string, cols: number, rows: number): void;
  killPty(id: string): void;

  // PTY queries
  getCwd(id: string): Promise<string | null>;
  getScrollback(id: string): Promise<string | null>;
  /** TCP listening ports opened by this terminal's process tree (shell + descendants). */
  getOpenPorts(id: string): Promise<OpenPort[]>;

  // Clipboard support for file references and raw images.
  readClipboardFilePaths(): Promise<string[] | null>;
  readClipboardImageAsFilePath(): Promise<string | null>;
  // Optional native clipboard text read. When present, doPaste uses this
  // instead of navigator.clipboard.readText() so adapters whose webview pops
  // a "Paste from <App>" confirmation (notably Tauri's WKWebView) can bypass it.
  readClipboardText?(): Promise<string | null>;
  // Only present on adapters with a native (non-DOM) drag-drop source. Currently inert in Tauri; see diffplug/dormouse#38 and tauri-apps/tauri#14373.
  onFilesDropped?(handler: (paths: string[]) => void): () => void;

  // Open a sanitized external URI. Implementations must revalidate because
  // terminal output is untrusted.
  openExternal?(uri: string): void;

  // VS Code-only escape hatch for mirrored workbench shortcuts from webviews.
  runWorkbenchCommand?(command: VSCodeWorkbenchCommand): void;

  // agent-browser surface support (see docs/specs/dor-agent-browser.md).
  // Runs the user's agent-browser binary against a session; the host validates
  // args[0] against AGENT_BROWSER_ALLOWED_SUBCOMMANDS. `binaryPath` is the
  // absolute path resolved by `dor ab` in the invoking terminal — the host's
  // own PATH (e.g. a GUI-launched extension host) may not find the binary.
  agentBrowserCommand?(session: string, args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult>;
  // Performs a native editing operation (select-all/copy/cut) the stream input
  // path can't, via the daemon's CDP-backed eval. The host owns the JS and,
  // for copy/cut, writes the result to the OS clipboard. Absent on hosts that
  // can't run the binary (degrades to plain key forwarding).
  agentBrowserEdit?(session: string, op: AgentBrowserEditOp, binaryPath?: string): Promise<AgentBrowserEditResult>;
  // Captures a single device-resolution (HiDPI) frame via the user's
  // agent-browser `screenshot` command and returns the raw image bytes. The
  // stream's screencast is CSS-resolution only (a Chromium limitation —
  // Page.startScreencast ignores deviceScaleFactor), so the panel displays
  // these crisp screenshots instead, using stream frames only as change
  // signals. Absent on hosts that can't run the binary (degrades to rendering
  // the screencast frames directly).
  agentBrowserScreenshot?(session: string, opts: { format?: 'jpeg' | 'png'; quality?: number }, binaryPath?: string): Promise<AgentBrowserScreenshotResult>;
  // The WebSocket URL for a session's stream port. Hosts whose webview origin
  // the agent-browser stream server rejects (VS Code) return a tokenized relay
  // URL; absent or null falls back to ws://127.0.0.1:<port>.
  getAgentBrowserStreamUrl?(port: number): Promise<string | null>;

  // iframe surface support (see docs/specs/dor-iframe.md → "The Transparent
  // Proxy"). Stands up a loopback proxy in front of a `dor iframe` target and
  // returns the proxy URL the panel should frame, or a structured reason it
  // could not. Absent on hosts with no process to run a proxy (e.g. the web
  // host), where the panel falls back to a raw, uninstrumented `<iframe>`.
  createIframeProxyUrl?(targetUrl: string): Promise<IframeProxyResult>;

  // PTY event listeners
  onPtyData(handler: (detail: { id: string; data: string }) => void): void;
  offPtyData(handler: (detail: { id: string; data: string }) => void): void;
  onPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void;
  offPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void;

  // Resume (live-PTY replay after webview hide/show)
  requestInit(): void;
  onPtyList(handler: (detail: { ptys: PtyInfo[] }) => void): void;
  offPtyList(handler: (detail: { ptys: PtyInfo[] }) => void): void;
  onPtyReplay(handler: (detail: { id: string; data: string }) => void): void;
  offPtyReplay(handler: (detail: { id: string; data: string }) => void): void;

  // Host-initiated session persistence
  onRequestSessionFlush(handler: (detail: { requestId: string }) => void): void;
  offRequestSessionFlush(handler: (detail: { requestId: string }) => void): void;
  notifySessionFlushComplete(requestId: string): void;

  // Alert management
  alertRemove(id: string): void;
  alertToggle(id: string): void;
  alertDisable(id: string): void;
  alertDismiss(id: string): void;
  alertDismissOrToggle(id: string, displayedStatus: string): void;
  alertAttend(id: string): void;
  alertResize(id: string): void;
  alertClearAttention(id?: string): void;
  alertToggleTodo(id: string): void;
  alertMarkTodo(id: string): void;
  alertClearTodo(id: string): void;
  onAlertState(handler: (detail: AlertStateDetail) => void): void;
  offAlertState(handler: (detail: AlertStateDetail) => void): void;

  // State persistence
  saveState(state: unknown): void;
  getState(): unknown;
}
