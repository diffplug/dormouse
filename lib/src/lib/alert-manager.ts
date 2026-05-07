import { ActivityMonitor, type SessionStatus } from './activity-monitor';
import { cfg } from '../cfg';

export { type SessionStatus } from './activity-monitor';

/** Boolean TODO state: on (true) or off (false). */
export type TodoState = boolean;

export const ACTIVITY_NOTIFICATION_SOURCES = ['OSC 9', 'OSC 9;4', 'OSC 99', 'OSC 777', 'BEL'] as const;
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
type ActiveProtocolProgressState = 'normal' | 'warning' | 'indeterminate';

interface ActiveProtocolProgress {
  state: ActiveProtocolProgressState;
  percent: number | null;
}

/** Migrate legacy persisted TodoState values (numeric, string, boolean) to a boolean. */
export function migrateTodoState(todo: unknown): TodoState {
  if (typeof todo === 'boolean') return todo;
  // v2 numeric encoding: -1 = off, [0,1] = soft, 2 = hard
  if (typeof todo === 'number') return Number.isFinite(todo) && (todo === 2 || (todo >= 0 && todo <= 1));
  // v1 string encoding: 'soft' | 'hard' | false
  if (todo === 'hard' || todo === 'soft') return true;
  return false;
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

export type AlertButtonActionResult = 'enabled' | 'disabled' | 'dismissed' | 'noop';

export interface AlertState {
  status: SessionStatus;
  todo: TodoState;
  notification: ActivityNotification | null;
  /** Used by dismissOrToggleAlert to detect post-attention dismiss */
  attentionDismissedRing: boolean;
}

export const DEFAULT_ALERT_STATE: AlertState = {
  status: 'ALERT_DISABLED',
  todo: false,
  notification: null,
  attentionDismissedRing: false,
};

interface AlertEntry {
  monitor: ActivityMonitor | null;
  protocolStatus: ProtocolStatus;
  progress: ActiveProtocolProgress | null;
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

  // Intentional no-op: the monitor detects silence and transitions naturally,
  // and we keep the entry so alert/todo state survives the PTY exit.
  onExit(_id: string): void {}

  onResize(id: string): void {
    const entry = this.entries.get(id);
    entry?.monitor?.onResize();
  }

  // --- Terminal-report protocol track ---

  notifyFromProtocol(id: string, notification: ActivityNotification): void {
    const entry = this.getOrCreateEntry(id);
    const normalized = normalizeActivityNotification(notification);
    if (!normalized) return;

    if (this.hasAttention(id)) {
      if (this.clearProtocolProgress(entry)) this.notify(id);
      return;
    }

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
      this.clearProtocolProgress(entry);
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

  private clearProtocolRingIfActive(entry: AlertEntry): boolean {
    if (entry.protocolStatus !== 'ALERT_RINGING') return false;
    entry.protocolStatus = 'IDLE';
    entry.progress = null;
    return true;
  }

  private clearProtocolProgress(entry: AlertEntry): boolean {
    if (entry.protocolStatus === 'IDLE' && entry.progress === null) return false;
    entry.protocolStatus = 'IDLE';
    entry.progress = null;
    return true;
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
    this.attentionId = id;
    this.clearAttentionTimer();
    this.attentionTimer = setTimeout(() => {
      if (this.attentionId === id) {
        this.attentionId = null;
      }
      this.attentionTimer = null;
    }, T_USER_ATTENTION);
  }

  /**
   * Mark that the user is paying attention to this session.
   * Equivalent to the old markSessionAttention.
   */
  attend(id: string): void {
    const entry = this.getOrCreateEntry(id);
    const previousVisualStatus = entry.monitor?.getStatus();
    const protocolWasRinging = entry.protocolStatus === 'ALERT_RINGING';
    this.setAttention(id);

    if (protocolWasRinging) {
      entry.attentionDismissedRing = true;
      entry.todo = true;
      entry.protocolStatus = 'IDLE';
      entry.progress = null;
    }
    if (previousVisualStatus === 'ALERT_RINGING') {
      entry.attentionDismissedRing = true;
      entry.todo = true;
    }
    entry.monitor?.attend();
    this.notify(id);
  }

  clearAttention(id?: string): void {
    if (id !== undefined && this.attentionId !== id) return;
    this.attentionId = null;
    this.clearAttentionTimer();
  }

  // --- Monitor lifecycle ---

  private createMonitor(id: string): ActivityMonitor {
    return new ActivityMonitor({
      hasAttention: () => this.hasAttention(id),
      onChange: (_status) => {
        const entry = this.entries.get(id);
        if (!entry) return;

        // If the session has attention when it would ring, suppress by resetting
        if (_status === 'ALERT_RINGING' && this.hasAttention(id)) {
          entry.monitor?.attend();
          return;
        }

        this.notify(id);
      },
    });
  }

  // --- Alert controls ---

  toggleAlert(id: string): void {
    const entry = this.getOrCreateEntry(id);
    if (entry.monitor) {
      entry.monitor.dispose();
      entry.monitor = null;
    } else {
      entry.monitor = this.createMonitor(id);
    }
    entry.attentionDismissedRing = false;
    this.notify(id);
  }

  disableAlert(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.monitor) return;
    entry.monitor.dispose();
    entry.monitor = null;
    entry.attentionDismissedRing = false;
    this.notify(id);
  }

  dismissAlert(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const dismissed = this.clearProtocolRingIfActive(entry);
    if (dismissed) entry.todo = true;

    if (entry.monitor?.getStatus() === 'ALERT_RINGING') {
      entry.todo = true;
      entry.monitor.attend();
      return; // onChange fires → notify
    }

    if (dismissed) this.notify(id);
  }

  /**
   * Apply the bell-button transition table.
   * Returns the action result synchronously.
   */
  dismissOrToggleAlert(id: string, displayedStatus: SessionStatus): AlertButtonActionResult {
    const entry = this.entries.get(id);
    if (!entry) {
      // No entry yet — treat as ALERT_DISABLED → enable
      this.toggleAlert(id);
      return 'enabled';
    }

    switch (displayedStatus) {
      case 'ALERT_DISABLED':
        this.toggleAlert(id);
        return 'enabled';
      case 'ALERT_RINGING':
        this.dismissAlert(id);
        return 'dismissed';
      case 'OSC_NOTIF_BUSY':
        if (entry.attentionDismissedRing) {
          entry.attentionDismissedRing = false;
          this.notify(id);
          return 'dismissed';
        }
        if (!entry.monitor) return 'noop';
        this.disableAlert(id);
        return 'disabled';
      default:
        if (entry.attentionDismissedRing) {
          entry.attentionDismissedRing = false;
          this.notify(id);
          return 'dismissed';
        }
        this.disableAlert(id);
        return 'disabled';
    }
  }

  // --- Todo controls ---

  toggleTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    const nextTodo = !entry.todo;
    entry.todo = nextTodo;

    if (!nextTodo) {
      entry.notification = null;
      this.clearProtocolRingIfActive(entry);
      this.notify(id);
      return;
    }

    this.clearProtocolRingIfActive(entry);
    if (entry.monitor?.getStatus() === 'ALERT_RINGING') {
      entry.monitor.attend();
      return; // onChange fires → notify
    }
    this.notify(id);
  }

  markTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    const isVisualRinging = entry.monitor?.getStatus() === 'ALERT_RINGING';
    const wasProtocolRinging = entry.protocolStatus === 'ALERT_RINGING';
    if (entry.todo && !wasProtocolRinging && !isVisualRinging) return;

    entry.todo = true;
    this.clearProtocolRingIfActive(entry);
    if (isVisualRinging) {
      entry.monitor!.attend();
      return; // onChange fires → notify
    }
    this.notify(id);
  }

  clearTodo(id: string): void {
    const entry = this.getOrCreateEntry(id);
    if (!entry.todo) return;
    entry.todo = false;
    entry.notification = null;
    this.clearProtocolRingIfActive(entry);
    this.notify(id);
  }

  // --- Query ---

  getState(id: string): AlertState {
    const entry = this.entries.get(id);
    if (!entry) return DEFAULT_ALERT_STATE;
    return {
      status: this.getProjectedStatus(entry),
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
   * Seed alert state from a persisted session (cold-start restore).
   * Creates an entry with the saved todo state and, if the visual alert was enabled,
   * creates a fresh ActivityMonitor (it will start in NOTHING_TO_SHOW until
   * PTY data arrives).
   */
  seed(id: string, state: { status: string; todo: unknown; notification?: unknown }): void {
    const entry = this.getOrCreateEntry(id);
    entry.todo = migrateTodoState(state.todo);
    entry.notification = entry.todo ? normalizeActivityNotification(state.notification) : null;
    entry.protocolStatus = 'IDLE';
    entry.progress = null;

    if (state.status !== 'ALERT_DISABLED' && state.status !== 'OSC_NOTIF_BUSY') {
      if (!entry.monitor) {
        entry.monitor = this.createMonitor(id);
      }
    }
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
    const visualStatus = entry.monitor?.getStatus() ?? 'ALERT_DISABLED';
    if (entry.protocolStatus === 'ALERT_RINGING') return 'ALERT_RINGING';
    if (visualStatus === 'ALERT_RINGING') return 'ALERT_RINGING';
    if (entry.protocolStatus === 'OSC_NOTIF_BUSY') return 'OSC_NOTIF_BUSY';
    return visualStatus;
  }

  private getOrCreateEntry(id: string): AlertEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        monitor: null,
        protocolStatus: 'IDLE',
        progress: null,
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
  if (a.status !== b.status || a.todo !== b.todo || a.attentionDismissedRing !== b.attentionDismissedRing) return false;
  const an = a.notification;
  const bn = b.notification;
  if (an === bn) return true;
  if (an === null || bn === null) return false;
  return an.source === bn.source && an.title === bn.title && an.body === bn.body;
}
