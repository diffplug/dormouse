import type { AwaitOutcome, AwaitUntil, Engagement, EngagementLapse } from '../lib/alert-manager';
import type { AlertSettings } from '../lib/alert-settings-model';
import type { PersistedAlertState } from '../lib/session-types';

/**
 * The wire between a standalone window and the sidecar's alerts: the commands
 * a window sends (`lib/src/host/alert-client.ts`) and the events the sidecar
 * answers with (`lib/src/host/alert-host.ts`).
 */

/**
 * What a window asks, on the one `alert_command` passthrough. The host stamps
 * the asking window's label as `window`; a webview never names itself.
 */
export type AlertCommand =
  /** A window (re)initialized: whatever its previous realm engaged or parked is gone. */
  | { op: 'hello' }
  | { op: 'initializeWatchedCommands'; names: string[] }
  | { op: 'setCommandWatched'; name: string; watched: boolean }
  | { op: 'initializeSettings' | 'updateSettings'; settings: AlertSettings }
  | { op: 'engagement'; state: Engagement; lapse?: EngagementLapse }
  | { op: 'acknowledge' | 'dismiss' | 'toggleTodo' | 'clearTodo' | 'resize' | 'remove'; id: string }
  | { op: 'seed'; id: string; state: PersistedAlertState }
  | { op: 'await'; awaitId: string; id: string; until: AwaitUntil; timeoutMs: number }
  | { op: 'awaitCancel'; awaitId: string };

export const ALERT_STATE_EVENT = 'alert:state';
export const ALERT_AWAIT_RESULT_EVENT = 'alert:awaitResult';

/**
 * One await's outcome, broadcast to every window: the asking adapter matches
 * its own random `awaitId`. **Never carries a Session `id`**, which would route
 * it to that Session's owner rather than the window that asked, and **never a
 * `requestId`**, which Rust swallows to resolve its own invokes.
 */
export interface AlertAwaitResult {
  awaitId: string;
  window: string;
  outcome: AwaitOutcome;
}
