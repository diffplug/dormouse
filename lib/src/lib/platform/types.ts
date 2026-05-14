import type { AlertState } from '../alert-manager';

export interface PtyInfo {
  id: string;
  alive: boolean;
  exitCode?: number;
}

export type AlertStateDetail = { id: string } & AlertState;

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

  // Clipboard support for file references and raw images.
  readClipboardFilePaths(): Promise<string[] | null>;
  readClipboardImageAsFilePath(): Promise<string | null>;
  // Optional native clipboard text read. When present, doPaste uses this
  // instead of navigator.clipboard.readText() so adapters whose webview pops
  // a "Paste from <App>" confirmation (notably Tauri's WKWebView) can bypass it.
  readClipboardText?(): Promise<string | null>;
  // Only present on adapters with a native (non-DOM) drag-drop source. Currently inert in Tauri; see diffplug/mouseterm#38 and tauri-apps/tauri#14373.
  onFilesDropped?(handler: (paths: string[]) => void): () => void;

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
