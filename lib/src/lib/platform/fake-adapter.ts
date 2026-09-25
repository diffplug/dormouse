import { DEFAULT_HELPER_COMMAND, type TerminalContextRequest, type TerminalContextInfo } from '../terminal-context-types';
import type { OpenPort, PlatformAdapter, PtyDataDetail, PtyInfo, BurrowLink, SpawnPtyOptions, WritePtyOptions } from './types';
import type { AlertManager } from '../alert-manager';
import { createAlertHost, type AlertHost, type AlertRealm } from '../../host/alert-host';
import { createAlertClient, type AlertClientMethods } from '../../host/alert-client';
import { normalizeExternalUri } from '../external-links';
import {
  applyTerminalEvents,
  collectTerminalProtocolResponses,
  TerminalProtocolParser,
  textProjectionOf,
} from '../terminal-protocol';
import {
  applyTerminalSemanticEvents,
} from '../terminal-state-store';
import { themeColorProvider } from '../terminal-theme';
import { recordToolEvents } from '../tool-events';

/** This renderer is its host's one realm. */
const LOCAL_VIEWER = 'local';

export interface FakeScenario {
  name: string;
  chunks: { delay: number; data: string }[];
  exitCode?: number;
  /** Set to true when the final chunk leaves the pty at a shell prompt.
   * The playground shell registry consults this to avoid printing a
   * duplicate prompt on first user input. */
  endsWithPrompt?: boolean;
}

export interface FakePtySize {
  cols: number;
  rows: number;
}

export interface FakePtyResizeDetail extends FakePtySize {
  id: string;
}

const DEFAULT_PTY_SIZE: FakePtySize = { cols: 80, rows: 30 };

/** The `alert*` platform methods, taken from the shared client in the constructor. */
export interface FakePtyAdapter extends AlertClientMethods {}

export class FakePtyAdapter implements PlatformAdapter {
  private dataHandlers = new Set<(detail: PtyDataDetail) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private resizeHandlers = new Set<(detail: FakePtyResizeDetail) => void>();
  private spawnHandlers = new Set<(detail: { id: string }) => void>();
  private terminals = new Set<string>();
  /** The deterministic demo shell behind each helper (docs/specs/terminal-context.md). */
  private helpers = new Map<string, { cwd: string; busy: boolean }>();
  private helperCommand = DEFAULT_HELPER_COMMAND;
  private terminalSizes = new Map<string, FakePtySize>();
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private defaultScenario: FakeScenario | null = null;
  private scenarioMap = new Map<string, FakeScenario>();
  private inputHandlers = new Map<string, (data: string) => void>();
  private protocolParsers = new Map<string, TerminalProtocolParser>();
  private openPortsMap = new Map<string, OpenPort[]>();
  /**
   * The alerts' host role, in process: the renderer's verbs reach it through
   * the client every host shares, and its events come straight back, as they
   * would over a real host's transport (`lib/src/host/alert-host.ts`).
   */
  private alertHost!: AlertHost;
  private stopAlertHost: () => void = () => {};
  private readonly alerts = createAlertClient((command) => this.alertHost.handle(LOCAL_VIEWER, command, this.alertRealm));
  private readonly alertRealm: AlertRealm = {
    answer: (result) => void this.alerts.onEvent('alert:awaitResult', result),
    resendStates: (ids) => {
      for (const id of ids) {
        if (this.alertManager.has(id)) this.alerts.onEvent('alert:state', { id, ...this.alertManager.getState(id) });
      }
    },
    resendWatchedCommands: (names) => void this.alerts.onEvent('alert:watchedCommands', { names }),
    resendSettings: (settings) => void this.alerts.onEvent('alert:settings', { settings }),
  };

  /** The PTY side feeds the manager directly, as a host's own PTYs do. */
  private get alertManager(): AlertManager {
    return this.alertHost.manager;
  }

  // Host-capability flags: mutable and public because the Storybook preview
  // decorator toggles them per story to simulate a host (VS Code) that owns the
  // theme or shell selection, which is what hides the Settings dialog's rows.
  hostOwnsTheme?: boolean;
  hostOwnsShells?: boolean;

  // Same reason, one layer up: a fake platform has no Burrow service behind it, so
  // this stays undefined and the Settings dialog's Remote control section renders
  // nothing (`docs/specs/relay.md`). The preview decorator installs a stub link
  // for the stories that are *about* that section.
  burrow?: BurrowLink;


  /** Where a due push goes. There is no Burrow here, so by default it reaches
   *  no phone; a test sets this to see what would have been sent. */
  onAlertPush?: (sessionId: string, title: string) => void;

  constructor() {
    Object.assign(this, this.alerts.methods);
    this.startAlertHost();
  }

  private startAlertHost(): void {
    const host = createAlertHost({ push: (sessionId, title) => this.onAlertPush?.(sessionId, title) });
    const stops = [
      host.onSpeak((speak) => void this.alerts.onEvent('alert:speak', speak)),
      host.manager.onStateChange((id, state) => void this.alerts.onEvent('alert:state', { id, ...state })),
      host.watched.subscribe((names) => void this.alerts.onEvent('alert:watchedCommands', { names })),
      host.settings.subscribe((settings) => void this.alerts.onEvent('alert:settings', { settings })),
    ];
    this.alertHost = host;
    this.stopAlertHost = () => {
      for (const stop of stops) stop();
      host.dispose();
    };
  }

  async init(): Promise<void> {}
  shutdown(): void {
    this.reset();
  }

  setDefaultScenario(scenario: FakeScenario): void {
    this.defaultScenario = scenario;
  }

  clearDefaultScenario(): void {
    this.defaultScenario = null;
  }

  setScenario(id: string, scenario: FakeScenario): void {
    this.scenarioMap.set(id, scenario);
  }

  clearScenario(id: string): void {
    this.scenarioMap.delete(id);
  }

  reset(): void {
    for (const timers of this.activeTimers.values()) {
      timers.forEach(clearTimeout);
    }
    this.activeTimers.clear();
    this.terminals.clear();
    this.helpers.clear();
    this.terminalSizes.clear();
    this.defaultScenario = null;
    this.scenarioMap.clear();
    this.dataHandlers.clear();
    this.exitHandlers.clear();
    this.resizeHandlers.clear();
    this.spawnHandlers.clear();
    this.inputHandlers.clear();
    this.protocolParsers.clear();
    this.openPortsMap.clear();
    // What this realm parked settles `cancelled`, as a disposing adapter's does.
    this.alerts.dispose();
    this.stopAlertHost();
    this.startAlertHost();
  }

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    return [{ name: 'fake-shell', path: '/bin/fake', args: [] }];
  }

  spawnPty(id: string, options?: SpawnPtyOptions): void {
    // A new generation starts its alert state over, from what a cold restore
    // persisted, as every host's spawn does.
    this.alertHost.respawn(id, options?.alert);
    if (options?.helper) {
      this.helpers.set(id, { cwd: options.cwd ?? '/home/demo/projects/dormouse', busy: false });
      this.alertManager.setHelper(id, true);
    }
    this.terminals.add(id);
    this.protocolParsers.set(id, new TerminalProtocolParser(themeColorProvider));
    this.terminalSizes.set(id, {
      cols: options?.cols ?? DEFAULT_PTY_SIZE.cols,
      rows: options?.rows ?? DEFAULT_PTY_SIZE.rows,
    });
    for (const handler of this.spawnHandlers) {
      handler({ id });
    }
    if (options?.helper) { this.startHelperShell(id); return; }
    const scenario = this.resolveScenario(id);
    if (scenario) {
      this.playScenario(id, scenario);
    }
  }

  async terminalContext(request: TerminalContextRequest): Promise<TerminalContextInfo> {
    switch (request.op) {
      case 'settings':
        if (request.command !== undefined) {
          if (/[\r\n\0]/.test(request.command) || request.command.length > 4096) throw new Error('Use a single command line (up to 4096 characters)');
          this.helperCommand = request.command;
        }
        return { home: '/home/demo', command: this.helperCommand };
      case 'info':
        return { busy: this.helpers.get(request.id)?.busy ?? false };
      case 'promote':
        if (!request.restore) this.helpers.delete(request.id);
        this.alertManager.setHelper(request.id, !!request.restore);
        return {};
      default:
        return {};
    }
  }

  private startHelperShell(id: string): void {
    const helper = this.helpers.get(id)!;
    let input = '';
    const prompt = () => this.sendOutput(id, `\x1b]633;A\x07${helper.cwd} ❯ \x1b]633;B\x07`);
    this.inputHandlers.set(id, data => {
      if (data === '\x03') { helper.busy = false; input = ''; this.sendOutput(id, '^C\r\n\x1b]633;D;130\x07'); prompt(); return; }
      if (helper.busy) return;
      for (const char of data) {
        if (char === '\r' || char === '\n') {
          const command = input; input = '';
          this.sendOutput(id, `\r\n\x1b]633;E;${command}\x07\x1b]633;C\x07`);
          if (/^(sleep|nano|vim)\b/.test(command)) { helper.busy = true; this.sendOutput(id, 'Demo process running. Ctrl+C stops it.\r\n'); continue; }
          const output = command === 'git status' ? 'On branch main\r\nnothing to commit, working tree clean' : command.startsWith('echo ') ? command.slice(5) : command === 'pwd' ? helper.cwd : command ? `Demo shell: ${command}` : '';
          if (output) this.sendOutput(id, output + '\r\n');
          this.sendOutput(id, '\x1b]633;D;0\x07'); prompt();
        } else if (char === '\x7f') { if (input) { input = input.slice(0, -1); this.sendOutput(id, '\b \b'); } }
        else { input += char; this.sendOutput(id, char); }
      }
    });
    queueMicrotask(prompt);
  }

  private resolveScenario(id: string): FakeScenario | null {
    return this.scenarioMap.get(id) ?? this.defaultScenario;
  }

  writePty(id: string, data: string, options?: WritePtyOptions): void {
    if (options?.userInput) this.alertManager.acknowledge(id, { input: true });
    if (!this.terminals.has(id)) return;
    // Only echo if no scenario is actively playing
    if (this.activeTimers.has(id)) return;
    // Route to custom input handler if set
    const inputHandler = this.inputHandlers.get(id);
    if (inputHandler) {
      inputHandler(data);
      return;
    }
    this.emitPtyData(id, data);
  }

  resizePty(id: string, cols: number, rows: number): void {
    this.alertManager.onResize(id);
    if (!this.terminals.has(id)) return;
    const next = { cols, rows };
    const prev = this.terminalSizes.get(id);
    if (prev?.cols === cols && prev.rows === rows) return;
    this.terminalSizes.set(id, next);
    for (const handler of this.resizeHandlers) {
      handler({ id, ...next });
    }
  }

  killPty(id: string): void {
    const timers = this.activeTimers.get(id);
    if (timers) {
      timers.forEach(clearTimeout);
      this.activeTimers.delete(id);
    }
    this.terminals.delete(id);
    this.terminalSizes.delete(id);
    this.inputHandlers.delete(id);
    this.protocolParsers.delete(id);
    this.openPortsMap.delete(id);
    // The Session is over, so its alert state goes with it.
    this.alertManager.remove(id);
    this.helpers.delete(id);
    for (const handler of this.exitHandlers) {
      handler({ id, exitCode: 0 });
    }
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

  async getCwd(id: string): Promise<string | null> { return this.helpers.get(id)?.cwd ?? null; }

  /** Ports the playground/tests want a given terminal to report. */
  setOpenPorts(id: string, ports: OpenPort[]): void {
    this.openPortsMap.set(id, ports);
  }

  async getOpenPorts(id: string): Promise<OpenPort[]> {
    if (!this.terminals.has(id)) return [];
    return this.openPortsMap.get(id) ?? [];
  }

  getPtySize(id: string): FakePtySize {
    return this.terminalSizes.get(id) ?? DEFAULT_PTY_SIZE;
  }

  hasPty(id: string): boolean {
    return this.terminals.has(id);
  }

  /** True when the scenario assigned to `id` (or the default scenario, if
   *  no per-id scenario is set) leaves the pty at a shell prompt. */
  scenarioEndsWithPrompt(id: string): boolean {
    return this.resolveScenario(id)?.endsWithPrompt === true;
  }

  async readClipboardFilePaths(): Promise<string[] | null> { return null; }
  async readClipboardImageAsFilePath(): Promise<string | null> { return null; }
  openExternal(uri: string): void {
    const normalized = normalizeExternalUri(uri);
    if (!normalized || typeof window === 'undefined') return;
    window.open(normalized, '_blank', 'noopener,noreferrer');
  }

  requestInit(): void {}
  onPtyList(_handler: (detail: { ptys: PtyInfo[] }) => void): void {}
  offPtyList(_handler: (detail: { ptys: PtyInfo[] }) => void): void {}
  onPtyReplay(_handler: (detail: { id: string; data: string }) => void): void {}
  offPtyReplay(_handler: (detail: { id: string; data: string }) => void): void {}
  onPtyResize(handler: (detail: FakePtyResizeDetail) => void): () => void {
    this.resizeHandlers.add(handler);
    return () => {
      this.resizeHandlers.delete(handler);
    };
  }
  /** Fires synchronously inside `spawnPty(id)` after the pty is registered
   *  but before its scenario starts playing. Returns an unsubscribe fn. */
  onPtySpawn(handler: (detail: { id: string }) => void): () => void {
    this.spawnHandlers.add(handler);
    return () => {
      this.spawnHandlers.delete(handler);
    };
  }
  onRequestSessionFlush(_handler: (detail: { requestId: string }) => void): void {}
  offRequestSessionFlush(_handler: (detail: { requestId: string }) => void): void {}
  notifySessionFlushComplete(_requestId: string): void {}

  private savedState: unknown = null;
  saveState(state: unknown): void { this.savedState = state; }
  getState(): unknown { return this.savedState; }

  /** Register a custom input handler for a terminal. When set, `writePty` routes
   *  keystrokes to this handler instead of the default echo behavior. */
  setInputHandler(id: string, handler: (data: string) => void): void {
    this.inputHandlers.set(id, handler);
  }

  clearInputHandler(id: string): void {
    this.inputHandlers.delete(id);
  }

  /**
   * Send data to a terminal's output (as if the PTY produced it). Drives
   * the alert-manager's activity feed the same way real PTY data does in
   * the Tauri/VSCode adapters — without this, browser-side echo (e.g.
   * TutorialShell's per-character echo, AsciiSplashRunner frames) never
   * reaches the activity monitor and a pane can never ring.
   *
   * Pass `{ skipActivity: true }` for writes that are pure UI chrome and
   * shouldn't count as a "task is active" signal — e.g. a tutorial TUI
   * re-rendering its menu on state change. Without the opt-out, every
   * runner frame would look like work on whichever pane hosts the runner.
   */
  sendOutput(id: string, data: string, options: { skipActivity?: boolean } = {}): void {
    if (!this.terminals.has(id)) return;
    this.emitPtyData(id, data, options);
  }

  /**
   * Drive the alert-manager's activity monitor for a fixed duration with
   * no data output — useful for animating a fake "task running" state on
   * a pane while the visual feedback lives elsewhere. Calls
   * `alertManager.onData(id)` immediately, then again every `intervalMs`
   * until `durationMs` elapses, after which silence resumes and the Session
   * transitions naturally to MIGHT_NEED_ATTENTION → ALERT_RINGING.
   * Returns a dispose handle that cancels remaining ticks.
   */
  pumpActivity(id: string, durationMs: number, intervalMs = 1000): () => void {
    if (!this.terminals.has(id)) return () => {};
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let stop: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (interval !== null) clearInterval(interval);
      if (stop !== null) clearTimeout(stop);
    };
    this.alertManager.onData(id);
    const tick = () => {
      if (cancelled) return;
      // Pty may have been killed mid-duration. Stop pumping rather than
      // feeding the activity monitor for a terminal that no longer exists.
      if (!this.terminals.has(id)) {
        cancel();
        return;
      }
      this.alertManager.onData(id);
    };
    interval = setInterval(tick, intervalMs);
    stop = setTimeout(cancel, durationMs);
    return cancel;
  }

  private playScenario(id: string, scenario: FakeScenario): void {
    const timers: ReturnType<typeof setTimeout>[] = [];
    this.activeTimers.set(id, timers);

    let cumulativeDelay = 0;
    for (const chunk of scenario.chunks) {
      cumulativeDelay += chunk.delay;
      const timer = setTimeout(() => {
        if (!this.terminals.has(id)) return;
        this.emitPtyData(id, chunk.data);
      }, cumulativeDelay);
      timers.push(timer);
    }

    if (scenario.exitCode !== undefined) {
      const exitTimer = setTimeout(() => {
        if (!this.terminals.has(id)) return;
        this.activeTimers.delete(id);
        this.alertManager.onExit(id, scenario.exitCode ?? 0);
        for (const handler of this.exitHandlers) {
          handler({ id, exitCode: scenario.exitCode ?? 0 });
        }
      }, cumulativeDelay + 100);
      timers.push(exitTimer);
    } else {
      // Clean up timer tracking after last chunk fires (terminal stays alive)
      const cleanupTimer = setTimeout(() => {
        this.activeTimers.delete(id);
      }, cumulativeDelay + 1);
      timers.push(cleanupTimer);
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

  private emitPtyData(id: string, data: string, options: { skipActivity?: boolean } = {}): void {
    const parsed = this.getProtocolParser(id).process(data);
    // The Tool stores are this renderer's own.
    recordToolEvents(id, parsed.events);
    applyTerminalSemanticEvents(id, applyTerminalEvents(this.alertManager, id, parsed.events));
    const inputHandler = this.inputHandlers.get(id);
    for (const response of collectTerminalProtocolResponses(parsed.events)) {
      inputHandler?.(response);
    }

    if (parsed.visibleData.length === 0) return;
    if (!options.skipActivity) this.alertManager.onData(id);
    const textData = textProjectionOf(parsed);
    for (const handler of this.dataHandlers) {
      handler({ id, data: parsed.visibleData, textData });
    }
  }
}
