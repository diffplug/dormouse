import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AlertStateDetail, PlatformAdapter, PtyInfo } from "mouseterm-lib/lib/platform/types";
import { AlertManager, type SessionStatus } from "mouseterm-lib/lib/alert-manager";
import {
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  collectTerminalProtocolResponses,
  TerminalProtocolParser,
} from "mouseterm-lib/lib/terminal-protocol";
import {
  applyTerminalSemanticEventsByPtyId,
  removeTerminalPaneState,
} from "mouseterm-lib/lib/terminal-state-store";

function invoke(cmd: string, args?: Record<string, unknown>): void {
  rawInvoke(cmd, args).catch((err) =>
    console.error(`[tauri-adapter] ${cmd} failed:`, err),
  );
}

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
        applyTerminalSemanticEventsByPtyId(id, collectTerminalSemanticEvents(parsed.events));
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
        this.alertManager.onExit(event.payload.id);
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

    // Inert while dragDropEnabled=false in tauri.conf.json. See diffplug/mouseterm#38 and tauri-apps/tauri#14373.
    this.unlistenFns.push(
      await listen<{ paths: string[] }>("mouseterm://files-dropped", (event) => {
        const paths = event.payload.paths ?? [];
        if (paths.length === 0) return;
        for (const handler of this.filesDroppedHandlers) handler(paths);
      }),
    );
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
    this.protocolParsers.set(id, new TerminalProtocolParser());
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
    removeTerminalPaneState(id);
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

  onRequestSessionFlush(_handler: (detail: { requestId: string }) => void): void {}

  offRequestSessionFlush(_handler: (detail: { requestId: string }) => void): void {}

  notifySessionFlushComplete(_requestId: string): void {}

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

  private static STATE_KEY = 'mouseterm.session';

  saveState(state: unknown): void {
    try {
      localStorage.setItem(TauriAdapter.STATE_KEY, JSON.stringify(state));
    } catch {
      console.error('[tauri-adapter] Failed to save session state');
    }
  }

  getState(): unknown {
    try {
      const raw = localStorage.getItem(TauriAdapter.STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private getProtocolParser(id: string): TerminalProtocolParser {
    let parser = this.protocolParsers.get(id);
    if (!parser) {
      parser = new TerminalProtocolParser();
      this.protocolParsers.set(id, parser);
    }
    return parser;
  }
}
