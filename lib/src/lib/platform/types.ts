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
