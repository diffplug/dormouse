import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import type {
  AgentBrowserCommandResult,
  AgentBrowserEditOp,
  AgentBrowserEditResult,
  AgentBrowserOpenResult,
  AgentBrowserPopResult,
  AgentBrowserScreenshotResult,
  AgentBrowserStreamStatusResult,
  AlertStateDetail,
  IframeProxyResult,
  OpenPort,
  PlatformAdapter,
  PtyDataDetail,
  PtyInfo,
  BurrowLink,
} from "dormouse-lib/lib/platform/types";
import {
  answerAskCommand,
  createBurrowLinkClient,
  notifyCommand,
} from "dormouse-lib/host/remote/link-client";
import {
  BURROW_ASK_EVENT,
  BURROW_EVENT_EVENT,
  BURROW_RESULT_EVENT,
  type BurrowAsk,
  type BurrowCommand,
  type BurrowResult,
} from "dormouse-lib/host/remote/service-protocol";
import { embedderOrigins } from "dormouse-lib/lib/embedder-origins";
import { AlertManager } from "dormouse-lib/lib/alert-manager";
import type { AwaitHandle, AwaitOptions } from "dormouse-lib/lib/alert-manager";
import type { AlertSettings } from "dormouse-lib/lib/alert-settings";
import { normalizeExternalUri } from "dormouse-lib/lib/external-links";
import { loadSessionState, saveSessionState } from "dormouse-lib/lib/window-persistence";
import { TauriSessionStore } from "./tauri-session-store";
import { withTimeout } from "./with-timeout";
import {
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  TerminalProtocolParser,
  type TerminalProtocolEvent,
} from "dormouse-lib/lib/terminal-protocol";
import { getTerminalTheme, onTerminalThemeChange, themeColorProvider } from "dormouse-lib/lib/terminal-theme";
import type { TerminalSemanticEvent } from "dormouse-lib/lib/terminal-state";
import {
  applyTerminalSemanticEvents,
} from "dormouse-lib/lib/terminal-state-store";
import type { DorControlCancelPayload, DorControlRequestPayload } from "dor/protocol";
import {
  cancelDorControlRequest,
  dispatchDorControlRequest,
} from "dormouse-lib/lib/platform/dor-control-dispatch";

function invoke(cmd: string, args?: Record<string, unknown>): void {
  rawInvoke(cmd, args).catch((err) =>
    console.error(`[tauri-adapter] ${cmd} failed:`, err),
  );
}

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Platform adapter for the Tauri standalone app.
 *
 * Communication flow:
 *   Webview (this adapter)
 *     ↕ Tauri IPC (invoke / listen)
 *   Rust backend (src-tauri/src/lib.rs)
 *     ↕ stdin/stdout JSON messages
 *   Node.js sidecar (sidecar/main.js)
 *     ↕ node-pty
 *   Shell processes
 */
export class TauriAdapter implements PlatformAdapter {
  private dataHandlers = new Set<(detail: PtyDataDetail) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  private replayHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private filesDroppedHandlers = new Set<(paths: string[]) => void>();
  private alertStateHandlers = new Set<(detail: AlertStateDetail) => void>();
  private unlistenFns: Array<() => void> = [];
  private alertManager = new AlertManager();
  private sessionStore = new TauriSessionStore();
  // In-process session-flush handshake (mirrors the VS Code message-router flow
  // in vscode-ext/src/message-router.ts, but without postMessage — the Wall runs
  // in the same webview). Handlers are the frontend flush listeners; a request
  // fans out one requestId and resolves when a handler reports completion.
  private flushHandlers = new Set<(detail: { requestId: string }) => void>();
  private pendingFlushRequests = new Map<string, () => void>();
  private nextFlushRequestId = 0;
  // --- Remote host bridge (docs/specs/remote-api.md) ---
  //
  // The Burrow lives in the sidecar, next to the PTYs. This webview forwards its
  // console commands, answers what only it knows (pane names, xterm sizes), and
  // mirrors the pairing queue. Only the transport is this adapter's: one Rust
  // invoke carries everything, so an answer and a notify ride it as ordinary
  // commands, and correlation is `burrowRequestId` — never `requestId`, which Rust
  // swallows on any sidecar line that carries it.
  private readonly burrowClient = createBurrowLinkClient({
    sendCommand: (command) => this.sendBurrowCommand(command),
    answerAsk: (askId, results) => this.sendBurrowCommand(answerAskCommand(askId, results)),
    notify: () => this.sendBurrowCommand(notifyCommand()),
  });

  readonly burrow: BurrowLink = this.burrowClient.link;

  constructor() {
    this.alertManager.onStateChange((id, state) => {
      for (const handler of this.alertStateHandlers) {
        handler({ id, ...state });
      }
    });

    // The sidecar parses, and it has no DOM to read the theme from, so push the
    // resolved colors up whenever they change (the initial push is in
    // requestInit) — mirroring VSCodeAdapter.pushThemeColors.
    onTerminalThemeChange(() => this.pushThemeColors());
  }

  async init(): Promise<void> {
    // Registered together rather than one await after another: every `listen`
    // is an independent round trip to Rust, and serializing them puts the whole
    // set in front of the first paint.
    this.unlistenFns.push(...(await Promise.all([
      // Already parsed by the sidecar, which owns the PTY: the pair arrives as
      // it is, and its events arrive as the two messages below
      // (docs/specs/terminal-escapes.md → "Parsing location").
      listen<PtyDataDetail>("pty:data", (event) => {
        const { id, data, textData } = event.payload;
        // Feed visible data to alert manager for visual activity monitoring.
        this.alertManager.onData(id);
        for (const handler of this.dataHandlers) {
          handler({ id, data, textData });
        }
      }),

      listen<{ id: string; events: TerminalProtocolEvent[] }>("terminal:protocolEvents", (event) => {
        applyTerminalProtocolEvents(this.alertManager, event.payload.id, event.payload.events);
      }),

      listen<{ id: string; events: TerminalSemanticEvent[] }>("terminal:semanticEvents", (event) => {
        const { id, events } = event.payload;
        this.alertManager.applyTerminalSemanticEvents(id, events);
        applyTerminalSemanticEvents(id, events);
      }),

      listen<{ id: string; exitCode: number }>("pty:exit", (event) => {
        this.alertManager.onExit(event.payload.id, event.payload.exitCode);
        for (const handler of this.exitHandlers) {
          handler(event.payload);
        }
      }),

      listen<{ ptys: PtyInfo[] }>("pty:list", (event) => {
        for (const handler of this.listHandlers) {
          handler(event.payload);
        }
      }),

      listen<{ id: string; data: string }>("pty:replay", (event) => {
        // Replay arrives as raw buffered output, the one stream the sidecar does
        // not parse. A one-shot parser here repopulates semantic state and
        // strips OSCs before xterm sees them; its responses are dropped, since
        // the asker is long gone (docs/specs/terminal-escapes.md). It still
        // needs the theme: a *declined* colour query is not consumed, so it
        // reaches xterm.js instead, and answering is the owner's alone.
        const { id, data } = event.payload;
        const parsed = new TerminalProtocolParser(themeColorProvider).process(data);
        applyTerminalSemanticEvents(id, collectTerminalSemanticEvents(parsed.events));
        for (const handler of this.replayHandlers) {
          handler({ id, data: parsed.visibleData });
        }
      }),

      // Inert while dragDropEnabled=false in tauri.conf.json. See diffplug/dormouse#38 and tauri-apps/tauri#14373.
      listen<{ paths: string[] }>("dormouse://files-dropped", (event) => {
        const paths = event.payload.paths ?? [];
        if (paths.length === 0) return;
        for (const handler of this.filesDroppedHandlers) handler(paths);
      }),

      listen<BurrowResult>(BURROW_RESULT_EVENT, (event) => {
        this.burrowClient.onResult(event.payload);
      }),

      listen<BurrowAsk>(BURROW_ASK_EVENT, (event) => {
        const ask = event.payload;
        this.burrowClient.onAsk(ask.burrowRequestId, ask.op, ask.params);
      }),

      listen<{ name?: string }>(BURROW_EVENT_EVENT, (event) => {
        this.burrowClient.onEvent(event.payload);
      }),

      listen<DorControlRequestPayload>("dor:controlRequest", (event) => {
        const payload = event.payload;
        dispatchDorControlRequest(payload, (response) => {
          rawInvoke("dor_control_response", {
            response: {
              requestId: payload.requestId,
              ...response,
            },
          }).catch((err) =>
            console.error("[tauri-adapter] dor_control_response failed:", err),
          );
        });
      }),

      // The sidecar's control server gave up on a request (the `dor` client hung
      // up, or its own deadline fired). Rust forwards it verbatim: `dor-*`
      // request ids never collide with its own `req-*` invoke ids, so the
      // pending-invoke lookup misses and the event reaches us.
      listen<DorControlCancelPayload>("dor:controlCancel", (event) => {
        cancelDorControlRequest(event.payload.requestId);
      }),
    ])));

    await this.hydrateSessionStore();
  }

  // Seed the session cache from the Rust file store before restore reads it
  // (bootstrap() awaits init() before resumeOrRestore). The Rust store is the sole
  // backing — the session blob never lives in WebKit localStorage
  // (docs/specs/standalone.md).
  private async hydrateSessionStore(): Promise<void> {
    let seed: string | null = null;
    try {
      seed = (await rawInvoke<string | null>("load_session")) ?? null;
    } catch (err) {
      console.error("[tauri-adapter] load_session failed:", err);
    }
    this.sessionStore.hydrate(seed);
    await this.clearLegacySessionState();
  }

  shutdown(): void {
    this.alertManager.dispose();
    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];
    // Nothing will answer what is outstanding once the sidecar is gone.
    this.burrowClient.dispose();
    invoke("kill_sidecar_now");
  }

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    try {
      return await rawInvoke<{ name: string; path: string; args?: string[] }[]>("get_available_shells");
    } catch { return []; }
  }

  spawnPty(id: string, options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] }): void {
    invoke("pty_spawn", { id, options });
  }

  writePty(id: string, data: string): void {
    invoke("pty_write", { id, data });
  }

  resizePty(id: string, cols: number, rows: number): void {
    invoke("pty_resize", { id, cols, rows });
  }

  killPty(id: string): void {
    invoke("pty_kill", { id });
  }

  async getCwd(id: string): Promise<string | null> {
    try {
      return await rawInvoke<string | null>("pty_get_cwd", { id });
    } catch { return null; }
  }

  // Warn-and-proceed: a stalled graceful kill must not wedge a quit teardown.
  // Callers own the timeout — the teardown bounds live in one place, quit.ts.
  async gracefulKillAllPtys(timeoutMs: number): Promise<void> {
    try {
      await rawInvoke("pty_graceful_kill_all", { timeout: timeoutMs });
    } catch (err) {
      console.warn("[tauri-adapter] gracefulKillAllPtys failed; proceeding", err);
    }
  }

  async getOpenPorts(id: string): Promise<OpenPort[]> {
    try {
      return await rawInvoke<OpenPort[]>("pty_get_open_ports", { id });
    } catch { return []; }
  }

  async readClipboardFilePaths(): Promise<string[] | null> {
    try {
      return await rawInvoke<string[]>("read_clipboard_file_paths");
    } catch { return null; }
  }

  async readClipboardImageAsFilePath(): Promise<string | null> {
    try {
      return await rawInvoke<string | null>("read_clipboard_image_as_file_path");
    } catch { return null; }
  }

  async readClipboardText(): Promise<string | null> {
    try {
      return await rawInvoke<string>("read_clipboard_text");
    } catch { return null; }
  }

  async createIframeProxyUrl(targetUrl: string): Promise<IframeProxyResult> {
    // The sidecar stands up the loopback proxy and serves the bytes (shared
    // lib/src/host/iframe-proxy.ts). On failure, report unreachable so the panel
    // shows a hint rather than a never-loading frame.
    try {
      // The webview's ancestor chain decides who may frame the proxy and where
      // its shim may post; only this realm can read it.
      return await rawInvoke<IframeProxyResult>("iframe_create_proxy_url", {
        target: targetUrl,
        embedderOrigins: embedderOrigins(),
      });
    } catch (err) {
      return { ok: false, reason: "unreachable", detail: errMessage(err) };
    }
  }

  // --- agent-browser host capabilities (see docs/specs/dor-browser.md →
  // "Agent-Browser Host Capabilities"). Each invokes the matching Rust command, which runs the
  // user's agent-browser binary (binaryPath → DORMOUSE_AGENT_BROWSER_BIN → PATH,
  // mirroring the VS Code host's runWithBinaryFallback). Note there is no
  // getAgentBrowserStreamUrl here: the agent-browser stream server accepts the
  // tauri://localhost origin, so the panel connects directly to
  // ws://127.0.0.1:<port> via its built-in fallback when the method is absent. ---

  async agentBrowserCommand(session: string, args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult> {
    try {
      return await rawInvoke<AgentBrowserCommandResult>("agent_browser_command", { session, args, binaryPath });
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: errMessage(err) };
    }
  }

  async agentBrowserEdit(session: string, op: AgentBrowserEditOp, binaryPath?: string): Promise<AgentBrowserEditResult> {
    try {
      return await rawInvoke<AgentBrowserEditResult>("agent_browser_edit", { session, op, binaryPath });
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  async agentBrowserScreenshot(session: string, opts: { format?: "jpeg" | "png"; quality?: number }, binaryPath?: string): Promise<AgentBrowserScreenshotResult> {
    // The Rust command returns the raw image as an ArrayBuffer (tauri::ipc::Response)
    // on success, or rejects with an error string — no base64 round-trip.
    try {
      const buffer = await rawInvoke<ArrayBuffer>("agent_browser_screenshot", {
        session,
        format: opts.format,
        quality: opts.quality,
        binaryPath,
      });
      const mime = opts.format === "png" ? "image/png" : "image/jpeg";
      return { ok: true, bytes: new Uint8Array(buffer), mime };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  async agentBrowserStreamStatus(session: string, binaryPath?: string): Promise<AgentBrowserStreamStatusResult> {
    try {
      return await rawInvoke<AgentBrowserStreamStatusResult>("agent_browser_stream_status", { session, binaryPath });
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  async agentBrowserOpen(url: string, opts: { headed?: boolean }, binaryPath?: string): Promise<AgentBrowserOpenResult> {
    try {
      return await rawInvoke<AgentBrowserOpenResult>("agent_browser_open", { url, headed: opts.headed, binaryPath });
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  async agentBrowserPopOut(session: string, opts: { rect?: { x: number; y: number; width: number; height: number }; url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult> {
    // `rect` is accepted by the type but unused — no window positioning today.
    try {
      return await rawInvoke<AgentBrowserPopResult>("agent_browser_pop_out", { session, url: opts.url, binaryPath });
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  async agentBrowserPopIn(session: string, opts: { url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult> {
    try {
      return await rawInvoke<AgentBrowserPopResult>("agent_browser_pop_in", { session, url: opts.url, binaryPath });
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  openExternal(uri: string): void {
    const normalized = normalizeExternalUri(uri);
    if (!normalized) return;
    open(normalized).catch((err) =>
      console.error("[tauri-adapter] openExternal failed:", err),
    );
  }

  onFilesDropped(handler: (paths: string[]) => void): () => void {
    this.filesDroppedHandlers.add(handler);
    return () => { this.filesDroppedHandlers.delete(handler); };
  }

  onPtyData(handler: (detail: PtyDataDetail) => void): void {
    this.dataHandlers.add(handler);
  }

  offPtyData(handler: (detail: PtyDataDetail) => void): void {
    this.dataHandlers.delete(handler);
  }

  onPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void {
    this.exitHandlers.add(handler);
  }

  offPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void {
    this.exitHandlers.delete(handler);
  }

  requestInit(): void {
    invoke("pty_request_init");
    this.pushThemeColors();
  }

  /** Send the resolved terminal theme colors to the sidecar so its parser can
   *  answer OSC 10/11/12 color queries (it has no DOM of its own). */
  private pushThemeColors(): void {
    const theme = getTerminalTheme();
    invoke("pty_theme_colors", {
      colors: {
        foreground: theme.foreground,
        background: theme.background,
        cursor: theme.cursor,
      },
    });
  }

  onPtyList(handler: (detail: { ptys: PtyInfo[] }) => void): void {
    this.listHandlers.add(handler);
  }

  offPtyList(handler: (detail: { ptys: PtyInfo[] }) => void): void {
    this.listHandlers.delete(handler);
  }

  onPtyReplay(handler: (detail: { id: string; data: string }) => void): void {
    this.replayHandlers.add(handler);
  }

  offPtyReplay(handler: (detail: { id: string; data: string }) => void): void {
    this.replayHandlers.delete(handler);
  }

  onRequestSessionFlush(handler: (detail: { requestId: string }) => void): void {
    this.flushHandlers.add(handler);
  }

  offRequestSessionFlush(handler: (detail: { requestId: string }) => void): void {
    this.flushHandlers.delete(handler);
  }

  notifySessionFlushComplete(requestId: string): void {
    const resolve = this.pendingFlushRequests.get(requestId);
    if (!resolve) return;
    this.pendingFlushRequests.delete(requestId);
    resolve();
  }

  // Ask the frontend to flush its debounced/heartbeat session save now and report
  // back. Resolves when a handler notifies completion for this requestId, or when
  // the bounded wait elapses — quit must never wedge on a stalled flush. If no
  // handler is registered (quit during boot, before the Wall mounts), resolve
  // immediately: there is nothing queued to flush. Called by the quit
  // orchestrator; pairs with drainSessionSaves to await the resulting Rust write.
  requestSessionFlush(timeoutMs: number): Promise<void> {
    if (this.flushHandlers.size === 0) return Promise.resolve();
    const requestId = `flush-${++this.nextFlushRequestId}`;
    return new Promise<void>((resolve) => {
      this.pendingFlushRequests.set(requestId, resolve);
      // Timeout is a synthetic completion; a stale timer after a real completion
      // hits notify's map-miss guard. Fan out after registering so a synchronous
      // completion still finds the entry (first notify wins — one Wall ships).
      setTimeout(() => this.notifySessionFlushComplete(requestId), timeoutMs);
      for (const handler of this.flushHandlers) handler({ requestId });
    });
  }

  // Await the session store's in-flight/pending save_session pipeline (the Rust
  // temp+fsync+rename that actually reaches disk). Bounded: on timeout resolve
  // anyway rather than wedge quit.
  drainSessionSaves(timeoutMs: number): Promise<void> {
    return withTimeout(
      this.sessionStore.drain(),
      timeoutMs,
      "[tauri-adapter] drainSessionSaves timed out; proceeding with quit",
    );
  }

  private sendBurrowCommand(command: BurrowCommand): void {
    rawInvoke("burrow_command", { payload: command }).catch((err) =>
      console.error("[tauri-adapter] burrow_command failed:", err),
    );
  }

  // --- Alert management (local AlertManager) ---

  alertRemove(id: string): void {
    this.alertManager.remove(id);
  }

  alertSetWatchedCommands(names: string[]): void {
    this.alertManager.setWatchedCommands(names);
  }

  alertSetCommandWatched(name: string, watched: boolean): void {
    this.alertManager.setCommandWatched(name, watched);
  }

  alertPublishSettings(settings: AlertSettings): void { this.alertManager.applySettings(settings); }

  alertDismiss(id: string): void {
    this.alertManager.dismissAlert(id);
  }

  alertAttend(id: string): void {
    this.alertManager.attend(id);
  }

  alertResize(id: string): void {
    this.alertManager.onResize(id);
  }

  alertClearAttention(id?: string): void {
    this.alertManager.clearAttention(id);
  }

  alertToggleTodo(id: string): void {
    this.alertManager.toggleTodo(id);
  }

  alertMarkTodo(id: string): void {
    this.alertManager.markTodo(id);
  }

  alertClearTodo(id: string): void {
    this.alertManager.clearTodo(id);
  }

  alertAwait(id: string, options: AwaitOptions): AwaitHandle {
    return this.alertManager.awaitCompletion(id, options);
  }

  onAlertState(handler: (detail: AlertStateDetail) => void): void {
    this.alertStateHandlers.add(handler);
  }

  // Single webview owning the AlertManager, so localStorage is the only store
  // and there is no canonical snapshot to broadcast back.
  onWatchedCommands(_handler: (names: string[]) => void): void {}

  onAlertSettings(_handler: (settings: AlertSettings) => void): void {}

  // --- State persistence ---

  private static STATE_KEY = 'dormouse.session';

  // Standalone persists no Session state: quitting the app is a deliberate
  // ending, and a crash captured nothing, so every launch starts fresh
  // (docs/specs/transport.md -> "The governing rule").
  //
  // This is a gate at the adapter boundary, not a removal of the store. The
  // plumbing below it — TauriSessionStore, the Rust temp-then-rename file store,
  // the quit flush/drain ordering — is intact and still needed by the
  // workspaces-rollout scope (docs/specs/layout.md -> `## Future`). Bringing
  // VS Code-style restoration to standalone later is flipping this flag plus
  // adding capture to the existing quit teardown, which already has the right
  // shape (flush -> kill -> flush -> drain).
  private static PERSIST_SESSION = false;

  /**
   * Read by `saveSession`, which skips the whole record build — not just the
   * write — when a host persists nothing (`PlatformAdapter.persistsSession`).
   */
  readonly persistsSession = TauriAdapter.PERSIST_SESSION;

  saveState(state: unknown): void {
    if (!TauriAdapter.PERSIST_SESSION) return;
    try {
      saveSessionState(this.sessionStore, TauriAdapter.STATE_KEY, state);
    } catch {
      console.error('[tauri-adapter] Failed to save session state');
    }
  }

  getState(): unknown {
    if (!TauriAdapter.PERSIST_SESSION) return null;
    try {
      return loadSessionState(this.sessionStore, TauriAdapter.STATE_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Delete any pre-upgrade snapshot or orphaned temp write. Those carry
   * transcripts, so ignoring the slot is not enough — the bytes have to leave the
   * disk (docs/specs/transport.md -> "Retiring the transcripts already on disk").
   * Called from init() after the store hydrates.
   *
   * Deletes the file through the Rust store that owns it rather than blanking the
   * slot: a sentinel would leave the bytes in place until some later write, and
   * would oblige every reader to treat `''` as a third state alongside present
   * and absent.
   */
  private async clearLegacySessionState(): Promise<void> {
    const hadReadableSnapshot = this.sessionStore.getItem(TauriAdapter.STATE_KEY) !== null;
    try {
      // Always ask Rust to clear: load_session cannot see a .json.tmp left by a
      // crash before rename, but that file still contains the legacy transcript.
      await rawInvoke<void>("clear_session");
      this.sessionStore.hydrate(null);
      if (hadReadableSnapshot) {
        console.info('[tauri-adapter] Cleared legacy persisted session (transcripts are no longer stored)');
      }
    } catch (err) {
      console.error('[tauri-adapter] Failed to clear legacy session state:', err);
    }
  }
}
