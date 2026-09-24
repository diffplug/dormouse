import { createAlertEpisode } from './alert-episode';
import { DEFAULT_ALERT_STATE, type AlertState } from './alert-manager';
import type { AlertStateDetail } from './platform/types';
import { applyAlertSettingsFromHost, publishAlertSettings } from './alert-settings';
import { toPersistedAlertState, type PersistedAlertState, type PersistedPane } from './session-types';
import { getPlatform } from './platform';
import { applyWatchedCommandsFromHost, publishWatchedCommands } from './watched-commands';
import { registry } from './terminal-store';

export type ActivityState = AlertState;

export const DEFAULT_ACTIVITY_STATE: ActivityState = DEFAULT_ALERT_STATE;

const activityListeners = new Set<(changedId?: string) => void>();
let cachedSnapshot: Map<string, ActivityState> | null = null;

// Terminal activity keeps the same home before and after xterm initialization.
const terminalActivity = new Map<string, ActivityState>();

// Browser surfaces have no host alert stream. Keep their TODO separate so a
// terminal taking the same id starts from its own activity, and clearing
// terminal activity never removes a browser TODO.
const localSurfaceActivity = new Map<string, ActivityState>();

/** `changedId` names the one Surface whose activity moved, so a listener scoped
 *  to a subset of the Window can ignore the rest. Omitting it means a store-wide
 *  change every listener must take. */
export function notifyActivityListeners(changedId?: string): void {
  cachedSnapshot = null;
  activityListeners.forEach((listener) => listener(changedId));
}

export function subscribeToActivity(listener: (changedId?: string) => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

export function getActivitySnapshot(): Map<string, ActivityState> {
  if (cachedSnapshot) return cachedSnapshot;

  const snapshot = new Map<string, ActivityState>();
  const ids = new Set([...registry.keys(), ...terminalActivity.keys(), ...localSurfaceActivity.keys()]);
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

function readActivity(id: string): ActivityState | null {
  return terminalActivity.get(id)
    ?? (registry.has(id) ? DEFAULT_ACTIVITY_STATE : localSurfaceActivity.get(id) ?? null);
}

export function getLivePersistedAlertState(id: string): PersistedAlertState | null {
  return registry.has(id) ? toPersistedAlertState(getActivity(id)) : null;
}

/** Install a host snapshot, including one received before xterm initialization. */
export function setTerminalActivity(id: string, state: Partial<AlertState>): void {
  const previous = terminalActivity.get(id);
  // Older hosts and local fixtures have no episode field. Hydrate their status
  // edges here; consumers still seed first-observed rings without delivery.
  const episode = state.status === 'ALERT_RINGING'
    ? state.episode ?? (previous?.status === 'ALERT_RINGING' ? previous.episode : null) ?? createAlertEpisode()
    : null;
  terminalActivity.set(id, { ...DEFAULT_ACTIVITY_STATE, ...state, episode });
  notifyActivityListeners(id);
}

/** Called after registry removal, or without an id to reset the terminal cache. */
export function clearTerminalActivity(id?: string): void {
  if (id === undefined) {
    if (terminalActivity.size === 0) return;
    terminalActivity.clear();
  } else {
    terminalActivity.delete(id);
  }
  notifyActivityListeners(id);
}

/**
 * Drop the activity for a non-PTY surface. Called when a browser pane is killed
 * or replaced (Wall.tsx) so its TODO doesn't outlive the pane or leak onto a
 * later terminal that reuses the id.
 */
export function clearLocalSurfaceActivity(id: string): void {
  if (!localSurfaceActivity.delete(id)) return;
  notifyActivityListeners(id);
}

function setLocalSurfaceTodo(id: string, todo: boolean): void {
  if (!todo) {
    clearLocalSurfaceActivity(id);
    return;
  }

  localSurfaceActivity.set(id, { ...DEFAULT_ACTIVITY_STATE, todo: true });
  notifyActivityListeners(id);
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

function handleAlertState({ id, ...state }: AlertStateDetail): void {
  setTerminalActivity(id, state);
}

/**
 * Subscribe the renderer to the host's alert channels and offer it our
 * persisted app-global state.
 *
 * Safe to call more than once — Pocket and the website playground call it from
 * an effect. Every handler here is a stable module-level function and adapters
 * hold handlers in a `Set`, so re-registering is a no-op and no deregistration
 * bookkeeping is needed.
 */
export function initAlertStateReceiver(): void {
  const platform = getPlatform();
  platform.onAlertState(handleAlertState);
  platform.onWatchedCommands(applyWatchedCommandsFromHost);
  platform.onAlertSettings(applyAlertSettingsFromHost);
  // The host cannot read renderer localStorage. Offer our persisted copies as
  // its startup seed after installing the canonical-snapshot listeners, so a
  // second VS Code webview is corrected rather than replacing shared state.
  publishWatchedCommands();
  publishAlertSettings();
}

/** The whole of the alert action: a ring goes quiet (leaving its TODO) and the
 *  caller opens the terminal context (`docs/specs/alert.md` -> Pane Header). */
export function dismissSessionAlert(id: string): void {
  getPlatform().alertDismiss(id);
}

export function markSessionAttention(id: string): void {
  getPlatform().alertAttend(id);
}

export function clearSessionAttention(id?: string): void {
  getPlatform().alertClearAttention(id);
}

export function toggleSessionTodo(id: string): void {
  if (!registry.has(id)) {
    setLocalSurfaceTodo(id, !getActivity(id).todo);
    return;
  }
  getPlatform().alertToggleTodo(id);
}

export function markSessionTodo(id: string): void {
  if (!registry.has(id)) {
    setLocalSurfaceTodo(id, true);
    return;
  }
  getPlatform().alertMarkTodo(id);
}

export function clearSessionTodo(id: string): void {
  if (!registry.has(id)) {
    setLocalSurfaceTodo(id, false);
    return;
  }
  getPlatform().alertClearTodo(id);
}
