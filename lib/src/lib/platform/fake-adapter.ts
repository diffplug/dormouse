import type { AlertStateDetail, PlatformAdapter, PtyInfo } from './types';
import { AlertManager, type SessionStatus } from '../alert-manager';
import {
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  collectTerminalProtocolResponses,
  TerminalProtocolParser,
} from '../terminal-protocol';
import {
  applyTerminalSemanticEventsByPtyId,
} from '../terminal-state-store';

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

export class FakePtyAdapter implements PlatformAdapter {
  private dataHandlers = new Set<(detail: { id: string; data: string }) => void>();
  private exitHandlers = new Set<(detail: { id: string; exitCode: number }) => void>();
  private resizeHandlers = new Set<(detail: FakePtyResizeDetail) => void>();
  private alertStateHandlers = new Set<(detail: AlertStateDetail) => void>();
  private spawnHandlers = new Set<(detail: { id: string }) => void>();
  private terminals = new Set<string>();
  private terminalSizes = new Map<string, FakePtySize>();
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private defaultScenario: FakeScenario | null = null;
  private scenarioMap = new Map<string, FakeScenario>();
  private inputHandlers = new Map<string, (data: string) => void>();
  private protocolParsers = new Map<string, TerminalProtocolParser>();
  private alertManager = new AlertManager();

  constructor() {
    this.alertManager.onStateChange((id, state) => {
      for (const handler of this.alertStateHandlers) {
        handler({ id, ...state });
      }
    });
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
    this.terminalSizes.clear();
    this.defaultScenario = null;
    this.scenarioMap.clear();
    this.dataHandlers.clear();
    this.exitHandlers.clear();
    this.resizeHandlers.clear();
    this.spawnHandlers.clear();
    this.inputHandlers.clear();
    this.protocolParsers.clear();
    this.alertManager.dispose();
    this.alertManager = new AlertManager();
    this.alertManager.onStateChange((id, state) => {
      for (const handler of this.alertStateHandlers) {
        handler({ id, ...state });
      }
    });
  }

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    return [{ name: 'fake-shell', path: '/bin/fake', args: [] }];
  }

  spawnPty(id: string, options?: { cols?: number; rows?: number }): void {
    this.terminals.add(id);
    this.protocolParsers.set(id, new TerminalProtocolParser());
    this.terminalSizes.set(id, {
      cols: options?.cols ?? DEFAULT_PTY_SIZE.cols,
      rows: options?.rows ?? DEFAULT_PTY_SIZE.rows,
    });
    for (const handler of this.spawnHandlers) {
      handler({ id });
    }
    const scenario = this.resolveScenario(id);
    if (scenario) {
      this.playScenario(id, scenario);
    }
  }

  private resolveScenario(id: string): FakeScenario | null {
    return this.scenarioMap.get(id) ?? this.defaultScenario;
  }

  writePty(id: string, data: string): void {
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
    this.alertManager.onExit(id, 0);
    for (const handler of this.exitHandlers) {
      handler({ id, exitCode: 0 });
    }
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

  async getCwd(_id: string): Promise<string | null> { return null; }
  async getScrollback(_id: string): Promise<string | null> { return null; }

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

  // Alert management (local AlertManager, same as TauriAdapter)
  alertRemove(id: string): void { this.alertManager.remove(id); }
  alertToggle(id: string): void { this.alertManager.toggleAlert(id); }
  alertDisable(id: string): void { this.alertManager.disableAlert(id); }
  alertDismiss(id: string): void { this.alertManager.dismissAlert(id); }
  alertDismissOrToggle(id: string, displayedStatus: string): void { this.alertManager.dismissOrToggleAlert(id, displayedStatus as SessionStatus); }
  alertAttend(id: string): void { this.alertManager.attend(id); }
  alertResize(id: string): void { this.alertManager.onResize(id); }
  alertClearAttention(id?: string): void { this.alertManager.clearAttention(id); }
  alertToggleTodo(id: string): void { this.alertManager.toggleTodo(id); }
  alertMarkTodo(id: string): void { this.alertManager.markTodo(id); }
  alertClearTodo(id: string): void { this.alertManager.clearTodo(id); }
  onAlertState(handler: (detail: AlertStateDetail) => void): void { this.alertStateHandlers.add(handler); }
  offAlertState(handler: (detail: AlertStateDetail) => void): void { this.alertStateHandlers.delete(handler); }

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
   * reaches the activity monitor and the bell can never tilt or ring.
   *
   * Pass `{ skipActivity: true }` for writes that are pure UI chrome and
   * shouldn't count as a "task is active" signal — e.g. a tutorial TUI
   * re-rendering its menu on state change. Without the opt-out, every
   * runner frame would tilt the bell on whichever pane hosts the runner.
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
   * until `durationMs` elapses, after which silence resumes and the bell
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
      parser = new TerminalProtocolParser();
      this.protocolParsers.set(id, parser);
    }
    return parser;
  }

  private emitPtyData(id: string, data: string, options: { skipActivity?: boolean } = {}): void {
    const parsed = this.getProtocolParser(id).process(data);
    applyTerminalProtocolEvents(this.alertManager, id, parsed.events);
    const semanticEvents = collectTerminalSemanticEvents(parsed.events);
    this.alertManager.applyTerminalSemanticEvents(id, semanticEvents);
    applyTerminalSemanticEventsByPtyId(id, semanticEvents);
    const inputHandler = this.inputHandlers.get(id);
    for (const response of collectTerminalProtocolResponses(parsed.events)) {
      inputHandler?.(response);
    }

    if (parsed.visibleData.length === 0) return;
    if (!options.skipActivity) this.alertManager.onData(id);
    for (const handler of this.dataHandlers) {
      handler({ id, data: parsed.visibleData });
    }
  }
}
