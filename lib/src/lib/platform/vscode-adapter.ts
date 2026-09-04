import type { AgentBrowserCommandResult, AgentBrowserEditOp, AgentBrowserEditResult, AgentBrowserOpenResult, AgentBrowserPopResult, AgentBrowserScreenshotResult, AgentBrowserStreamStatusResult, AlertStateDetail, IframeProxyResult, OpenPort, PlatformAdapter, PtyDataDetail, PtyInfo, RemoteHostLink } from './types';
import { OPEN_PORT_TIMEOUT_MS } from './types';
import { createRemoteHostLinkClient } from '../../host/remote/link-client';
import type { AwaitHandle, AwaitOptions, AwaitOutcome } from '../alert-manager';
import type { AlertSettings } from '../alert-settings';
import { readInjectedRecoveryCommands } from '../vscode-recovery-global';
import { setDefaultShellOpts } from '../shell-defaults';
import { embedderOrigins } from '../embedder-origins';
import {
  collectTerminalSemanticEvents,
  TerminalProtocolParser,
} from '../terminal-protocol';
import {
  applyTerminalSemanticEventsByPtyId,
} from '../terminal-state-store';
import { getTerminalTheme, onTerminalThemeChange, themeColorProvider } from '../terminal-theme';
import { isHostMessage, readHostMessageToken } from '../vscode-message-token';
import { cancelDorControlRequest, dispatchDorControlRequest } from './dor-control-dispatch';
import type { VSCodeWorkbenchCommand } from '../vscode-keybindings';

/**
 * What `awaitHostReply` settles with when its caller's own deadline fired and
 * the listener was detached. A distinct sentinel rather than `null`, so a host
 * reply whose extracted value is legitimately `null` stays distinguishable from
 * "no reply came".
 */
const DETACHED = Symbol('detached');

/** The outcome a VS Code await handle reports when it can never be answered. */
const CANCELLED_AWAIT: AwaitOutcome = { kind: 'cancelled', waitedMs: 0 };

export class VSCodeAdapter implements PlatformAdapter {
  // VS Code owns the theme here: it provides --vscode-* itself and has its own
  // theme UI, so Dormouse hides the Settings dialog's Theme row.
  readonly hostOwnsTheme = true;
  // Same for the shell: VS Code's native `dormouse.selectShell` QuickPick owns
  // shell selection there, so the Settings dialog hides its Shell row.
  readonly hostOwnsShells = true;
  private vscode: ReturnType<typeof acquireVsCodeApi>;
  private hostState: unknown = (globalThis as typeof globalThis & { __DORMOUSE_HOST_STATE__?: unknown }).__DORMOUSE_HOST_STATE__ ?? null;
  // Captured once, at construction, from the global the extension host injects
  // at webview boot — so a later same-document write can't move the goalposts.
  // Every `message` listener below checks it before reading anything else.
  private readonly hostMessageToken = readHostMessageToken();
  private dataHandlers = new Set<(detail: PtyDataDetail) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  private replayHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private flushRequestHandlers = new Set<(detail: { requestId: string }) => void>();
  private alertStateHandlers = new Set<(detail: AlertStateDetail) => void>();
  private watchedCommandHandlers = new Set<(names: string[]) => void>();
  private alertSettingsHandlers = new Set<(settings: AlertSettings) => void>();
  // --- Remote host bridge (docs/specs/remote-api.md) ---
  //
  // The Host lives in the extension host, next to the PTYs, in whichever VS
  // Code window won the bind-as-lease. This webview forwards its console
  // commands, answers what only it knows (pane names, xterm sizes), and mirrors
  // the pairing queue. Everything but the three postMessage shapes below is the
  // shared client's (lib/src/host/remote/link-client.ts).
  private readonly remoteHostClient = createRemoteHostLinkClient({
    sendCommand: (payload) => this.vscode.postMessage({ type: 'remoteHost:command', payload }),
    // An ask arrives as `peer:ask` and is answered on the same pair, which the
    // extension host's fan-out settles by `requestId`.
    answerAsk: (requestId, results) =>
      this.vscode.postMessage({ type: 'peer:answer', requestId, results }),
    notify: () => this.vscode.postMessage({ type: 'peer:notify' }),
  });

  readonly remoteHost: RemoteHostLink = this.remoteHostClient.link;

  constructor() {
    this.vscode = acquireVsCodeApi();

    // These get called through detached references in the agent-browser panel
    // (e.g. `getPlatform().agentBrowserScreenshot`), which would otherwise drop
    // `this` and throw on the internal `requestResponse`. Bind them once so any
    // call style is safe.
    this.agentBrowserCommand = this.agentBrowserCommand.bind(this);
    this.agentBrowserEdit = this.agentBrowserEdit.bind(this);
    this.agentBrowserScreenshot = this.agentBrowserScreenshot.bind(this);
    this.agentBrowserStreamStatus = this.agentBrowserStreamStatus.bind(this);
    this.getAgentBrowserStreamUrl = this.getAgentBrowserStreamUrl.bind(this);
    this.agentBrowserOpen = this.agentBrowserOpen.bind(this);
    this.agentBrowserPopOut = this.agentBrowserPopOut.bind(this);
    this.agentBrowserPopIn = this.agentBrowserPopIn.bind(this);
    this.createIframeProxyUrl = this.createIframeProxyUrl.bind(this);

    // Seed the default shell from the extension-injected global so that
    // the first terminal on startup (which spawns synchronously on Wall
    // mount) picks up the selected shell, not the platform default.
    const injectedShell = (globalThis as typeof globalThis & {
      __DORMOUSE_SELECTED_SHELL__?: { shell?: string; args?: string[] } | null;
    }).__DORMOUSE_SELECTED_SHELL__;
    if (injectedShell?.shell) {
      setDefaultShellOpts({ shell: injectedShell.shell, args: injectedShell.args });
    }

    // The extension-host parser has no DOM, so it can't read the theme to answer
    // OSC 10/11/12 color queries. Push the resolved colors up whenever the theme
    // changes (initial push happens in requestInit) so it can — matching the
    // standalone frontend adapter. See docs/specs/terminal-escapes.md.
    onTerminalThemeChange(() => this.pushThemeColors());

    window.addEventListener('message', (event: MessageEvent) => {
      // Authenticate the sender before looking at `type` at all — see
      // ../vscode-message-token.ts.
      if (!isHostMessage(event.data, this.hostMessageToken)) return;
      const msg = event.data;
      if (!msg.type) return;

      if (msg.type === 'pty:data') {
        for (const handler of this.dataHandlers) {
          handler({ id: msg.id, data: msg.data, textData: msg.textData });
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
        // OSCs before xterm sees them. See docs/specs/vscode.md. It gets the
        // theme for the same reason every other parser does: a *declined* query
        // is not consumed, so it reaches xterm.js, and answering is the owner's
        // alone. The replay report filter catches the reply that provokes — a
        // backstop, not the contract.
        const parser = new TerminalProtocolParser(themeColorProvider);
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
        // The host posts the whole `AlertState`; forwarding it wholesale is what
        // keeps a new alert field from needing an edit on this path alone.
        const { type: _type, ...detail } = msg;
        for (const handler of this.alertStateHandlers) {
          handler(detail);
        }
      } else if (msg.type === 'alert:watchedCommands') {
        for (const handler of this.watchedCommandHandlers) {
          handler(msg.names);
        }
      } else if (msg.type === 'alert:settings') {
        for (const handler of this.alertSettingsHandlers) {
          handler(msg.settings);
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
      } else if (msg.type === 'dor:controlRequest') {
        dispatchDorControlRequest(msg, (response) => {
          this.vscode.postMessage({
            type: 'dor:controlResponse',
            requestId: msg.requestId,
            ...response,
          });
        });
      } else if (msg.type === 'dor:controlCancel') {
        cancelDorControlRequest(msg.requestId);
      } else if (msg.type === 'peer:ask') {
        this.remoteHostClient.onAsk(msg.requestId, msg.op, msg.params);
      } else if (msg.type === 'remoteHost:result') {
        this.remoteHostClient.onResult(msg.payload);
      } else if (msg.type === 'remoteHost:event') {
        this.remoteHostClient.onEvent(msg.payload);
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
    const reply = this.awaitHostReply(responseType, requestId, extract);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => reply.detach(), timeoutMs);
      void reply.promise.then((value) => {
        clearTimeout(timeout);
        resolve(value === DETACHED ? null : value);
      });
      this.vscode.postMessage({ type: requestType, ...data, requestId });
    });
  }

  /**
   * One-shot listener for the host reply correlated by `requestId`. `detach`
   * stops listening and settles the promise with `DETACHED` (a caller's own
   * deadline fired). It settles rather than simply going quiet because a
   * promise that can never resolve keeps every `.then` closure registered on it
   * alive for the life of the webview.
   */
  private awaitHostReply<T>(responseType: string, requestId: string, extract: (msg: any) => T): { promise: Promise<T | typeof DETACHED>; detach(): void } {
    let handler: ((event: MessageEvent) => void) | null = null;
    let settle: ((value: T | typeof DETACHED) => void) | null = null;
    const detach = (): void => {
      if (!handler) return;
      window.removeEventListener('message', handler);
      handler = null;
      settle?.(DETACHED);
    };
    const promise = new Promise<T | typeof DETACHED>((resolve) => {
      settle = resolve;
      handler = (event: MessageEvent) => {
        // Same guard as the main listener: a request/response reply carries
        // host-supplied data (a proxy URL, scrollback, clipboard contents), and
        // a forged one racing the real reply would win on first match.
        if (!isHostMessage(event.data, this.hostMessageToken)) return;
        const msg = event.data;
        if (msg.type !== responseType || msg.requestId !== requestId) return;
        // The real reply is the answer, so drop the `DETACHED` fallback before
        // unhooking — otherwise `detach` would settle the promise first and win.
        settle = null;
        detach();
        resolve(extract(msg));
      };
      window.addEventListener('message', handler);
    });
    return { promise, detach };
  }

  async init(): Promise<void> {
    // No initialization needed — the webview is already running
  }

  shutdown(): void {
    // The extension host handles PTY cleanup, but nothing there will answer a
    // command this webview is still holding once it goes away.
    this.remoteHostClient.dispose();
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

  async getOpenPorts(id: string): Promise<OpenPort[]> {
    const result = await this.requestResponse<OpenPort[]>(
      'pty:getOpenPorts', 'pty:openPorts', { id },
      (msg) => msg.ports as OpenPort[],
      OPEN_PORT_TIMEOUT_MS,
    );
    return result ?? [];
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

  openExternal(uri: string): void {
    this.vscode.postMessage({ type: 'dormouse:openExternal', uri });
  }

  runWorkbenchCommand(command: VSCodeWorkbenchCommand): void {
    this.vscode.postMessage({ type: 'dormouse:runWorkbenchCommand', command });
  }

  async agentBrowserCommand(session: string, args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult> {
    const result = await this.requestResponse<AgentBrowserCommandResult>(
      'agentBrowser:command', 'agentBrowser:commandResult', { session, args, binaryPath },
      (msg) => ({ exitCode: msg.exitCode, stdout: msg.stdout, stderr: msg.stderr }),
      10000,
    );
    return result ?? { exitCode: 1, stdout: '', stderr: 'agent-browser command timed out' };
  }

  async agentBrowserEdit(session: string, op: AgentBrowserEditOp, binaryPath?: string): Promise<AgentBrowserEditResult> {
    const result = await this.requestResponse<AgentBrowserEditResult>(
      'agentBrowser:edit', 'agentBrowser:editResult', { session, op, binaryPath },
      (msg) => ({ ok: msg.ok, text: msg.text, error: msg.error }),
      10000,
    );
    return result ?? { ok: false, error: 'agent-browser edit timed out' };
  }

  async agentBrowserScreenshot(session: string, opts: { format?: 'jpeg' | 'png'; quality?: number }, binaryPath?: string): Promise<AgentBrowserScreenshotResult> {
    const result = await this.requestResponse<AgentBrowserScreenshotResult>(
      'agentBrowser:screenshot', 'agentBrowser:screenshotResult',
      { session, format: opts.format, quality: opts.quality, binaryPath },
      (msg) => ({ ok: msg.ok, bytes: msg.bytes, mime: msg.mime, error: msg.error }),
      10000,
    );
    return result ?? { ok: false, error: 'agent-browser screenshot timed out' };
  }

  async agentBrowserStreamStatus(session: string, binaryPath?: string): Promise<AgentBrowserStreamStatusResult> {
    const result = await this.requestResponse<AgentBrowserStreamStatusResult>(
      'agentBrowser:streamStatus', 'agentBrowser:streamStatusResult',
      { session, binaryPath },
      (msg) => ({ ok: msg.ok, wsPort: msg.wsPort, error: msg.error }),
      5000,
    );
    return result ?? { ok: false, error: 'agent-browser stream status timed out' };
  }

  getAgentBrowserStreamUrl(port: number): Promise<string | null> {
    // The agent-browser stream server rejects vscode-webview:// origins, so
    // the extension host relays the stream (see agent-browser-host.ts).
    return this.requestResponse<string | null>(
      'agentBrowser:getStreamUrl', 'agentBrowser:streamUrl', { port },
      (msg) => msg.url,
      5000,
    );
  }

  async agentBrowserOpen(url: string, opts: { headed?: boolean }, binaryPath?: string): Promise<AgentBrowserOpenResult> {
    const result = await this.requestResponse<AgentBrowserOpenResult>(
      'agentBrowser:open', 'agentBrowser:openResult', { url, headed: opts.headed, binaryPath },
      (msg) => ({ ok: msg.ok, session: msg.session, wsPort: msg.wsPort, binaryPath: msg.binaryPath, error: msg.error }),
      15000,
    );
    return result ?? { ok: false, error: 'agent-browser open timed out' };
  }

  async agentBrowserPopOut(session: string, opts: { rect?: { x: number; y: number; width: number; height: number }; url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult> {
    const result = await this.requestResponse<AgentBrowserPopResult>(
      'agentBrowser:popOut', 'agentBrowser:popResult', { session, url: opts.url, rect: opts.rect, binaryPath },
      (msg) => ({ ok: msg.ok, wsPort: msg.wsPort, error: msg.error }),
      15000,
    );
    return result ?? { ok: false, error: 'agent-browser pop-out timed out' };
  }

  async agentBrowserPopIn(session: string, opts: { url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult> {
    const result = await this.requestResponse<AgentBrowserPopResult>(
      'agentBrowser:popIn', 'agentBrowser:popResult', { session, url: opts.url, binaryPath },
      (msg) => ({ ok: msg.ok, wsPort: msg.wsPort, error: msg.error }),
      15000,
    );
    return result ?? { ok: false, error: 'agent-browser pop-in timed out' };
  }

  async createIframeProxyUrl(url: string): Promise<IframeProxyResult> {
    // The extension host stands up the loopback proxy and serves the bytes (see
    // iframe-proxy-host.ts). On timeout, report unreachable so the panel shows a
    // hint rather than hanging on a never-loading frame.
    const result = await this.requestResponse<IframeProxyResult>(
      // The webview's ancestor chain is only knowable here: it decides who may
      // frame the proxy (`lib/src/lib/embedder-origins.ts`).
      'iframe:createProxyUrl', 'iframe:proxyUrl', { url, embedderOrigins: embedderOrigins() },
      (msg) => msg.result,
      5000,
    );
    return result ?? { ok: false, reason: 'unreachable', detail: 'iframe proxy request timed out' };
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
    this.vscode.postMessage({ type: 'dormouse:init' });
    this.pushThemeColors();
  }

  /** Send the resolved terminal theme colors to the extension host so its
   *  parser can answer OSC 10/11/12 color queries (it has no DOM of its own). */
  private pushThemeColors(): void {
    const theme = getTerminalTheme();
    this.vscode.postMessage({
      type: 'dormouse:themeColors',
      foreground: theme.foreground,
      background: theme.background,
      cursor: theme.cursor,
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

  alertSetWatchedCommands(names: string[]): void {
    this.vscode.postMessage({ type: 'alert:initializeWatchedCommands', names });
  }

  alertSetCommandWatched(name: string, watched: boolean): void {
    this.vscode.postMessage({ type: 'alert:setCommandWatched', name, watched });
  }

  alertPublishSettings(settings: AlertSettings, opts: { seed: boolean }): void {
    this.vscode.postMessage({
      type: opts.seed ? 'alert:initializeSettings' : 'alert:updateSettings',
      settings,
    });
  }

  alertDismiss(id: string): void {
    this.vscode.postMessage({ type: 'alert:dismiss', id });
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

  /**
   * The `AlertManager` lives in the extension host, so the wait parks there and
   * only its outcome crosses back. Unlike `requestResponse` this has no local
   * deadline — the ceiling is `timeoutMs`, enforced host-side — and `cancel()`
   * asks rather than answers: the `cancelled` outcome arrives on the same
   * result message as every other, so a claim is never released twice.
   */
  alertAwait(id: string, options: AwaitOptions): AwaitHandle {
    const requestId = `req-${++this.nextRequestId}`;
    const { promise } = this.awaitHostReply('alert:awaitResult', requestId, (msg) => msg.outcome as AwaitOutcome);
    this.vscode.postMessage({ type: 'alert:await', requestId, id, until: options.until, timeoutMs: options.timeoutMs });
    return {
      // Nothing detaches this reply — the host answers exactly one
      // `alert:awaitResult` per request, a cancel included — but the mapping
      // keeps the handle's `AwaitOutcome` contract without a cast.
      promise: promise.then((outcome) => (outcome === DETACHED ? CANCELLED_AWAIT : outcome)),
      cancel: () => this.vscode.postMessage({ type: 'alert:awaitCancel', requestId }),
    };
  }

  onAlertState(handler: (detail: AlertStateDetail) => void): void {
    this.alertStateHandlers.add(handler);
  }

  onWatchedCommands(handler: (names: string[]) => void): void {
    this.watchedCommandHandlers.add(handler);
  }

  onAlertSettings(handler: (settings: AlertSettings) => void): void {
    this.alertSettingsHandlers.add(handler);
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

  /**
   * The recovery commands the extension host captured at its last teardown, from
   * the boot payload. Host-owned and single-use: this is a separate global rather
   * than a field on the persisted session precisely so the webview cannot write it
   * back — a `getState`/`saveState` cycle has nothing to carry forward, so no
   * later restore can replay a stale invocation
   * (docs/specs/transport.md -> "Consuming it").
   */
  getRecoveryCommands(): Record<string, string> {
    return readInjectedRecoveryCommands();
  }
}
