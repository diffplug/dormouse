import type { AlertState, SessionStatus } from './alert-manager';
import type { AlertStateDetail } from './platform/types';
import { applyAlertSettingsFromHost, publishAlertSettings } from './alert-settings';
import { toPersistedAlertState, type PersistedAlertState, type PersistedPane } from './session-types';
import { getPlatform } from './platform';
import { getRunningCommandArgv0 } from './terminal-state-store';
import {
  applyWatchedCommandsFromHost,
  isCommandWatched,
  publishWatchedCommands,
  setCommandWatched,
} from './watched-commands';
import { registry } from './terminal-store';

/**
 * What the bell click resolved to, so the caller knows whether to open the
 * alert dialog. `no-command` means the pane is at a prompt: WATCHING is keyed
 * on the running command, so there is nothing to enable.
 */
export type AlertButtonActionResult = 'enabled' | 'disabled' | 'dismissed' | 'menu' | 'no-command' | 'noop';

export type ActivityState = Omit<AlertState, 'attentionDismissedRing'>;

export const DEFAULT_ACTIVITY_STATE: ActivityState = {
  status: 'WATCHING_DISABLED',
  watchingEnabled: false,
  todo: false,
  notification: null,
  awaited: false,
  ringSeq: 0,
};

const activityListeners = new Set<() => void>();
let cachedSnapshot: Map<string, ActivityState> | null = null;

// Terminal activity keeps the same home before and after xterm initialization.
// The dismissal flag belongs to the bell action, not the public UI snapshot.
const terminalActivity = new Map<string, { state: ActivityState; attentionDismissedRing: boolean }>();

// Browser surfaces have no host alert stream. Keep their TODO separate so a
// terminal taking the same id starts from its own activity, and clearing
// terminal activity never removes a browser TODO.
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
  return terminalActivity.get(id)?.state
    ?? (registry.has(id) ? DEFAULT_ACTIVITY_STATE : localSurfaceActivity.get(id) ?? null);
}

export function getLivePersistedAlertState(id: string): PersistedAlertState | null {
  return registry.has(id) ? toPersistedAlertState(getActivity(id)) : null;
}

/** Install a host snapshot, including one received before xterm initialization. */
export function setTerminalActivity(id: string, state: Partial<AlertState>): void {
  const { attentionDismissedRing = false, ...activity } = state;
  terminalActivity.set(id, {
    state: { ...DEFAULT_ACTIVITY_STATE, ...activity },
    attentionDismissedRing,
  });
  notifyActivityListeners();
}

/** Called after registry removal, or without an id to reset the terminal cache. */
export function clearTerminalActivity(id?: string): void {
  if (id === undefined) {
    if (terminalActivity.size === 0) return;
    terminalActivity.clear();
  } else {
    terminalActivity.delete(id);
  }
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

/**
 * The bell-button transition table (`docs/specs/alert.md` -> UI Contract). This
 * is the only copy: WATCHING is a rule keyed on the foreground command's name,
 * so enabling and disabling both resolve to a rule-set edit, and the manager
 * learns about it through a command-level mutation like any other rule change.
 */
export function dismissOrToggleAlert(id: string, displayedStatus: SessionStatus): AlertButtonActionResult {
  if (displayedStatus === 'ALERT_RINGING') {
    dismissSessionAlert(id);
    return 'dismissed';
  }

  // An attention-based dismissal leaves a flag behind so this next click opens
  // the dialog rather than silently editing a rule.
  if (terminalActivity.get(id)?.attentionDismissedRing) {
    dismissSessionAlert(id);
    return 'dismissed';
  }

  // Everything else is "turn the rule for the running command on or off".
  const argv0 = getRunningCommandArgv0(id);
  if (!argv0) return 'no-command';

  if (isCommandWatched(argv0)) {
    setCommandWatched(argv0, false);
    return 'disabled';
  }

  // A protocol/command-exit alarm needs no rule, so clicking through one would
  // enable WATCHING by surprise. Show the detail dialog instead.
  if (displayedStatus === 'OSC_NOTIF_BUSY' || displayedStatus === 'COMMAND_EXIT_ARMED') return 'menu';

  setCommandWatched(argv0, true);
  return 'enabled';
}

/** Turn the rule for whatever `id` is running on/off; no-op at a prompt. */
export function toggleSessionAlert(id: string): void {
  const argv0 = getRunningCommandArgv0(id);
  if (argv0) setCommandWatched(argv0, !isCommandWatched(argv0));
}

export function disableSessionAlert(id: string): void {
  const argv0 = getRunningCommandArgv0(id);
  if (argv0) setCommandWatched(argv0, false);
}

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
