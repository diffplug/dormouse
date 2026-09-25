import { BROWSER_PROVIDER_IDS } from 'dor-lib-common/browser-providers';
import type { BrowserRequest, BrowserResult } from '../../lib/src/lib/platform/browser-automation';
import { recordToolEvents } from '../../lib/src/lib/tool-events';
import type { TerminalContextRequest, TerminalContextInfo } from '../../lib/src/lib/terminal-context-types';
import { installWorkspaceRegistry, type WorkspaceRegistrySnapshot } from "./workspace-registry";
import type {
  IframeProxyResult,
  OpenPort,
  PlatformAdapter,
  PtyDataDetail,
  PtyListDetail,
  PtyMarkedDetail,
  PtyReplayDetail,
  BurrowLink,
  GitInfoResult,
  ToolControlResult,
  ToolHostRequest,
  SpawnPtyOptions,
  WritePtyOptions,
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
import { createAlertClient, type AlertClientMethods } from "dormouse-lib/host/alert-client";
import type { AlertCommand } from "dormouse-lib/host/alert-protocol";
import { normalizeExternalUri } from "dormouse-lib/lib/external-links";
import { createMemoryNotepadArchivePort } from "dormouse-lib/lib/notepad/memory-archive-port";
import type { ManagedVoicePort } from "dormouse-lib/lib/platform/managed-voice-types";
import { createManagedVoicePort } from "./managed-voice-port";
import type { PersistedWindow } from "dormouse-lib/lib/session-types";
import { claimRecoveryCommands, windowStateSlot } from "./window-recovery";
import { coalesceCwds } from "./coalesce-cwds";
import type { TerminalProtocolEvent } from "dormouse-lib/lib/terminal-protocol";
import { getTerminalTheme, onTerminalThemeChange } from "dormouse-lib/lib/terminal-theme";
import { parseReplay } from "dormouse-lib/lib/platform/replay-parse";
import type { TerminalSemanticEvent } from "dormouse-lib/lib/terminal-state";
import { applyTerminalSemanticEvents } from "dormouse-lib/lib/terminal-state-store";
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

/** The `alert*` platform methods, taken from the shared client in the constructor. */
export interface BrowserSidecarAdapter extends AlertClientMethods {}

export class BrowserSidecarAdapter implements PlatformAdapter {
  private dataHandlers = new Set<(detail: PtyDataDetail) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private listHandlers = new Set<(detail: PtyListDetail) => void>();
  private replayHandlers = new Set<(detail: PtyReplayDetail) => void>();
  private markedHandlers = new Set<(detail: PtyMarkedDetail) => void>();
  private unlistenHost: (() => void) | null = null;
  private unlistenReconnect: (() => void) | null = null;
  private unlistenRegistry: (() => void) | null = null;
  private onRegistrySnapshot: ((snapshot: WorkspaceRegistrySnapshot) => void) | null = null;
  private static STATE_KEY = 'dormouse.browser-sidecar.session';
  private windowSlot = windowStateSlot(localStorage, BrowserSidecarAdapter.STATE_KEY, 'browser-sidecar');
  // Remote-host bridge, identical in shape to TauriAdapter's — the dev harness
  // forwards the same `burrow:*` messages over its own transport.
  private readonly burrowClient = createBurrowLinkClient({
    sendCommand: (command) => this.sendBurrowCommand(command),
    answerAsk: (askId, results) => this.sendBurrowCommand(answerAskCommand(askId, results)),
    notify: () => this.sendBurrowCommand(notifyCommand()),
  });

  readonly burrow: BurrowLink = this.burrowClient.link;

  // The sidecar's alerts, through the same client TauriAdapter uses; the dev
  // host stamps this page's one fixed window label on each command.
  private readonly alerts = createAlertClient((payload: AlertCommand) => {
    this.host.send("alert_command", { payload });
  });

  constructor(private readonly host: BrowserSidecarHost) {
    Object.assign(this, this.alerts.methods);
    // See TauriAdapter: the sidecar parses and has no DOM, so it is told the
    // resolved terminal colors whenever they change.
    onTerminalThemeChange(() => this.pushThemeColors());

    // Some of these get called through detached references (e.g. the iframe
    // panel does `const createProxy = getPlatform().createIframeProxyUrl`), which
    // drops `this` and makes the internal `this.host` access throw. The VS Code
    // adapter binds for the same reason; mirror it so any call style is safe.
    this.createIframeProxyUrl = this.createIframeProxyUrl.bind(this);
    this.toolControl = this.toolControl.bind(this);
  }

  async init(): Promise<void> {
    await this.host.init();
    this.unlistenHost = this.host.onEvent(({ event, data }) => this.handleHostEvent(event, data));
    // The SSE stream is the only way the alerts' events reach this adapter,
    // and whatever the sidecar sent while it was down is lost: `sync` has the
    // sidecar re-send this window's Sessions' state and both stores.
    this.unlistenReconnect = this.host.onReconnect(() => this.alerts.sync());
    // A reload is a new realm under the same label; see TauriAdapter.
    this.alerts.hello();
    this.installConsoleForwarder();
    this.unlistenRegistry = await installWorkspaceRegistry({
      invoke: (cmd, args) => this.host.invoke(cmd, args),
      // Through the one host subscription above, not a second one.
      onSnapshot: (handler) => {
        this.onRegistrySnapshot = handler;
        return () => { this.onRegistrySnapshot = null; };
      },
    });
    // Started, not awaited — see TauriAdapter.
    this.recoveryReady = claimRecoveryCommands(
      (paneIds) => this.host.invoke<Record<string, string>>("take_recovery_commands", { paneIds }),
      this.windowSlot.read(),
      'browser-sidecar',
    ).then((commands) => { this.recoveryCommands = commands; });
  }

  shutdown(): void {
    this.alerts.dispose();
    this.unlistenHost?.();
    this.unlistenHost = null;
    this.unlistenReconnect?.();
    this.unlistenReconnect = null;
    this.unlistenRegistry?.();
    this.unlistenRegistry = null;
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

  async terminalContext(request: TerminalContextRequest): Promise<TerminalContextInfo> {
    const result = await this.host.invoke<TerminalContextInfo>('pty_context', { request });
    if (result.error) throw new Error(result.error);
    return result;
  }
  spawnPty(id: string, options?: SpawnPtyOptions): void {
    this.host.send("pty_spawn", { id, options });
  }

  /** See TauriAdapter: `userInput` rides the write itself. */
  writePty(id: string, data: string, options?: WritePtyOptions): void {
    this.host.send("pty_write", { id, data, paced: options?.paced, userInput: options?.userInput });
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

  /** See TauriAdapter: one round trip, one process scan, for the whole save —
   *  coalesced the same way, because the harness runs the same Walls. */
  private readonly cwdBatch = coalesceCwds(async (ids) => {
    try { return await this.host.invoke<Record<string, string | null>>("pty_get_cwds", { ids }); } catch { return {}; }
  });

  getCwds(ids: string[]): Promise<Record<string, string | null>> {
    return this.cwdBatch(ids);
  }

  /** See TauriAdapter: claimed once during `init()`, read synchronously by the
   *  cold restore. */
  private recoveryCommands: Record<string, string> = {};
  recoveryReady: Promise<void> = Promise.resolve();

  getRecoveryCommands(): Record<string, string> {
    return this.recoveryCommands;
  }

  // No `captureAgentRecovery` here. Capture is a quit-only step, and this
  // harness has no quit: a reload is a live resume over PTYs that survive it, so
  // sending `^C` to every agent would interrupt work that is still running. What
  // a reload does exercise is the claim above, against whatever the app's own
  // quit last wrote (docs/specs/standalone.md -> "Agent recovery").

  async getOpenPorts(id: string): Promise<OpenPort[]> {
    try { return await this.host.invoke("pty_get_open_ports", { id }); } catch { return []; }
  }

  /** See TauriAdapter: one round trip, one process scan, for a whole listing. */
  async getOpenPortsMany(ids: string[]): Promise<Record<string, OpenPort[]>> {
    try {
      return await this.host.invoke<Record<string, OpenPort[]>>("pty_get_open_ports_many", { ids });
    } catch { return {}; }
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

  async gitInfo(paths: string[]): Promise<GitInfoResult> {
    // A missing result is a failure, never an empty answer: an absent key
    // means "ask again" (lib/src/lib/platform/git-types.ts).
    const result = await this.host.invoke<GitInfoResult | null>("git_info", { paths });
    if (!result) throw new Error("git_info answered nothing");
    return result;
  }

  async toolControl(request: ToolHostRequest): Promise<ToolControlResult> {
    try {
      return await this.host.invoke("tool_control", { request });
    } catch (err) {
      return { status: "error", message: errMessage(err) };
    }
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

  readonly browserProviders = BROWSER_PROVIDER_IDS;

  async browser(request: BrowserRequest): Promise<BrowserResult> {
    try {
      return await this.host.invoke<BrowserResult>("browser_request", { request });
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
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
  requestInit(requestId?: string): void {
    this.host.send("pty_request_init", { requestId: requestId ?? null });
    this.pushThemeColors();
  }
  onPtyList(handler: (detail: PtyListDetail) => void): void { this.listHandlers.add(handler); }
  offPtyList(handler: (detail: PtyListDetail) => void): void { this.listHandlers.delete(handler); }
  onPtyReplay(handler: (detail: PtyReplayDetail) => void): void { this.replayHandlers.add(handler); }
  offPtyReplay(handler: (detail: PtyReplayDetail) => void): void { this.replayHandlers.delete(handler); }
  onPtyMarked(handler: (detail: PtyMarkedDetail) => void): () => void {
    this.markedHandlers.add(handler);
    return () => { this.markedHandlers.delete(handler); };
  }
  onRequestSessionFlush(_handler: (detail: { requestId: string }) => void): void {}
  offRequestSessionFlush(_handler: (detail: { requestId: string }) => void): void {}
  notifySessionFlushComplete(_requestId: string): void {}

  // See TauriAdapter: no bare-Session slot on this host. The harness mirrors the
  // shipped persistence answer, so a reload here exercises what the app does
  // (docs/specs/transport.md -> "The governing rule").
  saveState(_state: unknown): void {}
  getState(): unknown { return null; }

  // See TauriAdapter: one `PersistedWindow` per window, in `localStorage` rather
  // than the Rust file store (docs/specs/transport.md).
  saveWindowState(snapshot: PersistedWindow): void {
    this.windowSlot.write(snapshot);
  }

  getWindowState(): PersistedWindow | null {
    return this.windowSlot.read();
  }

  // The notepad archive as memory, not the Tauri file: this harness is a browser
  // tab with no app-data directory, and a dev run must not write into (or read)
  // the installed app's archive. Notes last as long as the page
  // (docs/specs/notepad.md).
  readonly notepadArchive = createMemoryNotepadArchivePort();

  // The harness answers `managed_voice_speak` with base64 where Rust sends raw bytes.
  readonly managedVoice: ManagedVoicePort = createManagedVoicePort({
    invoke: (cmd, args) => this.host.invoke(cmd, args),
    decodeSpeak: (raw) => decodeBase64Bytes((raw as { audioBase64: string }).audioBase64),
    offerSetup: import.meta.env.DEV,
  });

  // Cmd/Ctrl+N opens a browser window before any listener sees it, so the
  // harness shows no chord and binds none — the same reason the website's demo
  // adapter sets this. The shipped Tauri build owns its keyboard and does not.
  readonly browserReservesNotepadChord = true;

  private handleHostEvent(event: string, data: unknown): void {
    if (event === "dormouse://workspaces") {
      this.onRegistrySnapshot?.(data as WorkspaceRegistrySnapshot);
      return;
    }
    if (this.alerts.onEvent(event, data)) return;
    if (event === "pty:data") {
      // Already parsed by the sidecar, which owns the PTY; its events arrive as
      // the two messages below (docs/specs/terminal-escapes.md).
      const payload = data as PtyDataDetail;
      for (const handler of this.dataHandlers) handler(payload);
    } else if (event === "terminal:toolEvents") {
      const payload = data as { id: string; events: TerminalProtocolEvent[] };
      recordToolEvents(payload.id, payload.events);
    } else if (event === "terminal:semanticEvents") {
      const { id, events } = data as { id: string; events: TerminalSemanticEvent[] };
      applyTerminalSemanticEvents(id, events);
    } else if (event === "pty:exit") {
      const payload = data as { id: string; exitCode: number };
      for (const handler of this.exitHandlers) handler(payload);
    } else if (event === "pty:list") {
      for (const handler of this.listHandlers) handler(data as PtyListDetail);
    } else if (event === "pty:marked") {
      for (const handler of this.markedHandlers) handler(data as PtyMarkedDetail);
    } else if (event === "pty:replay") {
      const { id, data: text, requestId } = data as PtyReplayDetail;
      const visibleData = parseReplay(id, text);
      for (const handler of this.replayHandlers) handler({ id, data: visibleData, requestId });
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
