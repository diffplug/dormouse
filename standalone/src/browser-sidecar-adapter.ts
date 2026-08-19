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
  RemoteHostLink,
} from "dormouse-lib/lib/platform/types";
import {
  REMOTE_HOST_ASK_EVENT,
  REMOTE_HOST_EVENT_EVENT,
  REMOTE_HOST_RESULT_EVENT,
  type RemoteHostAsk,
  type RemoteHostCommand,
  type RemoteHostResult,
} from "dormouse-lib/host/remote/service-protocol";
import { AlertManager } from "dormouse-lib/lib/alert-manager";
import type { AlertSettings } from "dormouse-lib/lib/alert-settings";
import { normalizeExternalUri } from "dormouse-lib/lib/external-links";
import { loadSessionState, saveSessionState } from "dormouse-lib/lib/window-persistence";
import {
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  collectTerminalProtocolResponses,
  TerminalProtocolParser,
} from "dormouse-lib/lib/terminal-protocol";
import { themeColorProvider } from "dormouse-lib/lib/terminal-theme";
import { applyTerminalSemanticEventsByPtyId } from "dormouse-lib/lib/terminal-state-store";
import type { DorControlRequestPayload, DorControlResult } from "dor/protocol";
import { BrowserSidecarHost } from "./browser-sidecar-host";

const errMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** Mirrors the Tauri adapter's bound; `enroll` makes an HTTP round trip. */
const REMOTE_HOST_COMMAND_TIMEOUT_MS = 15_000;

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class BrowserSidecarAdapter implements PlatformAdapter {
  private dataHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  private replayHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private filesDroppedHandlers = new Set<(paths: string[]) => void>();
  private alertStateHandlers = new Set<(detail: AlertStateDetail) => void>();
  private protocolParsers = new Map<string, TerminalProtocolParser>();
  private alertManager = new AlertManager();
  private unlistenHost: (() => void) | null = null;
  // Remote-host bridge, identical in shape to TauriAdapter's — the dev harness
  // forwards the same `remoteHost:*` messages over its own transport.
  private remoteHostPending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private remoteHostResponders = new Map<string, (params: unknown) => unknown[]>();
  private remoteHostListeners = new Map<string, Set<(data: unknown) => void>>();
  private nextRemoteHostId = 0;

  constructor(private readonly host: BrowserSidecarHost) {
    this.alertManager.onStateChange((id, state) => {
      for (const handler of this.alertStateHandlers) handler({ id, ...state });
    });

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
    await this.host.init();
    this.unlistenHost = this.host.onEvent(({ event, data }) => this.handleHostEvent(event, data));
    this.installConsoleForwarder();
  }

  shutdown(): void {
    this.alertManager.dispose();
    this.protocolParsers.clear();
    this.unlistenHost?.();
    this.unlistenHost = null;
    for (const pending of this.remoteHostPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("remote host bridge closed"));
    }
    this.remoteHostPending.clear();
    this.host.send("kill_sidecar_now");
    this.host.close();
  }

  // --- Remote host bridge (see TauriAdapter for the contract) ---

  readonly remoteHost: RemoteHostLink = {
    command: (cmd, params) => this.remoteHostCommand(cmd, params),
    respond: (op, handler) => {
      this.remoteHostResponders.set(op, handler);
    },
    notify: (topic) => {
      this.sendRemoteHostCommand({ rhId: this.nextRhId(), cmd: "notify", params: { topic } });
    },
    on: (name, listener) => {
      let listeners = this.remoteHostListeners.get(name);
      if (!listeners) {
        listeners = new Set();
        this.remoteHostListeners.set(name, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  private nextRhId(): string {
    return `rh-${++this.nextRemoteHostId}`;
  }

  private sendRemoteHostCommand(command: RemoteHostCommand): void {
    this.host.send("remote_host_command", { payload: command });
  }

  private remoteHostCommand(cmd: string, params?: unknown): Promise<unknown> {
    const rhId = this.nextRhId();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remoteHostPending.delete(rhId);
        reject(new Error(`remote host command timed out: ${cmd}`));
      }, REMOTE_HOST_COMMAND_TIMEOUT_MS);
      this.remoteHostPending.set(rhId, { resolve, reject, timer });
      this.sendRemoteHostCommand({ rhId, cmd, params });
    });
  }

  private settleRemoteHostCommand(result: RemoteHostResult): void {
    const pending = this.remoteHostPending.get(result?.rhId);
    if (!pending) return;
    this.remoteHostPending.delete(result.rhId);
    clearTimeout(pending.timer);
    if (typeof result.error === "string") pending.reject(new Error(result.error));
    else pending.resolve(result.result);
  }

  private answerRemoteHostAsk(ask: RemoteHostAsk): void {
    const handler = this.remoteHostResponders.get(ask?.op);
    let results: unknown[] = [];
    try {
      results = handler ? handler(ask.params) : [];
    } catch (err) {
      console.error(`[browser-sidecar] remote host ask ${ask?.op} failed:`, err);
    }
    this.sendRemoteHostCommand({
      rhId: this.nextRhId(),
      cmd: "answer",
      params: { rhId: ask.rhId, results },
    });
  }

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    try {
      return await this.host.invoke("get_available_shells");
    } catch {
      return [];
    }
  }

  spawnPty(id: string, options?: { cols?: number; rows?: number; cwd?: string; shell?: string; args?: string[] }): void {
    this.protocolParsers.set(id, new TerminalProtocolParser(themeColorProvider));
    this.host.send("pty_spawn", { id, options });
  }

  writePty(id: string, data: string): void {
    this.host.send("pty_write", { id, data });
  }

  resizePty(id: string, cols: number, rows: number): void {
    this.host.send("pty_resize", { id, cols, rows });
  }

  killPty(id: string): void {
    this.protocolParsers.delete(id);
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
      return await this.host.invoke("iframe_create_proxy_url", { target: targetUrl });
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

  onFilesDropped(handler: (paths: string[]) => void): () => void {
    this.filesDroppedHandlers.add(handler);
    return () => { this.filesDroppedHandlers.delete(handler); };
  }

  onPtyData(handler: (detail: { id: string; data: string }) => void): void { this.dataHandlers.add(handler); }
  offPtyData(handler: (detail: { id: string; data: string }) => void): void { this.dataHandlers.delete(handler); }
  onPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void { this.exitHandlers.add(handler); }
  offPtyExit(handler: (detail: { id: string; exitCode: number }) => void): void { this.exitHandlers.delete(handler); }
  requestInit(): void { this.host.send("pty_request_init"); }
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
  alertPublishSettings(settings: AlertSettings): void { this.alertManager.setInactivityTimeoutMs(settings.inactivityTimeoutMs); }
  alertDismiss(id: string): void { this.alertManager.dismissAlert(id); }
  alertAttend(id: string): void { this.alertManager.attend(id); }
  alertResize(id: string): void { this.alertManager.onResize(id); }
  alertClearAttention(id?: string): void { this.alertManager.clearAttention(id); }
  alertToggleTodo(id: string): void { this.alertManager.toggleTodo(id); }
  alertMarkTodo(id: string): void { this.alertManager.markTodo(id); }
  alertClearTodo(id: string): void { this.alertManager.clearTodo(id); }
  onAlertState(handler: (detail: AlertStateDetail) => void): void { this.alertStateHandlers.add(handler); }
  // See TauriAdapter: single webview, so nothing is broadcast back.
  onWatchedCommands(_handler: (names: string[]) => void): void {}
  onAlertSettings(_handler: (settings: AlertSettings) => void): void {}

  private static STATE_KEY = 'dormouse.browser-sidecar.session';

  // See TauriAdapter: PersistedWindow when the workspaces flag is on, bare
  // PersistedSession when off; the helpers own the translation + JSON/storage
  // plumbing (docs/specs/transport.md).
  saveState(state: unknown): void {
    try { saveSessionState(localStorage, BrowserSidecarAdapter.STATE_KEY, state); }
    catch { console.error('[browser-sidecar] Failed to save session state'); }
  }

  getState(): unknown {
    try {
      return loadSessionState(localStorage, BrowserSidecarAdapter.STATE_KEY);
    } catch {
      return null;
    }
  }

  private handleHostEvent(event: string, data: unknown): void {
    if (event === "pty:data") {
      const { id, data: text } = data as { id: string; data: string };
      const parsed = this.getProtocolParser(id).process(text);
      applyTerminalProtocolEvents(this.alertManager, id, parsed.events);
      const semanticEvents = collectTerminalSemanticEvents(parsed.events);
      this.alertManager.applyTerminalSemanticEvents(id, semanticEvents);
      applyTerminalSemanticEventsByPtyId(id, semanticEvents);
      for (const response of collectTerminalProtocolResponses(parsed.events)) this.writePty(id, response);
      if (parsed.visibleData.length === 0) return;
      this.alertManager.onData(id);
      for (const handler of this.dataHandlers) handler({ id, data: parsed.visibleData });
    } else if (event === "pty:exit") {
      const payload = data as { id: string; exitCode: number };
      this.alertManager.onExit(payload.id, payload.exitCode);
      this.protocolParsers.delete(payload.id);
      for (const handler of this.exitHandlers) handler(payload);
    } else if (event === "pty:list") {
      for (const handler of this.listHandlers) handler(data as { ptys: PtyInfo[] });
    } else if (event === "pty:replay") {
      const { id, data: text } = data as { id: string; data: string };
      const parsed = this.getProtocolParser(id).process(text);
      applyTerminalSemanticEventsByPtyId(id, collectTerminalSemanticEvents(parsed.events));
      for (const handler of this.replayHandlers) handler({ id, data: parsed.visibleData });
    } else if (event === REMOTE_HOST_RESULT_EVENT) {
      this.settleRemoteHostCommand(data as RemoteHostResult);
    } else if (event === REMOTE_HOST_ASK_EVENT) {
      this.answerRemoteHostAsk(data as RemoteHostAsk);
    } else if (event === REMOTE_HOST_EVENT_EVENT) {
      const name = (data as { name?: string } | null)?.name;
      if (typeof name === "string") {
        for (const listener of this.remoteHostListeners.get(name) ?? []) listener(data);
      }
    } else if (event === "dor:controlRequest") {
      const payload = data as DorControlRequestPayload;
      const respond = (response: DorControlResult) => {
        this.host.send("dor_control_response", { response: { requestId: payload.requestId, ...response } });
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
