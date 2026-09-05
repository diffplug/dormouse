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
import {
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  TerminalProtocolParser,
  type TerminalProtocolEvent,
} from "dormouse-lib/lib/terminal-protocol";
import { getTerminalTheme, onTerminalThemeChange, themeColorProvider } from "dormouse-lib/lib/terminal-theme";
import type { TerminalSemanticEvent } from "dormouse-lib/lib/terminal-state";
import { applyTerminalSemanticEventsByPtyId } from "dormouse-lib/lib/terminal-state-store";
import type { DorControlCancelPayload, DorControlRequestPayload } from "dor/protocol";
import {
  cancelDorControlRequest,
  dispatchDorControlRequest,
} from "dormouse-lib/lib/platform/dor-control-dispatch";
import { BrowserSidecarHost } from "./browser-sidecar-host";

const errMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class BrowserSidecarAdapter implements PlatformAdapter {
  private dataHandlers = new Set<(detail: PtyDataDetail) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  private replayHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private alertStateHandlers = new Set<(detail: AlertStateDetail) => void>();
  private alertManager = new AlertManager();
  private unlistenHost: (() => void) | null = null;
  // Remote-host bridge, identical in shape to TauriAdapter's — the dev harness
  // forwards the same `burrow:*` messages over its own transport.
  private readonly burrowClient = createBurrowLinkClient({
    sendCommand: (command) => this.sendBurrowCommand(command),
    answerAsk: (askId, results) => this.sendBurrowCommand(answerAskCommand(askId, results)),
    notify: () => this.sendBurrowCommand(notifyCommand()),
  });

  readonly burrow: BurrowLink = this.burrowClient.link;

  constructor(private readonly host: BrowserSidecarHost) {
    this.alertManager.onStateChange((id, state) => {
      for (const handler of this.alertStateHandlers) handler({ id, ...state });
    });

    // See TauriAdapter: the sidecar parses and has no DOM, so it is told the
    // resolved terminal colors whenever they change.
    onTerminalThemeChange(() => this.pushThemeColors());

    // Some of these get called through detached references (e.g. the iframe
    // panel does `const createProxy = getPlatform().createIframeProxyUrl`), which
    // drops `this` and makes the internal `this.host` access throw. The VS Code
    // adapter binds for the same reason; mirror it so any call style is safe.
    this.createIframeProxyUrl = this.createIframeProxyUrl.bind(this);
    this.agentBrowserCommand = this.agentBrowserCommand.bind(this);
    this.agentBrowserEdit = this.agentBrowserEdit.bind(this);
    this.agentBrowserScreenshot = this.agentBrowserScreenshot.bind(this);
    this.agentBrowserStreamStatus = this.agentBrowserStreamStatus.bind(this);
    this.agentBrowserOpen = this.agentBrowserOpen.bind(this);
    this.agentBrowserPopOut = this.agentBrowserPopOut.bind(this);
    this.agentBrowserPopIn = this.agentBrowserPopIn.bind(this);
  }

  async init(): Promise<void> {
    this.clearPersistedState();
    await this.host.init();
    this.unlistenHost = this.host.onEvent(({ event, data }) => this.handleHostEvent(event, data));
    this.installConsoleForwarder();
  }

  shutdown(): void {
    this.alertManager.dispose();
    this.unlistenHost?.();
    this.unlistenHost = null;
    this.burrowClient.dispose();
    this.host.send("kill_sidecar_now");
    this.host.close();
  }

  private sendBurrowCommand(command: BurrowCommand): void {
    this.host.send("burrow_command", { payload: command });
  }

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    try {
      return await this.host.invoke("get_available_shells");
    } catch {
      return [];
    }
  }

  spawnPty(id: string, options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] }): void {
    this.host.send("pty_spawn", { id, options });
  }

  writePty(id: string, data: string): void {
    this.host.send("pty_write", { id, data });
  }

  resizePty(id: string, cols: number, rows: number): void {
    this.host.send("pty_resize", { id, cols, rows });
  }

  killPty(id: string): void {
    this.host.send("pty_kill", { id });
  }

  async getCwd(id: string): Promise<string | null> {
    try { return await this.host.invoke("pty_get_cwd", { id }); } catch { return null; }
  }

  async getOpenPorts(id: string): Promise<OpenPort[]> {
    try { return await this.host.invoke("pty_get_open_ports", { id }); } catch { return []; }
  }

  async readClipboardFilePaths(): Promise<string[] | null> {
    try { return await this.host.invoke("read_clipboard_file_paths"); } catch { return null; }
  }

  async readClipboardImageAsFilePath(): Promise<string | null> {
    try { return await this.host.invoke("read_clipboard_image_as_file_path"); } catch { return null; }
  }

  async readClipboardText(): Promise<string | null> {
    try { return await this.host.invoke("read_clipboard_text"); } catch { return null; }
  }

  async createIframeProxyUrl(targetUrl: string): Promise<IframeProxyResult> {
    try {
      return await this.host.invoke("iframe_create_proxy_url", {
        target: targetUrl,
        embedderOrigins: embedderOrigins(),
      });
    } catch (err) {
      return { ok: false, reason: "unreachable", detail: errMessage(err) };
    }
  }

  async agentBrowserCommand(session: string, args: string[], binaryPath?: string): Promise<AgentBrowserCommandResult> {
    try { return await this.host.invoke("agent_browser_command", { session, args, binaryPath }); }
    catch (err) { return { exitCode: 1, stdout: "", stderr: errMessage(err) }; }
  }

  async agentBrowserEdit(session: string, op: AgentBrowserEditOp, binaryPath?: string): Promise<AgentBrowserEditResult> {
    try { return await this.host.invoke("agent_browser_edit", { session, op, binaryPath }); }
    catch (err) { return { ok: false, error: errMessage(err) }; }
  }

  async agentBrowserScreenshot(session: string, opts: { format?: "jpeg" | "png"; quality?: number }, binaryPath?: string): Promise<AgentBrowserScreenshotResult> {
    try {
      const result = await this.host.invoke<{ ok: true; mime?: string; bytesBase64: string } | { ok: false; error?: string }>(
        "agent_browser_screenshot",
        { session, format: opts.format, quality: opts.quality, binaryPath },
      );
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, bytes: decodeBase64Bytes(result.bytesBase64), mime: result.mime ?? (opts.format === "png" ? "image/png" : "image/jpeg") };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  async agentBrowserStreamStatus(session: string, binaryPath?: string): Promise<AgentBrowserStreamStatusResult> {
    try { return await this.host.invoke("agent_browser_stream_status", { session, binaryPath }); }
    catch (err) { return { ok: false, error: errMessage(err) }; }
  }

  async agentBrowserOpen(url: string, opts: { headed?: boolean }, binaryPath?: string): Promise<AgentBrowserOpenResult> {
    try { return await this.host.invoke("agent_browser_open", { url, headed: opts.headed, binaryPath }); }
    catch (err) { return { ok: false, error: errMessage(err) }; }
  }

  async agentBrowserPopOut(session: string, opts: { rect?: { x: number; y: number; width: number; height: number }; url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult> {
    try { return await this.host.invoke("agent_browser_pop_out", { session, url: opts.url, rect: opts.rect, binaryPath }); }
    catch (err) { return { ok: false, error: errMessage(err) }; }
  }

  async agentBrowserPopIn(session: string, opts: { url?: string }, binaryPath?: string): Promise<AgentBrowserPopResult> {
    try { return await this.host.invoke("agent_browser_pop_in", { session, url: opts.url, binaryPath }); }
    catch (err) { return { ok: false, error: errMessage(err) }; }
  }

  openExternal(uri: string): void {
    const normalized = normalizeExternalUri(uri);
    if (normalized) window.open(normalized, "_blank", "noopener,noreferrer");
  }

  // No `onFilesDropped`: the optional member is a capability probe for adapters
  // with a native (non-DOM) drag-drop source (PlatformAdapter in
  // dormouse-lib/lib/platform/types). This harness runs in a plain browser tab,
  // where a drop yields `File` objects and no host paths, so there is nothing to
  // report. Implementing it would claim the capability and never fire.

  onPtyData(handler: (detail: PtyDataDetail) => void): void { this.dataHandlers.add(handler); }
  offPtyData(handler: (detail: PtyDataDetail) => void): void { this.dataHandlers.delete(handler); }
  onPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void { this.exitHandlers.add(handler); }
  offPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void { this.exitHandlers.delete(handler); }
  requestInit(): void {
    this.host.send("pty_request_init");
    this.pushThemeColors();
  }
  onPtyList(handler: (detail: { ptys: PtyInfo[] }) => void): void { this.listHandlers.add(handler); }
  offPtyList(handler: (detail: { ptys: PtyInfo[] }) => void): void { this.listHandlers.delete(handler); }
  onPtyReplay(handler: (detail: { id: string; data: string }) => void): void { this.replayHandlers.add(handler); }
  offPtyReplay(handler: (detail: { id: string; data: string }) => void): void { this.replayHandlers.delete(handler); }
  onRequestSessionFlush(_handler: (detail: { requestId: string }) => void): void {}
  offRequestSessionFlush(_handler: (detail: { requestId: string }) => void): void {}
  notifySessionFlushComplete(_requestId: string): void {}

  alertRemove(id: string): void { this.alertManager.remove(id); }
  alertSetWatchedCommands(names: string[]): void { this.alertManager.setWatchedCommands(names); }
  alertSetCommandWatched(name: string, watched: boolean): void { this.alertManager.setCommandWatched(name, watched); }
  alertPublishSettings(settings: AlertSettings): void { this.alertManager.applySettings(settings); }
  alertDismiss(id: string): void { this.alertManager.dismissAlert(id); }
  alertAttend(id: string): void { this.alertManager.attend(id); }
  alertResize(id: string): void { this.alertManager.onResize(id); }
  alertClearAttention(id?: string): void { this.alertManager.clearAttention(id); }
  alertToggleTodo(id: string): void { this.alertManager.toggleTodo(id); }
  alertMarkTodo(id: string): void { this.alertManager.markTodo(id); }
  alertClearTodo(id: string): void { this.alertManager.clearTodo(id); }
  alertAwait(id: string, options: AwaitOptions): AwaitHandle { return this.alertManager.awaitCompletion(id, options); }
  onAlertState(handler: (detail: AlertStateDetail) => void): void { this.alertStateHandlers.add(handler); }
  // See TauriAdapter: single webview, so nothing is broadcast back.
  onWatchedCommands(_handler: (names: string[]) => void): void {}
  onAlertSettings(_handler: (settings: AlertSettings) => void): void {}

  private static STATE_KEY = 'dormouse.browser-sidecar.session';

  // Mirrors TauriAdapter's gate (docs/specs/standalone.md -> "Standalone persists
  // no Session state"); flip both flags together.
  private static PERSIST_SESSION = false;

  readonly persistsSession = BrowserSidecarAdapter.PERSIST_SESSION;

  // See TauriAdapter: PersistedWindow when the workspaces flag is on, bare
  // PersistedSession when off; the helpers own the translation + JSON/storage
  // plumbing (docs/specs/transport.md).
  saveState(state: unknown): void {
    if (!BrowserSidecarAdapter.PERSIST_SESSION) return;
    try { saveSessionState(localStorage, BrowserSidecarAdapter.STATE_KEY, state); }
    catch { console.error('[browser-sidecar] Failed to save session state'); }
  }

  getState(): unknown {
    if (!BrowserSidecarAdapter.PERSIST_SESSION) return null;
    try {
      return loadSessionState(localStorage, BrowserSidecarAdapter.STATE_KEY);
    } catch {
      return null;
    }
  }

  // Delete (not just ignore) pre-gate blobs: they carry transcripts and localStorage
  // outlives the harness's per-run temp state dir.
  private clearPersistedState(): void {
    if (BrowserSidecarAdapter.PERSIST_SESSION) return;
    try { localStorage.removeItem(BrowserSidecarAdapter.STATE_KEY); }
    catch { /* private-mode storage: nothing to clear */ }
  }

  private handleHostEvent(event: string, data: unknown): void {
    if (event === "pty:data") {
      // Already parsed by the sidecar, which owns the PTY; its events arrive as
      // the two messages below (docs/specs/terminal-escapes.md).
      const payload = data as PtyDataDetail;
      this.alertManager.onData(payload.id);
      for (const handler of this.dataHandlers) handler(payload);
    } else if (event === "terminal:protocolEvents") {
      const payload = data as { id: string; events: TerminalProtocolEvent[] };
      applyTerminalProtocolEvents(this.alertManager, payload.id, payload.events);
    } else if (event === "terminal:semanticEvents") {
      const { id, events } = data as { id: string; events: TerminalSemanticEvent[] };
      this.alertManager.applyTerminalSemanticEvents(id, events);
      applyTerminalSemanticEventsByPtyId(id, events);
    } else if (event === "pty:exit") {
      const payload = data as { id: string; exitCode: number };
      this.alertManager.onExit(payload.id, payload.exitCode);
      for (const handler of this.exitHandlers) handler(payload);
    } else if (event === "pty:list") {
      for (const handler of this.listHandlers) handler(data as { ptys: PtyInfo[] });
    } else if (event === "pty:replay") {
      // The one stream the sidecar does not parse; see TauriAdapter, including
      // why the one-shot parser still needs the theme.
      const { id, data: text } = data as { id: string; data: string };
      const parsed = new TerminalProtocolParser(themeColorProvider).process(text);
      applyTerminalSemanticEventsByPtyId(id, collectTerminalSemanticEvents(parsed.events));
      for (const handler of this.replayHandlers) handler({ id, data: parsed.visibleData });
    } else if (event === BURROW_RESULT_EVENT) {
      this.burrowClient.onResult(data as BurrowResult);
    } else if (event === BURROW_ASK_EVENT) {
      const ask = data as BurrowAsk;
      this.burrowClient.onAsk(ask.burrowRequestId, ask.op, ask.params);
    } else if (event === BURROW_EVENT_EVENT) {
      this.burrowClient.onEvent(data);
    } else if (event === "dor:controlRequest") {
      const payload = data as DorControlRequestPayload;
      dispatchDorControlRequest(payload, (response) => {
        this.host.send("dor_control_response", { response: { requestId: payload.requestId, ...response } });
      });
    } else if (event === "dor:controlCancel") {
      // The sidecar's control server gave up on the request: the `dor` client
      // hung up, or its own deadline fired.
      cancelDorControlRequest((data as DorControlCancelPayload).requestId);
    }
  }

  /** See TauriAdapter.pushThemeColors: the sidecar's parser answers OSC 10/11/12. */
  private pushThemeColors(): void {
    const theme = getTerminalTheme();
    this.host.send("pty_theme_colors", {
      colors: {
        foreground: theme.foreground,
        background: theme.background,
        cursor: theme.cursor,
      },
    });
  }

  private installConsoleForwarder(): void {
    const patched = window as typeof window & { __DORMOUSE_BROWSER_CONSOLE_PATCHED__?: boolean };
    if (patched.__DORMOUSE_BROWSER_CONSOLE_PATCHED__) return;
    patched.__DORMOUSE_BROWSER_CONSOLE_PATCHED__ = true;
    for (const level of ["log", "warn", "error"] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        fetch(this.host.url('/__dormouse_dev_host/console'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level, args: args.map((arg) => {
            try { return typeof arg === 'string' ? arg : JSON.stringify(arg); }
            catch { return String(arg); }
          }) }),
        }).catch(() => {});
      };
    }
  }

}
