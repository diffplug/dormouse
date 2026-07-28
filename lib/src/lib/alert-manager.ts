import { ActivityMonitor, type SessionStatus } from './activity-monitor';
import { cfg } from '../cfg';
import {
  commandArgv0,
  resolveCommandStart,
  DEFAULT_COMMAND_TITLE,
  type CommandRunSource,
  type TerminalSemanticEvent,
} from './terminal-state';

export { type SessionStatus } from './activity-monitor';

/** Boolean TODO state: on (true) or off (false). */
export type TodoState = boolean;

export const ACTIVITY_NOTIFICATION_SOURCES = ['OSC 9', 'OSC 9;4', 'OSC 99', 'OSC 777', 'BEL', 'COMMAND_EXIT'] as const;
export type ActivityNotificationSource = typeof ACTIVITY_NOTIFICATION_SOURCES[number];

export interface ActivityNotification {
  source: ActivityNotificationSource;
  title: string | null;
  body: string | null;
}

export type ProtocolProgressState = 'clear' | 'normal' | 'warning' | 'indeterminate' | 'error';

export interface ProtocolProgressUpdate {
  state: ProtocolProgressState;
  percent: number | null;
}

type ProtocolStatus = 'IDLE' | 'OSC_NOTIF_BUSY' | 'ALERT_RINGING';
type CommandExitStatus = 'IDLE' | 'COMMAND_EXIT_ARMED' | 'ALERT_RINGING';
type ActiveProtocolProgressState = 'normal' | 'warning' | 'indeterminate';

interface ActiveProtocolProgress {
  state: ActiveProtocolProgressState;
  percent: number | null;
}

interface CommandExitWatch {
  displayCommand: string;
  /** Bare program name the WATCHING rule set is keyed on; null without shell integration. */
  argv0: string | null;
  source: CommandRunSource;
  startedAt: number;
  seenWithAttentionAt: number | null;
}

export function normalizeActivityNotification(value: unknown): ActivityNotification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(ACTIVITY_NOTIFICATION_SOURCES as readonly string[]).includes(record.source as string)) return null;

  const title = normalizeNotificationTextField(record.title);
  const body = normalizeNotificationTextField(record.body);
  if (!title && !body) return null;
  return {
    source: record.source as ActivityNotificationSource,
    title,
    body,
  };
}

function normalizeNotificationTextField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface AlertState {
  status: SessionStatus;
  watchingEnabled: boolean;
  todo: TodoState;
  notification: ActivityNotification | null;
  /** Used by the bell transition table to detect a post-attention dismiss */
  attentionDismissedRing: boolean;
}

export const DEFAULT_ALERT_STATE: AlertState = {
  status: 'WATCHING_DISABLED',
  watchingEnabled: false,
  todo: false,
  notification: null,
  attentionDismissedRing: false,
};

/**
 * Three independent alarm tracks per Session, unioned into one public status.
 * Each track is IDLE -> (a busy/armed state) -> ringing, and each ring latches
 * in the entry until it is attended, dismissed, or TODO'd. WATCHING's ring lives
 * here rather than in its `ActivityMonitor` precisely so it can outlive the
 * monitor: watching turns off the moment the watched command exits, which is
 * often the same moment the ring is raised.
 */
interface AlertEntry {
  monitor: ActivityMonitor | null;
  watchingRinging: boolean;
  protocolStatus: ProtocolStatus;
  progress: ActiveProtocolProgress | null;
  commandExitStatus: CommandExitStatus;
  commandExitWatch: CommandExitWatch | null;
  pendingCommandLine: string | null;
  todo: TodoState;
  notification: ActivityNotification | null;
  attentionDismissedRing: boolean;
}

const T_USER_ATTENTION = cfg.alert.userAttention;

/**
 * Manages ActivityMonitors, attention tracking, and todo state for PTY sessions.
 *
 * Portable — no DOM dependencies. Can run in the extension host (VSCode),
 * in the webview adapter (Tauri), or in tests.
 */
export class AlertManager {
  private entries = new Map<string, AlertEntry>();
  private attentionId: string | null = null;
  private attentionTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(id: string, state: AlertState) => void>();
  private lastEmitted = new Map<string, AlertState>();
  private watchedCommands = new Set<string>();

  // --- State change subscription ---

  onStateChange(listener: (id: string, state: AlertState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- Feed PTY events ---

  onData(id: string): void {
    const entry = this.entries.get(id);
    entry?.monitor?.onData();
  }

  onExit(id: string, exitCode?: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (this.finishCommandExitWatch(id, entry, exitCode)) this.notify(id);
  }

  onResize(id: string): void {
    const entry = this.entries.get(id);
    entry?.monitor?.onResize();
  }

  // --- WATCHING rule set ---

  /**
   * Replace the set of command names WATCHING applies to (`docs/specs/alert.md`).
   * Pushed from the renderer, which owns the persisted copy — the extension host
   * has no `localStorage` of its own.
   */
  setWatchedCommands(names: string[]): void {
    const next = new Set(names);
    if (next.size === this.watchedCommands.size && [...next].every((name) => this.watchedCommands.has(name))) return;
    this.watchedCommands = next;
    for (const [id, entry] of this.entries) {
      const wasWatching = !!entry.monitor;
      let changed = this.applyWatchingRule(id, entry);
      // Dropping a rule is an explicit "stop alerting on this", so it also
      // silences the ring that rule already raised. A command *ending* does the
      // opposite — see setWatching.
      if (wasWatching && !entry.monitor && entry.watchingRinging) {
        entry.watchingRinging = false;
        changed = true;
      }
      if (changed) this.notify(id);
    }
  }

  /** Apply one command-rule mutation without replacing unrelated rules. */
  setCommandWatched(name: string, watched: boolean): void {
    const trimmed = name.trim();
    if (!trimmed || this.watchedCommands.has(trimmed) === watched) return;
    const next = new Set(this.watchedCommands);
    if (watched) next.add(trimmed);
    else next.delete(trimmed);
    this.setWatchedCommands([...next]);
  }

  /** Sorted snapshot used by hosts that mirror the rule set to renderers. */
  getWatchedCommands(): string[] {
    return [...this.watchedCommands].sort();
  }

  /**
   * WATCHING follows the foreground command's name: on while a watched command
   * runs, off at the prompt. Returns whether the monitor changed.
   */
  private applyWatchingRule(id: string, entry: AlertEntry): boolean {
    const argv0 = entry.commandExitWatch?.argv0 ?? null;
    return this.setWatching(id, entry, argv0 !== null && this.watchedCommands.has(argv0));
  }

  private setWatching(id: string, entry: AlertEntry, enabled: boolean): boolean {
    if (enabled === !!entry.monitor) return false;
    if (enabled) {
      entry.monitor = this.createMonitor(id);
    } else {
      // `watchingRinging` deliberately survives: watching switches off the
      // moment the watched command exits, which is usually the same moment its
      // ring was raised. Only an explicit rule removal clears it.
      entry.monitor?.dispose();
      entry.monitor = null;
    }
    entry.attentionDismissedRing = false;
    return true;
  }

  private createMonitor(id: string): ActivityMonitor {
    return new ActivityMonitor({
      hasAttention: () => this.hasAttention(id),
      onChange: (status) => {
        const entry = this.entries.get(id);
        if (!entry) return;

        if (status === 'ALERT_RINGING') {
          // The user is looking right at it — suppress by resetting the monitor.
          if (this.hasAttention(id)) {
            entry.monitor?.attend();
            return;
          }
          entry.watchingRinging = true;
        }

        this.notify(id);
      },
    });
  }

  // --- Terminal-report protocol track ---

  notifyFromProtocol(id: string, notification: ActivityNotification): void {
    const entry = this.getOrCreateEntry(id);
    const normalized = normalizeActivityNotification(notification);
    if (!normalized) return;

    if (this.hasAttention(id)) return;

    this.setProtocolRinging(id, entry, normalized);
  }

  updateProtocolProgress(id: string, progress: ProtocolProgressUpdate): void {
    const entry = this.getOrCreateEntry(id);

    if (progress.state === 'clear') {
      if (!entry.progress) return;
      this.completeProtocolProgress(id, entry, entry.progress);
      return;
    }

    if (progress.state === 'error') {
      this.ringOrSuppressProtocolProgress(id, entry, 'Progress error', progress.percent);
      return;
    }

    if (progress.state === 'normal' && progress.percent === 100) {
      this.completeProtocolProgress(id, entry, {
        state: entry.progress?.state === 'warning' ? 'warning' : 'normal',
        percent: progress.percent,
      });
      return;
    }

    if (
      entry.protocolStatus === 'OSC_NOTIF_BUSY'
      && !entry.attentionDismissedRing
      && entry.progress?.state === progress.state
      && entry.progress?.percent === progress.percent
    ) {
      return;
    }

    entry.progress = { state: progress.state, percent: progress.percent };
    entry.protocolStatus = 'OSC_NOTIF_BUSY';
    entry.attentionDismissedRing = false;
    this.notify(id);
  }

  private completeProtocolProgress(id: string, entry: AlertEntry, progress: ActiveProtocolProgress): void {
    const title = progress.state === 'warning' ? 'Progress warning' : 'Progress complete';
    this.ringOrSuppressProtocolProgress(id, entry, title, progress.percent);
  }

  private ringOrSuppressProtocolProgress(
    id: string,
    entry: AlertEntry,
    title: string,
    percent: number | null,
  ): void {
    if (this.hasAttention(id)) {
      entry.protocolStatus = 'IDLE';
      entry.progress = null;
      this.notify(id);
      return;
    }
    this.setProtocolRinging(id, entry, {
      source: 'OSC 9;4',
      title,
      body: percent === null ? null : `Progress ${Math.round(percent)}%`,
    });
  }

  private setProtocolRinging(id: string, entry: AlertEntry, notification: ActivityNotification): void {
    entry.notification = notification;
    entry.todo = true;
    entry.protocolStatus = 'ALERT_RINGING';
    entry.progress = null;
    entry.attentionDismissedRing = false;
    this.notify(id);
  }

  // --- Command-exit track ---

  applyTerminalSemanticEvents(id: string, events: TerminalSemanticEvent[]): void {
    if (events.length === 0) return;
    const entry = this.getOrCreateEntry(id);
    let changed = false;

    for (const event of events) {
      switch (event.type) {
        case 'commandLine':
          if (entry.pendingCommandLine !== event.commandLine) {
            entry.pendingCommandLine = event.commandLine;
            changed = true;
          }
          break;
        case 'commandStart':
          this.startCommandExitWatch(id, entry, event);
          changed = true;
          break;
        case 'commandFinish':
          changed = this.finishCommandExitWatch(id, entry, event.exitCode) || changed;
          break;
        case 'promptStart':
        case 'promptEnd':
          // A prompt means nothing is in the foreground any more, so WATCHING
          // stops here even if the shell never sent a finish event.
          if (entry.pendingCommandLine !== null || entry.commandExitWatch !== null) {
            this.finishCommandExitWatch(id, entry, undefined);
            changed = true;
          }
          break;
      }
    }

    if (changed) this.notify(id);
  }

  private startCommandExitWatch(
    id: string,
    entry: AlertEntry,
    event: Extract<TerminalSemanticEvent, { type: 'commandStart' }>,
  ): void {
    const resolved = resolveCommandStart(entry.pendingCommandLine, event);
    entry.pendingCommandLine = null;
    if (entry.commandExitStatus !== 'ALERT_RINGING') entry.commandExitStatus = 'IDLE';
    entry.commandExitWatch = {
      displayCommand: resolved.displayCommand,
      argv0: resolved.rawCommandLine === null ? null : commandArgv0(resolved.rawCommandLine),
      source: resolved.source,
      startedAt: resolved.startedAt,
      seenWithAttentionAt: this.hasAttention(id) ? Date.now() : null,
    };
    this.applyWatchingRule(id, entry);
  }

  private finishCommandExitWatch(
    id: string,
    entry: AlertEntry,
    exitCode: number | undefined,
  ): boolean {
    const watch = entry.commandExitWatch;
    entry.commandExitWatch = null;
    entry.pendingCommandLine = null;
    this.applyWatchingRule(id, entry);

    const wasArmed = entry.commandExitStatus === 'COMMAND_EXIT_ARMED';
    if (entry.commandExitStatus !== 'ALERT_RINGING') {
      entry.commandExitStatus = 'IDLE';
    }

    if (!watch || !wasArmed) return wasArmed;
    if (this.hasAttention(id)) return true;

    if (Date.now() - watch.startedAt < T_USER_ATTENTION) return true;

    this.setCommandExitRinging(id, entry, watch, exitCode);
    return true;
  }

  private markCommandExitSeen(entry: AlertEntry): void {
    const watch = entry.commandExitWatch;
    if (!watch) return;
    if (watch.seenWithAttentionAt === null) watch.seenWithAttentionAt = Date.now();
    if (entry.commandExitStatus === 'COMMAND_EXIT_ARMED') entry.commandExitStatus = 'IDLE';
  }

  private armCommandExitOnAttentionLoss(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.commandExitWatch) return false;
    if (entry.commandExitStatus !== 'IDLE') return false;
    if (entry.commandExitWatch.seenWithAttentionAt === null) return false;
    entry.commandExitStatus = 'COMMAND_EXIT_ARMED';
    entry.attentionDismissedRing = false;
    return true;
  }

  private setCommandExitRinging(
    id: string,
    entry: AlertEntry,
    watch: CommandExitWatch,
    exitCode: number | undefined,
  ): void {
    entry.commandExitStatus = 'ALERT_RINGING';
    entry.todo = true;
    // A protocol ring carries richer text; never overwrite it with the generic one.
    if (entry.protocolStatus !== 'ALERT_RINGING') {
      entry.notification = {
        source: 'COMMAND_EXIT',
        title: 'Command finished',
        body: formatCommandExitBody(watch.displayCommand, exitCode),
      };
    }
    entry.attentionDismissedRing = false;
    this.notify(id);
  }

  /** Release every latched ring across the three tracks. Returns whether any was active. */
  private clearAllRingsIfActive(entry: AlertEntry): boolean {
    let cleared = false;
    if (entry.protocolStatus === 'ALERT_RINGING') {
      entry.protocolStatus = 'IDLE';
      entry.progress = null;
      cleared = true;
    }
    if (entry.commandExitStatus === 'ALERT_RINGING') {
      entry.commandExitStatus = 'IDLE';
      cleared = true;
    }
    if (entry.watchingRinging) {
      entry.watchingRinging = false;
      cleared = true;
    }
    // A live monitor still latched at ALERT_RINGING would re-ring on its next
    // output, so release it too.
    if (entry.monitor?.getStatus() === 'ALERT_RINGING') entry.monitor.attend();
    return cleared;
  }

  // --- Attention tracking ---

  private hasAttention(id: string): boolean {
    return this.attentionId === id;
  }

  private clearAttentionTimer(): void {
    if (this.attentionTimer !== null) {
      clearTimeout(this.attentionTimer);
      this.attentionTimer = null;
    }
  }

  private setAttention(id: string): void {
    const previousAttentionId = this.attentionId;
    if (previousAttentionId && previousAttentionId !== id && this.armCommandExitOnAttentionLoss(previousAttentionId)) {
      this.notify(previousAttentionId);
    }
    this.attentionId = id;
    this.clearAttentionTimer();
    this.attentionTimer = setTimeout(() => {
      if (this.attentionId === id) {
        this.attentionId = null;
        if (this.armCommandExitOnAttentionLoss(id)) {
          this.notify(id);
        }
      }
      this.attentionTimer = null;
    }, T_USER_ATTENTION);
  }

  /** Mark that the user is paying attention to this session. */
  attend(id: string): void {
    const entry = this.getOrCreateEntry(id);
    this.setAttention(id);

    if (this.clearAllRingsIfActive(entry)) {
      entry.attentionDismissedRing = true;
      entry.todo = true;
    }
    this.markCommandExitSeen(entry);
    entry.monitor?.attend();
    this.notify(id);
  }

  clearAttention(id?: string): void {
    if (id !== undefined && this.attentionId !== id) return;
    const lostAttentionId = this.attentionId;
    this.attentionId = null;
    this.clearAttentionTimer();
    if (lostAttentionId && this.armCommandExitOnAttentionLoss(lostAttentionId)) {
      this.notify(lostAttentionId);
    }
  }

  // --- Alert controls ---

  dismissAlert(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const dismissed = this.clearAllRingsIfActive(entry);
    if (dismissed) entry.todo = true;
    // The flag exists so the next bell click opens the dialog instead of
    // silently changing a rule; an explicit dismiss *is* that next click.
    const hadFlag = entry.attentionDismissedRing;
    entry.attentionDismissedRing = false;

    if (dismissed || hadFlag) this.notify(id);
  }

  // --- Todo controls ---

  toggleTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    entry.todo = !entry.todo;
    if (!entry.todo) entry.notification = null;
    this.clearAllRingsIfActive(entry);
    this.notify(id);
  }

  markTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    const cleared = this.clearAllRingsIfActive(entry);
    if (entry.todo && !cleared) return;
    entry.todo = true;
    this.notify(id);
  }

  clearTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    if (!entry.todo) return;
    entry.todo = false;
    entry.notification = null;
    this.clearAllRingsIfActive(entry);
    this.notify(id);
  }

  // --- Query ---

  getState(id: string): AlertState {
    const entry = this.entries.get(id);
    if (!entry) return DEFAULT_ALERT_STATE;
    return {
      status: this.getProjectedStatus(entry),
      watchingEnabled: !!entry.monitor,
      todo: entry.todo,
      notification: entry.notification,
      attentionDismissedRing: entry.attentionDismissedRing,
    };
  }

  getAllStates(): Map<string, AlertState> {
    const result = new Map<string, AlertState>();
    for (const [id] of this.entries) {
      result.set(id, this.getState(id));
    }
    return result;
  }

  /** Completely remove alert state for a PTY (used when PTY is destroyed) */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.monitor?.dispose();
    this.entries.delete(id);
    if (this.attentionId === id) {
      this.attentionId = null;
      this.clearAttentionTimer();
    }
    this.notify(id);
  }

  /**
   * Seed alert state from a persisted session (cold-start restore). Only the
   * TODO reminder and its notification detail survive a restart — WATCHING is
   * re-derived from the rule set at the next command start, and restore must
   * never resurrect a ring or an in-flight progress cycle.
   */
  seed(id: string, state: { todo: unknown; notification?: unknown }): void {
    const entry = this.getOrCreateEntry(id);
    entry.todo = state.todo === true;
    entry.notification = entry.todo ? normalizeActivityNotification(state.notification) : null;
    entry.watchingRinging = false;
    entry.protocolStatus = 'IDLE';
    entry.progress = null;
    entry.commandExitStatus = 'IDLE';
    entry.commandExitWatch = null;
    entry.pendingCommandLine = null;
    this.notify(id);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.monitor?.dispose();
    }
    this.entries.clear();
    this.listeners.clear();
    this.lastEmitted.clear();
    this.clearAttentionTimer();
  }

  // --- Internals ---

  private getProjectedStatus(entry: AlertEntry): SessionStatus {
    if (
      entry.protocolStatus === 'ALERT_RINGING'
      || entry.commandExitStatus === 'ALERT_RINGING'
      || entry.watchingRinging
    ) return 'ALERT_RINGING';
    if (entry.protocolStatus === 'OSC_NOTIF_BUSY') return 'OSC_NOTIF_BUSY';
    // WATCHING outranks the command-exit arm: a watched command is by
    // definition running, so COMMAND_EXIT_ARMED would otherwise mask the
    // monitor's busy/quiet states for the entire run. The monitor is derived
    // from real output, so it is the more informative of the two.
    if (entry.monitor) return entry.monitor.getStatus();
    if (entry.commandExitStatus === 'COMMAND_EXIT_ARMED') return 'COMMAND_EXIT_ARMED';
    return 'WATCHING_DISABLED';
  }

  private getOrCreateEntry(id: string): AlertEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        monitor: null,
        watchingRinging: false,
        protocolStatus: 'IDLE',
        progress: null,
        commandExitStatus: 'IDLE',
        commandExitWatch: null,
        pendingCommandLine: null,
        todo: false,
        notification: null,
        attentionDismissedRing: false,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private notify(id: string): void {
    const state = this.getState(id);
    const last = this.lastEmitted.get(id);
    if (last && alertStatesEqual(last, state)) return;
    if (this.entries.has(id)) {
      this.lastEmitted.set(id, state);
    } else {
      this.lastEmitted.delete(id);
    }
    for (const listener of this.listeners) {
      listener(id, state);
    }
  }
}

function alertStatesEqual(a: AlertState, b: AlertState): boolean {
  if (
    a.status !== b.status
    || a.watchingEnabled !== b.watchingEnabled
    || a.todo !== b.todo
    || a.attentionDismissedRing !== b.attentionDismissedRing
  ) return false;
  const an = a.notification;
  const bn = b.notification;
  if (an === bn) return true;
  if (an === null || bn === null) return false;
  return an.source === bn.source && an.title === bn.title && an.body === bn.body;
}

function formatCommandExitBody(displayCommand: string, exitCode: number | undefined): string {
  const command = displayCommand.trim() || DEFAULT_COMMAND_TITLE;
  if (exitCode === undefined) return command;
  return `${command} exited ${exitCode}`;
}
