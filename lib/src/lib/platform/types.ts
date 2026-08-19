import type { AlertState } from '../alert-manager';
import type { AlertSettings } from '../alert-settings';
import type { VSCodeWorkbenchCommand } from '../vscode-keybindings';
// Defined in its own dependency-free file so the Node proxy in lib/src/host can
// share it without pulling this browser-typed module into a Node tsconfig.
import type { IframeProxyResult } from './iframe-proxy-types';

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
 * path. `get` is limited host-side to `get cdp-url` for CDP event
 * subscription while a browser is popped out. */
export const AGENT_BROWSER_ALLOWED_SUBCOMMANDS = ['tab', 'set', 'screenshot', 'open', 'reload', 'back', 'forward', 'close', 'get'] as const;

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
 * docs/specs/dor-browser.md and the upstream issue). The host owns the
 * exact JS for each; the webview only picks one of these names, so this stays
 * a purpose-built channel rather than an arbitrary-eval one. */
export type AgentBrowserEditOp = 'selectAll' | 'copy' | 'cut';

export interface AgentBrowserEditResult {
  ok: boolean;
  /** Text the host placed on the OS clipboard (copy/cut); omitted for selectAll. */
  text?: string;
  error?: string;
}

export type { IframeProxyResult };

/** Result of asking the host for the current stream status of an existing
 *  session. Used to recover persisted panels whose saved wsPort went stale
 *  across VS Code/webview reloads without exposing a generic `stream` exec
 *  channel to the webview. */
export interface AgentBrowserStreamStatusResult {
  ok: boolean;
  wsPort?: number;
  error?: string;
}

/** Result of spawning a managed agent-browser session for a render swap
 *  (docs/specs/dor-browser.md → "Display Modal And Render Swaps"). */
export interface AgentBrowserOpenResult {
  ok: boolean;
  /** The resolved/namespaced session name the new surface should bind to. */
  session?: string;
  /** The session's stream WebSocket port. */
  wsPort?: number;
  /** The binary path the host resolved, threaded back so later host commands
   *  (close, screenshot…) reuse it. */
  binaryPath?: string;
  error?: string;
}

/** Result of a headed/headless relaunch (docs/specs/dor-browser.md →
 *  "Pop-Out"). The Chrome process is replaced, so the stream port
 *  changes; the session name is preserved. */
export interface AgentBrowserPopResult {
  ok: boolean;
  /** The new stream WebSocket port after the relaunch. */
  wsPort?: number;
  error?: string;
}

/**
 * Coordination between the several webviews one host backend can show
 * (docs/specs/vscode.md → "Peer surfaces").
 *
 * The remote Host runs in exactly one webview, but a window's terminals are
 * spread across all of them and each webview has its own xterm registry. The
 * Host therefore cannot list or drive a sibling's pane directly; the host
 * process brokers, and this is the webview end of that.
 *
 * Arbitrating a single-holder role and asking a sibling a question are two
 * facets of one precondition — being able to show more than one webview over
 * one backend — so they sit behind one optional member rather than two. A host
 * either has peers to elect among and ask, or it has neither: standalone and
 * the website are one webview per app, so they omit this and callers treat
 * themselves as the only instance.
 *
 * `op` is deliberately opaque here. *What* a peer can be asked is a property of
 * the remote Host, not of the platform, so the operation map and its real types
 * live in `lib/src/remote/host/peer-surfaces.ts`; this layer, the extension-host
 * broker, and the cross-window link only carry the bytes.
 */
export interface PeerBridge {
  /**
   * Claim a named role that at most one webview may hold, and be told whenever
   * the claim is granted or revoked. The host arbitrates, because it is the
   * only party that sees every webview and outlives each one.
   */
  claimSingleton(name: string, onChange: (held: boolean) => void): void;

  /**
   * Put `op` to every peer and collect what they answer. Each peer contributes
   * zero or more results, so an empty array means nobody owned what was asked
   * about — there is no separate miss signal.
   */
  request(op: string, params: unknown): Promise<unknown[]>;

  /** Answer `op` on behalf of this webview's own surfaces; no results = not mine. */
  respond(op: string, handler: (params: unknown) => unknown[]): void;

  /** Announce that future answers for `topic` may differ. */
  notify(topic: string): void;

  /** Re-run a peer-backed subscription after another webview announces `topic`. */
  subscribe(topic: string, listener: () => void): () => void;

  /**
   * Start receiving `pty:data` / `pty:exit` for a PTY this webview does not
   * own, and return the unsubscribe. A subscription, not a pair of calls, so
   * the caller cannot leak one by forgetting the id it used.
   */
  streamPty(ptyId: string): () => void;
}

/**
 * The webview end of a Node-resident remote Host
 * (`lib/src/host/remote/service-protocol.ts`).
 *
 * When the Host runs in the process that owns the PTYs, the webview stops being
 * the Host and becomes its UI plus its surface responder: it forwards console
 * commands, answers what its own panes are called and how big they are, and
 * mirrors the pairing queue. `respond`/`notify` are deliberately the same shape
 * as {@link PeerBridge}'s, so one responder implementation serves a webview that
 * answers a sibling and a webview that answers the service.
 *
 * `cmd` and `op` are opaque here for the same reason they are on `PeerBridge`:
 * *what* the service can be asked belongs to the remote Host, not the platform.
 */
export interface RemoteHostLink {
  /** Run a service command and resolve its result, or reject with its error. */
  command(cmd: string, params?: unknown): Promise<unknown>;

  /** Answer `op` on behalf of this webview's own surfaces; no results = not mine. */
  respond(op: string, handler: (params: unknown) => unknown[]): void;

  /** Announce that future answers for `topic` may differ. */
  notify(topic: string): void;

  /**
   * Subscribe to one of the service's pushed events by name (`pairing-queue`),
   * receiving the event object the service sent — its `name` included. Returns
   * the unsubscribe.
   */
  on(name: string, listener: (data: unknown) => void): () => void;
}

export interface PlatformAdapter {
  // Lifecycle
  init(): Promise<void>;
  shutdown(): void;

  /**
   * Make every key under `prefix` readable synchronously from a host-owned
   * store instead of `localStorage`, then keep it written through. Optional:
   * only hosts whose real storage lives outside the webview implement it (VS
   * Code, where the extension host holds `SecretStorage`). Callers must await
   * it before any module reads those keys, because `local-json-store` is
   * synchronous by contract. Adapters that omit it leave `localStorage` in
   * charge, which is correct for standalone and the website.
   */
  hydrateScopedStore?(prefix: string): Promise<void>;

  /**
   * Elect among, and reach surfaces owned by, sibling webviews. Optional: only
   * a host that can show several webviews over one backend has peers at all
   * (VS Code). Adapters that omit it are single-instance, so callers hold every
   * role and have nobody to ask.
   */
  peers?: PeerBridge;

  /**
   * Reach the remote Host service behind this host. Present exactly when the
   * Host runs outside the webview (standalone's sidecar), which is also exactly
   * when this webview is a surface responder rather than the Host itself.
   * Adapters that omit it host the Host in the webview (VS Code, the website).
   */
  remoteHost?: RemoteHostLink;

  // Shell detection
  getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]>;

  // PTY operations
  spawnPty(id: string, options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] }): void;
  writePty(id: string, data: string): void;
  resizePty(id: string, cols: number, rows: number): void;
  killPty(id: string): void;

  /**
   * Whether this host keeps a Session snapshot across a restart. `false` means
   * `saveSession` does no work at all rather than building a record for a
   * `saveState` that discards it — the gate belongs above the per-pane `getCwd`
   * round trips, not below them.
   *
   * Absent reads as `true`. Standalone sets it `false`: quitting is a deliberate
   * ending and a crash captured nothing, so every launch starts fresh
   * (docs/specs/transport.md -> "The governing rule").
   */
  persistsSession?: boolean;

  /**
   * Whether the host owns the color theme, so Dormouse must not offer a theme
   * picker of its own. Absent reads as `false`.
   *
   * `VSCodeAdapter` sets it `true`: VS Code supplies `--vscode-*` directly and
   * its own theme UI is the only correct control there, so the Settings dialog
   * hides its Theme row (docs/specs/theme.md).
   */
  hostOwnsTheme?: boolean;

  /**
   * Agent resume invocations the host captured when it last tore down, keyed by
   * surface id — consumed once by a cold restore (`session-restore.ts`).
   *
   * Deliberately *not* part of the persisted session: it is host-owned and
   * single-use, and a webview that could save it back would replay a stale
   * invocation on a later restore. Absent on adapters whose host captures
   * nothing (docs/specs/transport.md -> "Consuming it").
   */
  getRecoveryCommands?(): Record<string, string>;

  // PTY queries
  getCwd(id: string): Promise<string | null>;
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

  // agent-browser surface support (see docs/specs/dor-browser.md).
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
  // signals. Absent on hosts that can't run the binary — the panel then shows
  // only the placeholder (frame bytes are discarded; there is no frame-drawing
  // fallback).
  agentBrowserScreenshot?(session: string, opts: { format?: 'jpeg' | 'png'; quality?: number }, binaryPath?: string): Promise<AgentBrowserScreenshotResult>;
  // Reads the current stream port for an already-running session. This is a
  // purpose-built status channel, not part of agentBrowserCommand's allowlist,
  // so restored panels can recover from a stale persisted wsPort after reload.
  agentBrowserStreamStatus?(session: string, binaryPath?: string): Promise<AgentBrowserStreamStatusResult>;
  // The WebSocket URL for a session's stream port. Hosts whose webview origin
  // the agent-browser stream server rejects (VS Code) return a tokenized relay
  // URL; absent or null falls back to ws://127.0.0.1:<port>.
  getAgentBrowserStreamUrl?(port: number): Promise<string | null>;

  // iframe surface support (see docs/specs/dor-browser.md → "Iframe
  // Renderer"). Stands up a loopback proxy in front of a `dor iframe` target and
  // returns the proxy URL the panel should frame, or a structured reason it
  // could not. Absent on hosts with no process to run a proxy (e.g. the web
  // host), where the panel falls back to a raw, uninstrumented `<iframe>`.
  createIframeProxyUrl?(targetUrl: string): Promise<IframeProxyResult>;

  // Render-swap support (docs/specs/dor-browser.md → "Display Modal And Render Swaps";
  // docs/specs/dor-browser.md → "Pop-Out"). All optional
  // so hosts degrade: the modal hides whatever isn't backed by a capability.
  //
  // Spawn a managed agent-browser session and open <url> — backs swapping an
  // iframe embed up to a live screencast (`headed: false`) or straight to a
  // popped-out window (`headed: true`, so embed→popout is one spawn, not a
  // headless launch immediately torn down). `binaryPath` is the last one a
  // `dor ab` surface resolved (a GUI-launched host's own PATH may miss the
  // binary); the host falls back to PATH / DORMOUSE_AGENT_BROWSER_BIN.
  agentBrowserOpen?(url: string, opts: { headed?: boolean }, binaryPath?: string): Promise<AgentBrowserOpenResult>;
  // Relaunch a session's browser headed as a native OS window, reopening `url`
  // (headed/headless is fixed at launch, so this is a close+relaunch — v1
  // preserves the active tab URL). Best-effort positioned over `rect` (CSS px
  // in screen space). Returns the new stream port. Absent ⇒ pop-out hidden.
  agentBrowserPopOut?(session: string, opts: { rect?: { x: number; y: number; width: number; height: number }; url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult>;
  // Relaunch headless (pop back in) reopening `url`, resuming the screencast;
  // returns the new stream port. Pairs with agentBrowserPopOut.
  agentBrowserPopIn?(session: string, opts: { url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult>;
  // Best-effort raise the session's headed window to the front.
  agentBrowserBringToFront?(session: string, binaryPath?: string): Promise<void>;

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
  /** Offer persisted WATCHING rules as the host's startup seed. */
  alertSetWatchedCommands(names: string[]): void;
  /** Mutate one bare-command WATCHING rule without replacing unrelated rules. */
  alertSetCommandWatched(name: string, watched: boolean): void;
  /**
   * Push alarm settings to the host. `seed: true` offers them as the startup
   * seed, which a multi-webview host accepts only once; `seed: false` is a user
   * edit and always replaces.
   */
  alertPublishSettings(settings: AlertSettings, opts: { seed: boolean }): void;
  alertDismiss(id: string): void;
  alertAttend(id: string): void;
  alertResize(id: string): void;
  alertClearAttention(id?: string): void;
  alertToggleTodo(id: string): void;
  alertMarkTodo(id: string): void;
  alertClearTodo(id: string): void;
  // Alert subscriptions have no `off` counterpart, unlike the PTY listeners
  // above: their handlers are stable module-level functions registered once for
  // the renderer's lifetime (`initAlertStateReceiver`), so adapters store them
  // in a `Set` and re-registration is idempotent. Add the pair back if a
  // caller ever needs to unsubscribe.
  onAlertState(handler: (detail: AlertStateDetail) => void): void;
  /** Receive the host's canonical WATCHING rule snapshot. */
  onWatchedCommands(handler: (names: string[]) => void): void;
  /** Receive the host's canonical alarm settings. */
  onAlertSettings(handler: (settings: AlertSettings) => void): void;

  // State persistence
  saveState(state: unknown): void;
  getState(): unknown;
}
