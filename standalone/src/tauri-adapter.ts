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
  PtyInfo,
} from "dormouse-lib/lib/platform/types";
import { AlertManager, type SessionStatus } from "dormouse-lib/lib/alert-manager";
import { normalizeExternalUri } from "dormouse-lib/lib/external-links";
import { loadSessionState, saveSessionState } from "dormouse-lib/lib/window-persistence";
import { TauriSessionStore } from "./tauri-session-store";
import {
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  collectTerminalProtocolResponses,
  TerminalProtocolParser,
} from "dormouse-lib/lib/terminal-protocol";
import { themeColorProvider } from "dormouse-lib/lib/terminal-theme";
import {
  applyTerminalSemanticEventsByPtyId,
} from "dormouse-lib/lib/terminal-state-store";
import type { DorControlRequestPayload, DorControlResult } from "dor/protocol";

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
  private dataHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  private replayHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private filesDroppedHandlers = new Set<(paths: string[]) => void>();
  private alertStateHandlers = new Set<(detail: AlertStateDetail) => void>();
  private unlistenFns: Array<() => void> = [];
  private protocolParsers = new Map<string, TerminalProtocolParser>();
  private alertManager = new AlertManager();
  private sessionStore = new TauriSessionStore();
  // In-process session-flush handshake (mirrors the VS Code message-router flow
  // in vscode-ext/src/message-router.ts, but without postMessage — the Wall runs
  // in the same webview). Handlers are the frontend flush listeners; a request
  // fans out one requestId and resolves when a handler reports completion.
  private flushHandlers = new Set<(detail: { requestId: string }) => void>();
  private pendingFlushRequests = new Map<string, () => void>();
  private nextFlushRequestId = 0;

  constructor() {
    // Wire alert manager state changes to handlers
    this.alertManager.onStateChange((id, state) => {
      for (const handler of this.alertStateHandlers) {
        handler({ id, ...state });
      }
    });
  }

  async init(): Promise<void> {
    // Set up event listeners for PTY events from the Rust backend
    // (The Rust backend manages the Node.js sidecar lifecycle via std::process::Command)
    this.unlistenFns.push(
      await listen<{ id: string; data: string }>("pty:data", (event) => {
        const { id, data } = event.payload;
        const parsed = this.getProtocolParser(id).process(data);
        applyTerminalProtocolEvents(this.alertManager, id, parsed.events);
        const semanticEvents = collectTerminalSemanticEvents(parsed.events);
        this.alertManager.applyTerminalSemanticEvents(id, semanticEvents);
        applyTerminalSemanticEventsByPtyId(id, semanticEvents);
        for (const response of collectTerminalProtocolResponses(parsed.events)) {
          invoke("pty_write", { id, data: response });
        }
        if (parsed.visibleData.length === 0) return;
        // Feed visible data to alert manager for visual activity monitoring.
        this.alertManager.onData(id);
        for (const handler of this.dataHandlers) {
          handler({ id, data: parsed.visibleData });
        }
      }),
    );

    this.unlistenFns.push(
      await listen<{ id: string; exitCode: number }>("pty:exit", (event) => {
        this.alertManager.onExit(event.payload.id, event.payload.exitCode);
        this.protocolParsers.delete(event.payload.id);
        for (const handler of this.exitHandlers) {
          handler(event.payload);
        }
      }),
    );

    this.unlistenFns.push(
      await listen<{ ptys: PtyInfo[] }>("pty:list", (event) => {
        for (const handler of this.listHandlers) {
          handler(event.payload);
        }
      }),
    );

    this.unlistenFns.push(
      await listen<{ id: string; data: string }>("pty:replay", (event) => {
        // Replay arrives as raw buffered output. Run it through the protocol
        // parser so semantic OSCs (CWD, prompt, title) repopulate pane state
        // and are stripped before xterm sees them, mirroring live pty:data.
        const { id, data } = event.payload;
        const parsed = this.getProtocolParser(id).process(data);
        applyTerminalSemanticEventsByPtyId(id, collectTerminalSemanticEvents(parsed.events));
        for (const handler of this.replayHandlers) {
          handler({ id, data: parsed.visibleData });
        }
      }),
    );

    // Inert while dragDropEnabled=false in tauri.conf.json. See diffplug/dormouse#38 and tauri-apps/tauri#14373.
    this.unlistenFns.push(
      await listen<{ paths: string[] }>("dormouse://files-dropped", (event) => {
        const paths = event.payload.paths ?? [];
        if (paths.length === 0) return;
        for (const handler of this.filesDroppedHandlers) handler(paths);
      }),
    );

    this.unlistenFns.push(
      await listen<DorControlRequestPayload>("dor:controlRequest", (event) => {
        const payload = event.payload;
        const respond = (response: DorControlResult) => {
          rawInvoke("dor_control_response", {
            response: {
              requestId: payload.requestId,
              ...response,
            },
          }).catch((err) =>
            console.error("[tauri-adapter] dor_control_response failed:", err),
          );
        };

        window.dispatchEvent(new CustomEvent("dormouse:control-request", {
          detail: {
            requestId: payload.requestId,
            surfaceId: payload.surfaceId,
            method: payload.method,
            params: payload.params ?? {},
            respond,
          },
        }));
      }),
    );

    await this.hydrateSessionStore();
  }

  // Seed the session cache from the Rust file store before restore reads it
  // (bootstrap() awaits init() before resumeOrRestore). On the first boot after
  // moving off WebKit localStorage, adopt any legacy blob still parked there,
  // persist it to Rust, and clear it — so WebKit stops rewriting that key and
  // its bloated WAL collapses on the next quit (docs/specs/standalone.md).
  private async hydrateSessionStore(): Promise<void> {
    let seed: string | null = null;
    try {
      seed = (await rawInvoke<string | null>("load_session")) ?? null;
    } catch (err) {
      console.error("[tauri-adapter] load_session failed:", err);
    }
    let migrated: string | null = null;
    if (seed === null) {
      // One-time migration off WebKit localStorage. SUNSET: drop this branch
      // once shipped builds have all migrated. It assumes a single window — the
      // legacy blob is per-origin (shared across windows) and window-agnostic,
      // which is safe today because the app ships one window; a multi-window
      // build must gate this so only one window adopts the shared blob.
      migrated = localStorage.getItem(TauriAdapter.STATE_KEY);
      if (migrated !== null) {
        localStorage.removeItem(TauriAdapter.STATE_KEY);
      }
    }
    // Do NOT seed the cache with the migrated blob: setItem's identical-value
    // short-circuit would skip the write, and localStorage is already cleared —
    // the setItem below must be a genuine change so the blob reaches the Rust
    // store (setItem updates the cache synchronously for the cold-restore read).
    this.sessionStore.hydrate(seed);
    // Persist the adopted blob through the store's normal write path (not a raw
    // invoke) so it shares the same coalescing — and the planned drain-on-quit.
    if (migrated !== null) this.sessionStore.setItem(TauriAdapter.STATE_KEY, migrated);
  }

  shutdown(): void {
    this.alertManager.dispose();
    this.protocolParsers.clear();
    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];
    invoke("kill_sidecar_now");
  }

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    try {
      return await rawInvoke<{ name: string; path: string; args?: string[] }[]>("get_available_shells");
    } catch { return []; }
  }

  spawnPty(id: string, options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] }): void {
    this.protocolParsers.set(id, new TerminalProtocolParser(themeColorProvider));
    invoke("pty_spawn", { id, options });
  }

  writePty(id: string, data: string): void {
    invoke("pty_write", { id, data });
  }

  resizePty(id: string, cols: number, rows: number): void {
    invoke("pty_resize", { id, cols, rows });
  }

  killPty(id: string): void {
    this.protocolParsers.delete(id);
    invoke("pty_kill", { id });
  }

  async getCwd(id: string): Promise<string | null> {
    try {
      return await rawInvoke<string | null>("pty_get_cwd", { id });
    } catch { return null; }
  }

  async getScrollback(id: string): Promise<string | null> {
    try {
      return await rawInvoke<string | null>("pty_get_scrollback", { id });
    } catch { return null; }
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
      return await rawInvoke<IframeProxyResult>("iframe_create_proxy_url", { target: targetUrl });
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

  onPtyData(handler: (detail: { id: string; data: string }) => void): void {
    this.dataHandlers.add(handler);
  }

  offPtyData(handler: (detail: { id: string; data: string }) => void): void {
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
  // immediately: there is nothing queued to flush. Called by the (future) quit
  // orchestrator; pairs with drainSessionSaves to await the resulting Rust write.
  requestSessionFlush(timeoutMs = 1500): Promise<void> {
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
  // anyway rather than wedge quit. Called by the (future) quit orchestrator after
  // requestSessionFlush has pushed the latest state through saveState.
  async drainSessionSaves(timeoutMs = 2000): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn("[tauri-adapter] drainSessionSaves timed out; proceeding with quit");
        resolve();
      }, timeoutMs);
    });
    await Promise.race([this.sessionStore.drain(), timeout]);
    clearTimeout(timer!);
  }

  // --- Alert management (local AlertManager) ---

  alertRemove(id: string): void {
    this.alertManager.remove(id);
  }

  alertToggle(id: string): void {
    this.alertManager.toggleAlert(id);
  }

  alertDisable(id: string): void {
    this.alertManager.disableAlert(id);
  }

  alertDismiss(id: string): void {
    this.alertManager.dismissAlert(id);
  }

  alertDismissOrToggle(id: string, displayedStatus: string): void {
    this.alertManager.dismissOrToggleAlert(id, displayedStatus as SessionStatus);
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

  onAlertState(handler: (detail: AlertStateDetail) => void): void {
    this.alertStateHandlers.add(handler);
  }

  offAlertState(handler: (detail: AlertStateDetail) => void): void {
    this.alertStateHandlers.delete(handler);
  }

  // --- State persistence ---

  private static STATE_KEY = 'dormouse.session';

  // Persisted blob is a PersistedWindow when the workspaces flag is on, a bare
  // PersistedSession when off (docs/specs/transport.md). The window-persistence
  // helpers own the translation + JSON plumbing; the backing store is the
  // Rust-backed cache (hydrated in init()), not WebKit localStorage.
  saveState(state: unknown): void {
    try {
      saveSessionState(this.sessionStore, TauriAdapter.STATE_KEY, state);
    } catch {
      console.error('[tauri-adapter] Failed to save session state');
    }
  }

  getState(): unknown {
    try {
      return loadSessionState(this.sessionStore, TauriAdapter.STATE_KEY);
    } catch {
      return null;
    }
  }

  private getProtocolParser(id: string): TerminalProtocolParser {
    let parser = this.protocolParsers.get(id);
    if (!parser) {
      parser = new TerminalProtocolParser(themeColorProvider);
      this.protocolParsers.set(id, parser);
    }
    return parser;
  }
}
