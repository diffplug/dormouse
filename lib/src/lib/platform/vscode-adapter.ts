import { PLAYWRIGHT_REQUEST_TIMEOUT_MS, type PlaywrightRequest, type PlaywrightResult } from './browser-automation';
import { recordToolEvents } from '../tool-events';
import type { TerminalContextRequest, TerminalContextInfo } from '../terminal-context-types';
import type { AgentBrowserCommandResult, AgentBrowserEditOp, AgentBrowserEditResult, AgentBrowserOpenResult, AgentBrowserPopResult, AgentBrowserScreenshotResult, AgentBrowserStreamStatusResult, IframeProxyResult, OpenPort, PlatformAdapter, PtyDataDetail, PtyInfo, BurrowLink, SpawnPtyOptions, ToolControlResult, ToolHostRequest, WritePtyOptions } from './types';
import { openPortRequestTimeoutMs } from './types';
import { createBurrowLinkClient } from '../../host/remote/link-client';
import { createAlertClient, type AlertClientMethods } from '../../host/alert-client';
import { isAlertEvent } from '../../host/alert-protocol';
import type {
  NotepadArchiveLoadResult,
  NotepadArchivePort,
  NotepadArchiveV1,
  VolatileNotepadSnapshot,
} from '../notepad/types';
import { readInjectedRecoveryCommands } from '../vscode-recovery-global';
import { readInjectedVolatileNotepad } from '../vscode-notepad-global';
import { setDefaultShellOpts } from '../shell-defaults';
import { embedderOrigins } from '../embedder-origins';
import {
  applyTerminalSemanticEvents,
} from '../terminal-state-store';
import { getTerminalTheme, onTerminalThemeChange } from '../terminal-theme';
import { HOST_MESSAGE_TOKEN_FIELD, isHostMessage, readHostMessageToken } from '../vscode-message-token';
import { parseReplay } from './replay-parse';
import { cancelDorControlRequest, dispatchDorControlRequest } from './dor-control-dispatch';
import type { VSCodeWorkbenchCommand } from '../vscode-keybindings';

/**
 * What `awaitHostReply` settles with when its caller's own deadline fired and
 * the listener was detached. A distinct sentinel rather than `null`, so a host
 * reply whose extracted value is legitimately `null` stays distinguishable from
 * "no reply came".
 */
const DETACHED = Symbol('detached');

/** The `alert*` platform methods, taken from the shared client in the constructor. */
export interface VSCodeAdapter extends AlertClientMethods {}

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
  // The alerts live in the extension host (`lib/src/host/alert-host.ts`); this
  // webview is one of their viewers, through the client every host shares.
  private readonly alerts = createAlertClient((command) => this.vscode.postMessage({ type: 'alert:command', command }));
  // --- Remote host bridge (docs/specs/remote-api.md) ---
  //
  // The Burrow lives in the extension host, next to the PTYs, in whichever VS
  // Code window won the bind-as-lease. This webview forwards its console
  // commands, answers what only it knows (pane names, xterm sizes), and mirrors
  // the pairing queue. Everything but the three postMessage shapes below is the
  // shared client's (lib/src/host/remote/link-client.ts).
  private readonly burrowClient = createBurrowLinkClient({
    sendCommand: (payload) => this.vscode.postMessage({ type: 'burrow:command', payload }),
    // An ask arrives as `peer:ask` and is answered on the same pair, which the
    // extension host's fan-out settles by `requestId`.
    answerAsk: (requestId, results) =>
      this.vscode.postMessage({ type: 'peer:answer', requestId, results }),
    notify: () => this.vscode.postMessage({ type: 'peer:notify' }),
  });

  readonly burrow: BurrowLink = this.burrowClient.link;

  /**
   * The mirror this webview booted with, consumed once by `loadVolatile()`.
   * Captured at construction like every other boot global, so a later
   * same-document write cannot move the goalposts.
   */
  private bootNotepadVolatile: VolatileNotepadSnapshot | null = readInjectedVolatileNotepad();

  /**
   * The archive lives in the extension host's `globalState` — nothing in the
   * webview can reach it — so every call is a request/response round trip
   * (docs/specs/notepad.md). The port is compare-and-swap: this side only ships
   * bytes and the revision it read them at, and the shared service retries a
   * `'conflict'`, so a second webview's concurrent append is never lost.
   */
  readonly notepadArchive: NotepadArchivePort = {
    load: () => this.notepadRequest<NotepadArchiveLoadResult | null>('notepad:load', {}),
    save: (archive: NotepadArchiveV1, baseRevision: string | null) =>
      this.notepadRequest<'ok' | 'conflict'>('notepad:save', {
        state: JSON.stringify(archive),
        baseRevision,
      }),
    resetUnreadable: async () => {
      await this.notepadRequest<void>('notepad:reset', {});
    },
    // Fire and forget: nothing waits on the mirror, and the next snapshot
    // supersedes this one. It is what lets a teardown archive notes from a
    // webview VS Code has already destroyed.
    syncVolatile: (snapshot: VolatileNotepadSnapshot) => {
      this.vscode.postMessage({ type: 'notepad:volatile', snapshot });
    },
    // Exactly once: a second read is a cold restore's read, and a cold restore
    // must never hydrate live notes (docs/specs/notepad.md).
    loadVolatile: () => {
      const snapshot = this.bootNotepadVolatile;
      this.bootNotepadVolatile = null;
      return snapshot;
    },
  };

  constructor() {
    this.vscode = acquireVsCodeApi();
    Object.assign(this, this.alerts.methods);

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
        // The replay report filter catches the reply a declined colour query
        // provokes — a backstop, not the contract.
        const data = parseReplay(msg.id, msg.data);
        for (const handler of this.replayHandlers) {
          handler({ id: msg.id, data });
        }
      } else if (msg.type === 'terminal:toolEvents') {
        recordToolEvents(msg.id, msg.events ?? []);
      } else if (msg.type === 'terminal:semanticEvents') {
        applyTerminalSemanticEvents(msg.id, msg.events ?? []);
      } else if (msg.type === 'dormouse:flushSessionSave') {
        for (const handler of this.flushRequestHandlers) {
          handler({ requestId: msg.requestId });
        }
      } else if (isAlertEvent(msg.type)) {
        const { type, [HOST_MESSAGE_TOKEN_FIELD]: _token, ...data } = msg;
        this.alerts.onEvent(type, data);
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
        this.burrowClient.onAsk(msg.requestId, msg.op, msg.params);
      } else if (msg.type === 'burrow:result') {
        this.burrowClient.onResult(msg.payload);
      } else if (msg.type === 'burrow:event') {
        this.burrowClient.onEvent(msg.payload);
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
   * One archive round trip. Unlike `requestResponse` this *rejects* rather than
   * resolving `null`: a `null` load legitimately means "nothing archived yet", so
   * a timeout that looked like one would let the next save overwrite an archive
   * nobody managed to read. The shared service turns a rejection into the
   * unavailable/closure-failure paths (docs/specs/notepad.md → Archive).
   */
  private async notepadRequest<T>(
    type: 'notepad:load' | 'notepad:save' | 'notepad:reset',
    data: Record<string, unknown>,
  ): Promise<T> {
    // The reply object is never `null` on its own, so `requestResponse`'s `null`
    // here can only be its timeout.
    const reply = await this.requestResponse<{ ok: boolean; result?: unknown; error?: string }>(
      type, 'notepad:result', data, (msg) => msg, 5000,
    );
    if (!reply) throw new Error(`${type} timed out`);
    if (!reply.ok) throw new Error(reply.error || `${type} failed`);
    return reply.result as T;
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
    // command or an await this webview is still holding once it goes away.
    this.burrowClient.dispose();
    this.alerts.dispose();
  }

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    const result = await this.requestResponse(
      'pty:getShells', 'pty:shells', {},
      (msg) => msg.shells as { name: string; path: string; args?: string[] }[],
      5000,
    );
    return result ?? [];
  }

  async terminalContext(request: TerminalContextRequest): Promise<TerminalContextInfo> {
    const result = await this.requestResponse('pty:context', 'pty:contextResult', { request }, (msg) => msg.result);
    if (result.error) throw new Error(result.error);
    return result;
  }

  spawnPty(id: string, options?: SpawnPtyOptions): void {
    this.vscode.postMessage({ type: 'pty:spawn', id, options });
  }

  writePty(id: string, data: string, options?: WritePtyOptions): void {
    this.vscode.postMessage({ type: 'pty:input', id, data, paced: options?.paced, userInput: options?.userInput });
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
      openPortRequestTimeoutMs(1, 2),
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

  async playwright(request: PlaywrightRequest): Promise<PlaywrightResult> {
    return await this.requestResponse<PlaywrightResult>(
      'playwright:request', 'playwright:result', { request }, msg => msg.result, PLAYWRIGHT_REQUEST_TIMEOUT_MS,
    ) ?? { ok: false, error: 'Playwright host timed out' };
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

  async toolControl(request: ToolHostRequest): Promise<ToolControlResult> {
    // The extension host owns the filesystem (vscode-ext/src/tool-host.ts). A
    // timeout reports an error rather than hanging `dor tool`, which blocks on it.
    const result = await this.requestResponse<ToolControlResult>(
      'tool:control', 'tool:result', { request },
      (msg) => msg.result,
      5000,
    );
    return result ?? { status: 'error', message: 'tool request timed out' };
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
