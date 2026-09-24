import type { BrowserAutomationProvider, BrowserRequest, BrowserResult } from './browser-automation';
import type { HelperIdentity, TerminalContextRequest, TerminalContextInfo } from '../terminal-context-types';
import type { AlertState, AwaitHandle, AwaitOptions, Engagement, EngagementLapse } from '../alert-manager';
import type { AlertSettings } from '../alert-settings';
import type { AlertSessionInfo, AlertSpeak } from '../../host/alert-protocol';
import type { VSCodeWorkbenchCommand } from '../vscode-keybindings';
import type { ShellEntry } from '../shell-defaults';
// Defined in its own dependency-free file so the Node proxy in lib/src/host can
// share it without pulling this browser-typed module into a Node tsconfig.
import type { IframeProxyResult } from './iframe-proxy-types';
import type { ToolControlResult, ToolHostRequest } from './tool-types';
import type { GitInfoResult } from './git-types';

export type { ToolControlResult, ToolHostRequest, ToolLookupResult } from './tool-types';
export type { GitDirInfo, GitInfoResult } from './git-types';
import type { NotepadArchivePort } from '../notepad/types';
import type { PersistedAlertState, PersistedWindow } from '../session-types';

export interface PtyInfo {
  helper?: HelperIdentity;
  id: string;
  alive: boolean;
  exitCode?: number;
  /** Executable path of the shell this PTY launched. Carried on reconnect so
   *  shell-sensitive input remains Session-specific after the webview reloads. */
  shell?: string;
}

/** The host's answer to one `requestInit`, echoing the token it was asked with
 *  where the host has one to echo (`PlatformAdapter.requestInit`). */
export interface PtyListDetail {
  ptys: PtyInfo[];
  requestId?: string;
}

/** One PTY's buffered output, behind the list that named it. */
export interface PtyReplayDetail {
  id: string;
  data: string;
  requestId?: string;
}

/** A PTY's output position, stamped in the stream by the host for a transfer
 *  (`docs/specs/transport.md` → "Transferring a Workspace"): every `pty:data`
 *  delivered before it is at or before `mark`. */
export interface PtyMarkedDetail {
  id: string;
  mark: number;
  requestId?: string;
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

/** Base scan budget. The macOS and Windows socket scans add a per-id allowance;
 *  transport deadlines cover both serial scans plus a margin per IPC hop.
 *  Rust and sidecar copies are pinned by `mirrored-constants.test.ts`. */
export const OPEN_PORT_TIMEOUT_MS = 3000;

/**
 * What a batched scan (`getOpenPortsMany`) adds to `OPEN_PORT_TIMEOUT_MS` per
 * terminal it covers: the sidecar's socket scan lists every descendant of every
 * terminal in one `lsof`, so one terminal's budget cannot be the whole
 * Window's. Mirrored as `OPEN_PORT_TIMEOUT_PER_ID_MS` in
 * `standalone/sidecar/pty-core.js` and `standalone/src-tauri/src/lib.rs`;
 * pinned by `mirrored-constants.test.ts`.
 */
export const OPEN_PORT_TIMEOUT_PER_ID_MS = 100;

/** Margin for each transport hop, mirrored in Rust and pinned by the constants test. */
export const OPEN_PORT_ROUND_TRIP_MARGIN_MS = 1000;

export function openPortRequestTimeoutMs(count: number, hops = 1): number {
  return 2 * OPEN_PORT_TIMEOUT_MS + OPEN_PORT_TIMEOUT_PER_ID_MS * count
    + OPEN_PORT_ROUND_TRIP_MARGIN_MS * hops;
}


export type AlertStateDetail = { id: string } & AlertState;

export type { IframeProxyResult };

/**
 * The webview end of a Node-resident Burrow
 * (`lib/src/host/remote/service-protocol.ts`).
 *
 * The Burrow runs in the process that owns the PTYs — the Tauri sidecar, the VS
 * Code extension host — so the webview is its UI plus its surface responder: it
 * forwards console commands, answers what its own panes are called and how big
 * they are, and mirrors the pairing queue. Nothing a webview answers can widen
 * access (docs/specs/remote-security-model.md).
 *
 * `cmd` and `op` are deliberately opaque here. *What* the service can be asked
 * belongs to the Burrow, not to the platform, so the operation map and its
 * real types live in `lib/src/remote/burrow/peer-surfaces.ts`; this layer and the
 * transports under it only carry the bytes.
 */
export interface BurrowLink {
  /** Run a service command and resolve its result, or reject with its error. */
  command(cmd: string, params?: unknown): Promise<unknown>;

  /** Answer `op` on behalf of this webview's own surfaces; no results = not mine. */
  respond(op: string, handler: (params: unknown) => unknown[]): void;

  /**
   * Announce that future answers may differ. Carries no subject: the directory
   * is the only thing a peer can be asked to answer, so naming it would be a
   * field every layer copies and nobody reads.
   */
  notify(): void;

  /**
   * Subscribe to one of the service's pushed events by name (`pairing-queue`),
   * receiving the event object the service sent — its `name` included. Returns
   * the unsubscribe.
   */
  on(name: string, listener: (data: unknown) => void): () => void;
}

/**
 * One chunk of PTY output after protocol parsing. `data` is what xterm.js
 * renders; `textData` is the same chunk with string-control payloads removed,
 * for consumers reading it as text. **Omitted when identical to `data`**, which
 * is the common case, so the two never cost twice the bytes over a transport
 * (`docs/specs/transport.md`). The same pair crosses every host seam and the
 * remote wire — `ProcessedPtyChunk` in
 * `lib/src/remote/burrow/burrow-surface-provider.ts`, `TerminalDataEvent` in
 * `remote-lib-common/src/remote/wire.ts` — under the same omitted/present rule.
 */
export interface PtyDataDetail {
  id: string;
  data: string;
  textData?: string;
}

/**
 * One host request for an immediate session save. `probeCwd: false` says the
 * answer must not re-read any cwd: after the PTYs are killed every probe answers
 * null and the record keeps its previous value anyway, so the round trips are
 * pure teardown budget (`docs/specs/standalone.md` → "Quit flow"). Absent probes.
 */
export interface SessionFlushRequest {
  requestId: string;
  probeCwd?: boolean;
}

export interface SpawnPtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  args?: string[];
  helper?: HelperIdentity;
  alert?: PersistedAlertState;
}

export interface WritePtyOptions {
  /** Deliver at typing pace (`docs/specs/transport.md` → "Paced input"). */
  paced?: boolean;
  /** A human typed, pasted, or dropped this: the host acknowledges it with
   *  input before writing (`docs/specs/alert.md` -> Engagement). */
  userInput?: true;
}

export interface PlatformAdapter {
  // Lifecycle
  init(): Promise<void>;
  shutdown(): void;

  /**
   * Reach the Burrow service behind this host. Present exactly when a
   * process behind the webview owns the PTYs and can run the Burrow (standalone's
   * sidecar, VS Code's extension host). Adapters that omit it have no Burrow
   * anywhere — the website — so the remote modules stay inert.
   */
  burrow?: BurrowLink;

  // Shell detection
  getAvailableShells(): Promise<ShellEntry[]>;

  terminalContext?(request: TerminalContextRequest): Promise<TerminalContextInfo>;

  // PTY operations
  /**
   * `alert` is a cold-restored pane's persisted TODO: the host starts the id's
   * alert state over at every spawn, then seeds it from this
   * (`docs/specs/alert.md` -> "Persist only").
   */
  spawnPty(id: string, options?: SpawnPtyOptions): void;
  writePty(id: string, data: string, options?: WritePtyOptions): void;
  resizePty(id: string, cols: number, rows: number): void;
  killPty(id: string): void;

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
   * Whether the host owns shell selection, so Dormouse must not offer a shell
   * picker of its own. Absent reads as `false`.
   *
   * `VSCodeAdapter` sets it `true`: the native `dormouse.selectShell` QuickPick
   * (with its own workspaceState persistence) is the only correct control
   * there, so the Settings dialog hides its Shell row (docs/specs/vscode.md).
   */
  hostOwnsShells?: boolean;

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

  /**
   * Resolves once `getRecoveryCommands` can be read. The claim is a host round
   * trip, so an adapter starts it during `init()` and the boot awaits it only on
   * the branch that cold-restores (`standalone/src/main.tsx`). Absent means
   * `getRecoveryCommands` is already answerable.
   */
  recoveryReady?: Promise<void>;

  /**
   * Quit and relaunch; resolves whether the quit relaunches, and `requester`
   * never counts as running work in its confirmation
   * (`docs/specs/standalone.md` → "Restart"). Absent where a host cannot.
   */
  requestAppRestart?(requester?: string): Promise<boolean>;


  // PTY queries
  getCwd(id: string): Promise<string | null>;
  /**
   * One answer per id, for the whole set a save is about to persist. Present
   * where a host can resolve many at once: standalone probes cwds with a
   * synchronous process scan on the sidecar's only event loop, so N panes must
   * cost one scan rather than N (`docs/specs/transport.md` -> "Persisted
   * session"). Absent falls back to `getCwd` per id.
   */
  getCwds?(ids: string[]): Promise<Record<string, string | null>>;
  /** TCP listening ports opened by this terminal's process tree (shell + descendants). */
  getOpenPorts(id: string): Promise<OpenPort[]>;
  /**
   * One answer per id, for a whole listing at once (`dor list --ports`, and
   * `--all` across every Workspace). Present where a host can resolve many in
   * one scan, for the reason `getCwds` is: standalone walks the process table
   * and the socket table synchronously on the sidecar's only event loop, so N
   * terminals must cost one pass rather than N. Absent falls back to
   * `getOpenPorts` per id.
   */
  getOpenPortsMany?(ids: string[]): Promise<Record<string, OpenPort[]>>;

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

  // Browser automation (docs/specs/dor-browser.md → "Agent-Browser Host
  // Capabilities"): the providers this host can drive, and the one typed
  // request every browser operation of theirs rides. Both present or both
  // absent; a host without them (the web demo) offers no automated renderer.
  browserProviders?: readonly BrowserAutomationProvider[];
  browser?(request: BrowserRequest): Promise<BrowserResult>;

  // iframe surface support (see docs/specs/dor-browser.md → "Iframe
  // Renderer"). Stands up a loopback proxy in front of a `dor iframe` target and
  // returns the proxy URL the panel should frame, or a structured reason it
  // could not. Absent on hosts with no process to run a proxy (e.g. the web
  // host), where the panel falls back to a raw, uninstrumented `<iframe>`.
  createIframeProxyUrl?(targetUrl: string): Promise<IframeProxyResult>;

  // Dor Tools (see docs/specs/dor-tool.md). Two operations behind one method:
  // resolve a tool name against the nearest dormouse.yml, and record a trust
  // decision a human made in Dormouse's own chrome. Both need a filesystem, so
  // this is absent on hosts with none (the web demo), where `dor tool <name>`
  // reports that the host cannot read a tool file. `dor tool -- <command>`
  // needs none of it and works everywhere.
  toolControl?(request: ToolHostRequest): Promise<ToolControlResult>;

  // The repository holding each local directory, for Workspace auto-naming
  // (docs/specs/layout.md → "Workspace names"). Absent on a host with no local
  // filesystem, which names every Workspace by directory.
  gitInfo?(paths: string[]): Promise<GitInfoResult>;

  // PTY event listeners
  onPtyData(handler: (detail: PtyDataDetail) => void): void;
  offPtyData(handler: (detail: PtyDataDetail) => void): void;
  onPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void;
  offPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void;

  // Resume (live-PTY replay after webview hide/show)
  /** Ask for the live PTY list and each one's replay. `requestId` is the asking
   *  collector's token: a host serving several windows echoes it on the answer
   *  so two collections in one webview cannot finish on each other's list
   *  (docs/specs/transport.md -> "Reconnection"). The hosts that do not echo it
   *  (VS Code, Pocket, the website) run one collector per JS realm, so their
   *  answers carry none and the collector takes them. */
  requestInit(requestId?: string): void;
  onPtyList(handler: (detail: PtyListDetail) => void): void;
  offPtyList(handler: (detail: PtyListDetail) => void): void;
  onPtyReplay(handler: (detail: PtyReplayDetail) => void): void;
  offPtyReplay(handler: (detail: PtyReplayDetail) => void): void;
  /** Hosts that hand Workspaces between windows stamp marks; returns the
   *  unsubscribe. Absent on hosts with one window. */
  onPtyMarked?(handler: (detail: PtyMarkedDetail) => void): () => void;
  /** Hand a Workspace to another window — a label, or `'new'` for one torn out
   *  — through the host's transfer (`docs/specs/standalone.md` → Transfer),
   *  `index` naming its slot in the target's strip (appended without one).
   *  Resolves once the target has adopted it; rejects when it was handed back.
   *  Absent on hosts with one window. */
  transferWorkspace?(workspaceId: string, toWindow: string, options?: { index?: number }): Promise<void>;

  // Host-initiated session persistence
  onRequestSessionFlush(handler: (detail: SessionFlushRequest) => void): void;
  offRequestSessionFlush(handler: (detail: SessionFlushRequest) => void): void;
  notifySessionFlushComplete(requestId: string): void;

  // Alert management: a Session's alert state follows its PTY — `writePty`'s
  // `userInput` acknowledges, a resize opens its grace window, a kill removes it.
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
  /**
   * This renderer realm's presence and focus (`docs/specs/alert.md` ->
   * Engagement), sent only when it changes; `lapse` says why presence ended.
   */
  alertEngagement(state: Engagement, lapse?: EngagementLapse): void;
  /**
   * Every Session this realm shows, with its Pane label and its Workspace's
   * sparse delivery overrides, for the host's delivery scheduler
   * (`docs/specs/alert.md` -> Alarm settings). Replaces what this realm
   * published before.
   */
  alertPublishSessions(sessions: Record<string, AlertSessionInfo>): void;
  /** A human gesture reached the Session without input; input rides `writePty`'s `userInput`. */
  alertAcknowledge(id: string): void;
  alertToggleTodo(id: string): void;
  alertClearTodo(id: string): void;
  /**
   * Park until the Session finishes what it is doing (`docs/specs/alert.md` ->
   * Await), for `dor await`. The host owns the wake condition, the grace
   * window, and the `timeoutMs` ceiling; the caller only reads the outcome and
   * may `cancel()` while it is still pending. A completion the await consumes
   * is delivered to it instead of ringing the human.
   */
  alertAwait(id: string, options: AwaitOptions): AwaitHandle;
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
  /** Receive each spoken alarm the host scheduled, to speak. */
  onAlertSpeak(handler: (speak: AlertSpeak) => void): () => void;

  // State persistence
  saveState(state: unknown): void;
  getState(): unknown;

  /**
   * The Window slot, for the hosts that persist one (`docs/specs/transport.md` ->
   * "Persisted session"). Separate from `saveState`/`getState` because the blob
   * is a `PersistedWindow` and every shared reader of `getState` wants a bare
   * `PersistedSession`. Both standalone adapters answer these; VS Code, which
   * persists one Session per webview, omits them.
   */
  getWindowState?(): PersistedWindow | null;
  saveWindowState?(snapshot: PersistedWindow): void;

  /**
   * The Surface notepad's archive store (docs/specs/notepad.md). Present on
   * every host that has a notepad — standalone (owner-only JSON under app
   * data), VS Code (`globalState`), the website demo (memory). Absent means no
   * notepad at all: Pocket omits it and the header icon, popup action, and
   * Settings entry all stay hidden.
   */
  notepadArchive?: NotepadArchivePort;

  /**
   * Whether the browser hosting this webview reserves the notepad chord
   * (Cmd/Ctrl+N opens a new window, unpreventable), so Dormouse shows no
   * shortcut and binds none. Absent reads as `false`; the website's demo
   * adapter sets it `true`.
   */
  browserReservesNotepadChord?: boolean;
}
