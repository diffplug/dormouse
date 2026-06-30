import type { SessionStatus } from './activity-monitor';
import type { AlertButtonActionResult } from './alert-manager';
import type { AlertStateDetail } from './platform/types';
import type { PersistedAlertState, PersistedPane } from './session-types';
import { getPlatform } from './platform';
import {
  getEntryByPtyId,
  registry,
  resolveTerminalSessionId,
  type ActivityState,
} from './terminal-store';

export type { ActivityState } from './terminal-store';

export const DEFAULT_ACTIVITY_STATE: ActivityState = {
  status: 'WATCHING_DISABLED',
  watchingEnabled: false,
  todo: false,
  notification: null,
};

const activityListeners = new Set<() => void>();
let cachedSnapshot: Map<string, ActivityState> | null = null;

// Transient staging for activity that arrives *before* a terminal registry entry
// exists. Consumed and deleted when the entry is minted (consumePrimedActivity).
const primedActivityStates = new Map<string, Partial<ActivityState>>();

// Persistent activity for non-PTY surfaces (browser iframes / agent-browser).
// A browser surface never gets a registry entry, so — unlike primedActivityStates
// — this is its permanent home: keyed by pane id, written when its TODO toggles
// or is restored, and cleared only when the pane is killed or replaced
// (clearLocalSurfaceActivity). Kept separate so terminal creation never consumes
// it and a no-arg primed reset never wipes it.
const localSurfaceActivity = new Map<string, ActivityState>();

export function notifyActivityListeners(): void {
  cachedSnapshot = null;
  activityListeners.forEach((listener) => listener());
}

export function subscribeToActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

export function getActivitySnapshot(): Map<string, ActivityState> {
  if (cachedSnapshot) return cachedSnapshot;

  const snapshot = new Map<string, ActivityState>();
  const ids = new Set<string>([...registry.keys(), ...primedActivityStates.keys(), ...localSurfaceActivity.keys()]);
  for (const id of ids) {
    const state = readActivity(id);
    if (state) {
      snapshot.set(id, state);
    }
  }
  cachedSnapshot = snapshot;
  return snapshot;
}

export function getActivity(id: string): ActivityState {
  return readActivity(id) ?? DEFAULT_ACTIVITY_STATE;
}

function readLiveActivity(id: string): ActivityState | null {
  const entry = registry.get(id);
  if (!entry) return null;

  return {
    status: entry.alertStatus,
    watchingEnabled: entry.watchingEnabled,
    todo: entry.todo,
    notification: entry.notification,
  };
}

function readActivity(id: string): ActivityState | null {
  const primedState = primedActivityStates.get(id);
  const liveState = readLiveActivity(id);
  const localState = localSurfaceActivity.get(id);

  if (!liveState && !primedState && !localState) return null;
  // A live PTY is authoritative, so it outranks a stale local-surface entry left
  // behind if an id is reused; primed staging overrides on top.
  return {
    ...(liveState ?? localState ?? DEFAULT_ACTIVITY_STATE),
    ...primedState,
  };
}

export function getLivePersistedAlertState(id: string): PersistedAlertState | null {
  const state = readLiveActivity(id);
  if (!state) return null;
  return {
    status: state.status,
    watchingEnabled: state.watchingEnabled,
    todo: state.todo,
    notification: state.notification,
  };
}

export function primeActivity(id: string, state: Partial<ActivityState>): void {
  primedActivityStates.set(id, state);
  notifyActivityListeners();
}

export function clearPrimedActivity(id?: string): void {
  if (id === undefined) {
    if (primedActivityStates.size === 0) return;
    primedActivityStates.clear();
    notifyActivityListeners();
    return;
  }

  if (!primedActivityStates.delete(id)) return;
  notifyActivityListeners();
}

/**
 * Drop the activity for a non-PTY surface. Called when a browser pane is killed
 * or replaced (Wall.tsx) so its TODO doesn't outlive the pane or leak onto a
 * later terminal that reuses the id.
 */
export function clearLocalSurfaceActivity(id: string): void {
  if (!localSurfaceActivity.delete(id)) return;
  notifyActivityListeners();
}

function setLocalSurfaceTodo(id: string, todo: boolean): void {
  if (!todo) {
    clearLocalSurfaceActivity(id);
    return;
  }

  localSurfaceActivity.set(id, { ...DEFAULT_ACTIVITY_STATE, todo: true });
  notifyActivityListeners();
}

/**
 * Restore a browser surface's persisted TODO into the local activity store.
 * Browser surfaces have no PTY, so the TODO is reconstructed from the saved pane
 * (the `alert` blob) rather than replayed from a PTY alert. Shared by the cold
 * restore (session-restore.ts) and live resume (reconnect.ts) paths.
 */
export function restoreBrowserSurfaceTodo(pane: Pick<PersistedPane, 'id' | 'surfaceType' | 'alert'>): void {
  if (pane.surfaceType === 'browser' && pane.alert?.todo === true) {
    setLocalSurfaceTodo(pane.id, true);
  }
}

export function consumePrimedActivity(id: string): Partial<ActivityState> | undefined {
  const primed = primedActivityStates.get(id);
  if (primed) {
    primedActivityStates.delete(id);
  }
  return primed;
}

let currentAlertHandler: ((detail: AlertStateDetail) => void) | null = null;

export function initAlertStateReceiver(): void {
  const platform = getPlatform();
  if (currentAlertHandler) {
    platform.offAlertState(currentAlertHandler);
  }

  currentAlertHandler = (detail) => {
    const entry = getEntryByPtyId(detail.id);
    if (entry) {
      entry.alertStatus = detail.status;
      entry.watchingEnabled = detail.watchingEnabled;
      entry.todo = detail.todo;
      entry.notification = detail.notification;
      entry.attentionDismissedRing = detail.attentionDismissedRing;
      primedActivityStates.delete(detail.id);
      notifyActivityListeners();
    } else {
      primeActivity(detail.id, {
        status: detail.status,
        watchingEnabled: detail.watchingEnabled,
        todo: detail.todo,
        notification: detail.notification,
      });
    }
  };
  platform.onAlertState(currentAlertHandler);
}

export function dismissOrToggleAlert(id: string, displayedStatus: SessionStatus): AlertButtonActionResult {
  const entry = registry.get(id);
  let result: AlertButtonActionResult;
  switch (displayedStatus) {
    case 'WATCHING_DISABLED':
      result = 'enabled';
      break;
    case 'ALERT_RINGING':
      result = 'dismissed';
      break;
    case 'OSC_NOTIF_BUSY':
    case 'COMMAND_EXIT_ARMED':
      result = entry?.attentionDismissedRing ? 'dismissed' : entry?.watchingEnabled ? 'disabled' : 'menu';
      break;
    default:
      if (entry?.attentionDismissedRing) {
        result = 'dismissed';
        break;
      }
      result = 'disabled';
  }
  getPlatform().alertDismissOrToggle(resolveTerminalSessionId(id), displayedStatus);
  return result;
}

export function toggleSessionAlert(id: string): void {
  getPlatform().alertToggle(resolveTerminalSessionId(id));
}

export function disableSessionAlert(id: string): void {
  getPlatform().alertDisable(resolveTerminalSessionId(id));
}

export function dismissSessionAlert(id: string): void {
  getPlatform().alertDismiss(resolveTerminalSessionId(id));
}

export function markSessionAttention(id: string): void {
  getPlatform().alertAttend(resolveTerminalSessionId(id));
}

export function clearSessionAttention(id?: string): void {
  getPlatform().alertClearAttention(id === undefined ? undefined : resolveTerminalSessionId(id));
}

export function toggleSessionTodo(id: string): void {
  if (!registry.has(id)) {
    setLocalSurfaceTodo(id, !getActivity(id).todo);
    return;
  }
  getPlatform().alertToggleTodo(resolveTerminalSessionId(id));
}

export function markSessionTodo(id: string): void {
  if (!registry.has(id)) {
    setLocalSurfaceTodo(id, true);
    return;
  }
  getPlatform().alertMarkTodo(resolveTerminalSessionId(id));
}

export function clearSessionTodo(id: string): void {
  if (!registry.has(id)) {
    setLocalSurfaceTodo(id, false);
    return;
  }
  getPlatform().alertClearTodo(resolveTerminalSessionId(id));
}
