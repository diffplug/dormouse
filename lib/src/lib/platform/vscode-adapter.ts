import type { AlertStateDetail, PlatformAdapter, PtyInfo } from './types';
import { setDefaultShellOpts } from '../shell-defaults';
import {
  collectTerminalSemanticEvents,
  TerminalProtocolParser,
} from '../terminal-protocol';
import {
  applyTerminalSemanticEventsByPtyId,
} from '../terminal-state-store';

export class VSCodeAdapter implements PlatformAdapter {
  private vscode: ReturnType<typeof acquireVsCodeApi>;
  private hostState: unknown = (globalThis as typeof globalThis & { __MOUSETERM_HOST_STATE__?: unknown }).__MOUSETERM_HOST_STATE__ ?? null;
  private dataHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  private replayHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private flushRequestHandlers = new Set<(detail: { requestId: string }) => void>();
  private alertStateHandlers = new Set<(detail: AlertStateDetail) => void>();

  constructor() {
    this.vscode = acquireVsCodeApi();

    // Seed the default shell from the extension-injected global so that
    // the first terminal on startup (which spawns synchronously on Wall
    // mount) picks up the selected shell, not the platform default.
    const injectedShell = (globalThis as typeof globalThis & {
      __MOUSETERM_SELECTED_SHELL__?: { shell?: string; args?: string[] } | null;
    }).__MOUSETERM_SELECTED_SHELL__;
    if (injectedShell?.shell) {
      setDefaultShellOpts({ shell: injectedShell.shell, args: injectedShell.args });
    }

    window.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'pty:data') {
        for (const handler of this.dataHandlers) {
          handler({ id: msg.id, data: msg.data });
        }
      } else if (msg.type === 'pty:exit') {
        for (const handler of this.exitHandlers) {
          handler({ id: msg.id, exitCode: msg.exitCode });
        }
      } else if (msg.type === 'pty:list') {
        for (const handler of this.listHandlers) {
          handler({ ptys: msg.ptys });
        }
      } else if (msg.type === 'pty:replay') {
        // Replay arrives as raw buffered output in a single chunk. Live pty:data
        // is pre-parsed by the extension host, so we only need a one-shot parser
        // here to reconstruct semantic state from the buffered bytes and strip
        // OSCs before xterm sees them. See docs/specs/vscode.md.
        const parser = new TerminalProtocolParser();
        const parsed = parser.process(msg.data);
        applyTerminalSemanticEventsByPtyId(msg.id, collectTerminalSemanticEvents(parsed.events));
        for (const handler of this.replayHandlers) {
          handler({ id: msg.id, data: parsed.visibleData });
        }
      } else if (msg.type === 'terminal:semanticEvents') {
        applyTerminalSemanticEventsByPtyId(msg.id, msg.events ?? []);
      } else if (msg.type === 'dormouse:flushSessionSave') {
        for (const handler of this.flushRequestHandlers) {
          handler({ requestId: msg.requestId });
        }
      } else if (msg.type === 'alert:state') {
        for (const handler of this.alertStateHandlers) {
          handler({
            id: msg.id,
            status: msg.status,
            watchingEnabled: msg.watchingEnabled,
            todo: msg.todo,
            notification: msg.notification ?? null,
            attentionDismissedRing: msg.attentionDismissedRing,
          });
        }
      } else if (msg.type === 'dormouse:newTerminal') {
        window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
          detail: {
            shell: msg.shell,
            args: msg.args,
            name: msg.name,
            replaceUntouched: msg.replaceUntouched,
            announce: msg.announce,
          },
        }));
      } else if (msg.type === 'dormouse:selectedShell') {
        setDefaultShellOpts(msg.shell ? { shell: msg.shell, args: msg.args } : null);
      } else if (msg.type === 'dormouse:openThemeDebugger') {
        window.dispatchEvent(new CustomEvent('dormouse:openThemeDebugger'));
      }
    });
  }

  private nextRequestId = 0;

  /**
   * Send a request and wait for a matching response.
   * Uses a unique requestId to avoid collisions when multiple concurrent
   * requests target the same PTY ID.
   */
  private requestResponse<T>(requestType: string, responseType: string, data: Record<string, unknown>, extract: (msg: any) => T, timeoutMs = 1000): Promise<T | null> {
    const requestId = `req-${++this.nextRequestId}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, timeoutMs);
      const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (msg?.type === responseType && msg.requestId === requestId) {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve(extract(msg));
        }
      };
      window.addEventListener('message', handler);
      this.vscode.postMessage({ type: requestType, ...data, requestId });
    });
  }

  async init(): Promise<void> {
    // No initialization needed — the webview is already running
  }

  shutdown(): void {
    // No-op — the extension host handles cleanup
  }

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    const result = await this.requestResponse(
      'pty:getShells', 'pty:shells', {},
      (msg) => msg.shells as { name: string; path: string; args?: string[] }[],
      5000,
    );
    return result ?? [];
  }

  spawnPty(id: string, options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] }): void {
    this.vscode.postMessage({ type: 'pty:spawn', id, options });
  }

  writePty(id: string, data: string): void {
    this.vscode.postMessage({ type: 'pty:input', id, data });
  }

  resizePty(id: string, cols: number, rows: number): void {
    this.vscode.postMessage({ type: 'pty:resize', id, cols, rows });
  }

  killPty(id: string): void {
    this.vscode.postMessage({ type: 'pty:kill', id });
  }

  getCwd(id: string): Promise<string | null> {
    return this.requestResponse('pty:getCwd', 'pty:cwd', { id }, (msg) => msg.cwd);
  }

  getScrollback(id: string): Promise<string | null> {
    return this.requestResponse('pty:getScrollback', 'pty:scrollback', { id }, (msg) => msg.data);
  }

  readClipboardFilePaths(): Promise<string[] | null> {
    return this.requestResponse<string[] | null>(
      'clipboard:readFiles', 'clipboard:files', {},
      (msg) => msg.paths,
      5000,
    );
  }

  readClipboardImageAsFilePath(): Promise<string | null> {
    return this.requestResponse<string | null>(
      'clipboard:readImage', 'clipboard:image', {},
      (msg) => msg.path,
      10000,
    );
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
    this.vscode.postMessage({ type: 'dormouse:init' });
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
    this.flushRequestHandlers.add(handler);
  }

  offRequestSessionFlush(handler: (detail: { requestId: string }) => void): void {
    this.flushRequestHandlers.delete(handler);
  }

  notifySessionFlushComplete(requestId: string): void {
    this.vscode.postMessage({ type: 'dormouse:flushSessionSaveDone', requestId });
  }

  // --- Alert management (proxied to extension host) ---

  alertRemove(id: string): void {
    this.vscode.postMessage({ type: 'alert:remove', id });
  }

  alertToggle(id: string): void {
    this.vscode.postMessage({ type: 'alert:toggle', id });
  }

  alertDisable(id: string): void {
    this.vscode.postMessage({ type: 'alert:disable', id });
  }

  alertDismiss(id: string): void {
    this.vscode.postMessage({ type: 'alert:dismiss', id });
  }

  alertDismissOrToggle(id: string, displayedStatus: string): void {
    this.vscode.postMessage({ type: 'alert:dismissOrToggle', id, displayedStatus });
  }

  alertAttend(id: string): void {
    this.vscode.postMessage({ type: 'alert:attend', id });
  }

  alertResize(id: string): void {
    this.vscode.postMessage({ type: 'alert:resize', id });
  }

  alertClearAttention(id?: string): void {
    this.vscode.postMessage({ type: 'alert:clearAttention', id });
  }

  alertToggleTodo(id: string): void {
    this.vscode.postMessage({ type: 'alert:toggleTodo', id });
  }

  alertMarkTodo(id: string): void {
    this.vscode.postMessage({ type: 'alert:markTodo', id });
  }

  alertClearTodo(id: string): void {
    this.vscode.postMessage({ type: 'alert:clearTodo', id });
  }

  onAlertState(handler: (detail: AlertStateDetail) => void): void {
    this.alertStateHandlers.add(handler);
  }

  offAlertState(handler: (detail: AlertStateDetail) => void): void {
    this.alertStateHandlers.delete(handler);
  }

  // --- State persistence ---

  saveState(state: unknown): void {
    this.hostState = state;
    this.vscode.setState(state);
    this.vscode.postMessage({ type: 'dormouse:saveState', state });
  }

  getState(): unknown {
    // vscode.getState() is VSCode's own per-webview storage and persists
    // across re-mount (e.g. panel collapsed then re-expanded). Prefer it
    // so splits made after initial resolve aren't lost — the injected
    // hostState only reflects what the extension put in the HTML at the
    // first resolveWebviewView call. Fall back to hostState on the very
    // first load, before any setState has run.
    return this.vscode.getState() ?? this.hostState;
  }
}
