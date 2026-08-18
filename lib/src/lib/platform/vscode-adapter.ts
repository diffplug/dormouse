import type { AgentBrowserCommandResult, AgentBrowserEditOp, AgentBrowserEditResult, AgentBrowserOpenResult, AgentBrowserPopResult, AgentBrowserScreenshotResult, AgentBrowserStreamStatusResult, AlertStateDetail, IframeProxyResult, OpenPort, PlatformAdapter, PtyInfo } from './types';
import { OPEN_PORT_TIMEOUT_MS } from './types';
import type { AlertSettings } from '../alert-settings';
import { readInjectedRecoveryCommands } from '../vscode-recovery-global';
import { setDefaultShellOpts } from '../shell-defaults';
import {
  collectTerminalSemanticEvents,
  TerminalProtocolParser,
} from '../terminal-protocol';
import {
  applyTerminalSemanticEventsByPtyId,
} from '../terminal-state-store';
import { getTerminalTheme, onTerminalThemeChange } from '../terminal-theme';
import { isHostMessage, readHostMessageToken } from '../vscode-message-token';
import type { DorControlResult } from 'dor/protocol';
import type { VSCodeWorkbenchCommand } from '../vscode-keybindings';
import type { PeerBridge } from './types';
import { PEER_REQUEST_TIMEOUT_MS } from '../vscode-peer-link-protocol';
import { setJsonStoreBackend } from '../local-json-store';

/**
 * Budget for the boot-time host-store read. Generous because it is gated on an
 * OS keychain unlock, and a miss degrades the Host to "un-enrolled" rather than
 * failing loudly.
 */
const HOST_STORE_READ_TIMEOUT_MS = 10_000;



export class VSCodeAdapter implements PlatformAdapter {
  private vscode: ReturnType<typeof acquireVsCodeApi>;
  private hostState: unknown = (globalThis as typeof globalThis & { __DORMOUSE_HOST_STATE__?: unknown }).__DORMOUSE_HOST_STATE__ ?? null;
  // Captured once, at construction, from the global the extension host injects
  // at webview boot — so a later same-document write can't move the goalposts.
  // Every `message` listener below checks it before reading anything else.
  private readonly hostMessageToken = readHostMessageToken();
  private dataHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  private replayHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private flushRequestHandlers = new Set<(detail: { requestId: string }) => void>();
  private alertStateHandlers = new Set<(detail: AlertStateDetail) => void>();
  private watchedCommandHandlers = new Set<(names: string[]) => void>();
  private alertSettingsHandlers = new Set<(settings: AlertSettings) => void>();
  private singletonHandlers = new Map<string, (held: boolean) => void>();
  /** Hydrated host-store caches, by claimed prefix — see `hydrateScopedStore`. */
  private scopedCaches = new Map<string, Map<string, string>>();
  /**
   * Broadcasts that landed before their prefix finished hydrating. The read is
   * gated on a keychain unlock, so this window is wide enough to matter: the
   * host snapshots `globalState` before that wait, so another webview can
   * commit a change that the in-flight snapshot will not contain. Carries the
   * value, not just the key, because a deletion has to survive too.
   */
  private pendingStoreChanges = new Map<string, string | null>();

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
        const respond = (response: DorControlResult) => {
          this.vscode.postMessage({
            type: 'dor:controlResponse',
            requestId: msg.requestId,
            ...response,
          });
        };

        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            requestId: msg.requestId,
            surfaceId: msg.surfaceId,
            method: msg.method,
            params: msg.params ?? {},
            respond,
          },
        }));
      } else if (msg.type === 'singleton:lease') {
        this.singletonHandlers.get(msg.name)?.(!!msg.held);
      } else if (msg.type === 'store:changed') {
        this.applyStoreChange(msg.key, msg.value ?? null);
      } else if (msg.type === 'peer:ask') {
        // Answer even with no responder installed, and even to say nothing: the
        // broker settles once every webview has replied, so silence would make
        // it wait out the full budget on what is usually a miss. An empty
        // answer claims nothing, so it can never beat the real owner.
        this.vscode.postMessage({
          type: 'peer:answer',
          requestId: msg.requestId,
          results: this.peerResponders.get(msg.op)?.(msg.params) ?? [],
        });
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
        // Same guard as the main listener: a request/response reply carries
        // host-supplied data (a proxy URL, scrollback, clipboard contents), and
        // a forged one racing the real reply would win on first match.
        if (!isHostMessage(event.data, this.hostMessageToken)) return;
        const msg = event.data;
        if (msg.type === responseType && msg.requestId === requestId) {
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

  /**
   * Elect among, and reach terminals owned by, sibling webviews — both brokered
   * by the extension host (docs/specs/vscode.md → "Peer surfaces"). Present
   * unconditionally: every webview both asks (when it is the Host) and answers
   * (for its own panes).
   */
  readonly peers: PeerBridge = {
    /**
     * Ask the extension host for a named single-instance role and report every
     * grant/revoke. The extension host is the arbiter because it is the only
     * thing that outlives and sees all of this window's webviews; it re-offers
     * the role when the holder is disposed, so closing the Dormouse view hands
     * the Host to another open one rather than dropping it until reload.
     */
    claimSingleton: (name, onChange) => {
      // One entry per role, dispatched from the constructor's authenticated
      // listener: re-claiming (a React effect remounting, StrictMode's double
      // mount) replaces the handler instead of stacking another listener on the
      // busiest message path in the app.
      this.singletonHandlers.set(name, onChange);
      this.vscode.postMessage({ type: 'singleton:claim', name });
    },
    request: async (op, params) => {
      const results = await this.requestResponse(
        'peer:request',
        'peer:results',
        { op, params },
        (msg) => msg.results as unknown[],
        PEER_REQUEST_TIMEOUT_MS,
      );
      // A timeout reads as "nobody answered", which is what a miss looks like
      // anyway — the caller has no repair to make either way.
      return results ?? [];
    },
    respond: (op, handler) => {
      this.peerResponders.set(op, handler);
    },
    streamPty: (ptyId) => {
      this.vscode.postMessage({ type: 'pty:subscribe', id: ptyId });
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        this.vscode.postMessage({ type: 'pty:unsubscribe', id: ptyId });
      };
    },
  };

  private peerResponders = new Map<string, (params: unknown) => unknown[]>();

  /**
   * Pull every `prefix`-scoped value out of extension-host storage and install
   * a synchronous, write-through backend over it (docs/specs/vscode.md →
   * "Remote Host: store and lease"). Webview `localStorage` is not the VS Code persistence story, and
   * the remote Host's enrollment carries a bearer credential that belongs in
   * `SecretStorage`, so the store has to live on the other side of the message
   * boundary. A failed read installs an empty cache rather than throwing: the
   * Host then behaves as un-enrolled instead of blocking webview boot.
   */
  async hydrateScopedStore(prefix: string): Promise<void> {
    // The host answers only after reading `SecretStorage`, which on a cold OS
    // keychain (or a locked libsecret) can take well over the default second.
    // `requestResponse` resolves `null` on timeout rather than rejecting, so a
    // too-short budget silently installs an empty cache and the Host reads as
    // un-enrolled — indistinguishable from never having enrolled.
    const entries = await this.requestResponse(
      'store:read',
      'store:entries',
      { prefix },
      (msg) => msg.entries as Record<string, string>,
      HOST_STORE_READ_TIMEOUT_MS,
    );
    if (entries === null) {
      console.warn(
        `[dormouse] host store "${prefix}" did not answer in ${HOST_STORE_READ_TIMEOUT_MS}ms; ` +
          'continuing without it. A remote Host enrollment will read as absent.',
      );
    }
    const cache = new Map(Object.entries(entries ?? {}));
    // Anything committed while the read was in flight is newer than the
    // snapshot, so it is applied on top of it before the cache goes live.
    for (const [key, pending] of this.pendingStoreChanges) {
      if (!key.startsWith(prefix)) continue;
      if (pending === null) cache.delete(key);
      else cache.set(key, pending);
      this.pendingStoreChanges.delete(key);
    }
    this.scopedCaches.set(prefix, cache);
    setJsonStoreBackend(prefix, {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => {
        cache.set(key, value);
        this.vscode.postMessage({ type: 'store:write', key, value });
      },
      removeItem: (key) => {
        cache.delete(key);
        this.vscode.postMessage({ type: 'store:write', key, value: null });
      },
    });
  }

  /**
   * Apply another webview's committed write to this one's cache. Without it a
   * webview serves reads from its boot-time snapshot forever, and — because the
   * lease can hand it the Host later — would start from that snapshot and write
   * it back, dropping every pairing the previous holder approved.
   */
  private applyStoreChange(key: string, value: string | null): void {
    for (const [prefix, cache] of this.scopedCaches) {
      if (!key.startsWith(prefix)) continue;
      if (value === null) cache.delete(key);
      else cache.set(key, value);
      return;
    }
    // No cache holds this key yet: either its prefix is still hydrating (buffer
    // it — `hydrateScopedStore` drains it) or nothing here claimed the prefix,
    // in which case the entry is inert.
    this.pendingStoreChanges.set(key, value);
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
      'iframe:createProxyUrl', 'iframe:proxyUrl', { url },
      (msg) => msg.result,
      5000,
    );
    return result ?? { ok: false, reason: 'unreachable', detail: 'iframe proxy request timed out' };
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
