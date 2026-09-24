import type { AwaitOutcome, AwaitUntil, Engagement, EngagementLapse } from '../lib/alert-manager';
import type { AlertSettings } from '../lib/alert-settings-model';
import type { AlertStateDetail } from '../lib/platform/types';

/**
 * The wire between a renderer realm and its host's alerts, the same in both
 * hosts: the commands a realm sends (`lib/src/host/alert-client.ts`) and the
 * events the host answers with (`lib/src/host/alert-host.ts`). VS Code carries
 * a command as `alert:command {command}`; standalone as the `alert_command`
 * passthrough, which Rust stamps with the asking window's label.
 */
export type AlertCommand =
  /** A realm (re)initialized: whatever its previous realm engaged or parked is gone. */
  | { op: 'hello' }
  /** Re-send this realm its Sessions' state and both stores, ending nothing. */
  | { op: 'sync' }
  | { op: 'initializeWatchedCommands'; names: string[] }
  | { op: 'setCommandWatched'; name: string; watched: boolean }
  | { op: 'initializeSettings' | 'updateSettings'; settings: AlertSettings }
  | { op: 'engagement'; state: Engagement; lapse?: EngagementLapse }
  | { op: 'acknowledge' | 'dismiss' | 'toggleTodo' | 'clearTodo'; id: string }
  | { op: 'await'; awaitId: string; id: string; until: AwaitUntil; timeoutMs: number }
  | { op: 'awaitCancel'; awaitId: string };

/** One await's outcome, to the realm that parked it, under the id it minted. */
export interface AlertAwaitResult {
  awaitId: string;
  outcome: AwaitOutcome;
}

/** Every event a host's alerts send a realm, by name. */
export interface AlertEvents {
  /** One Session's state, to the realm that shows it. */
  'alert:state': AlertStateDetail;
  /** `forWindow`: standalone names the window that parked the await, which
   *  Rust routes it to (`docs/specs/standalone.md` → "Routing"). */
  'alert:awaitResult': AlertAwaitResult & { forWindow?: string };
  /** The app-global stores' canonical snapshots, to every realm. */
  'alert:watchedCommands': { names: string[] };
  'alert:settings': { settings: AlertSettings };
}

export const ALERT_EVENTS = [
  'alert:state',
  'alert:awaitResult',
  'alert:watchedCommands',
  'alert:settings',
] as const satisfies ReadonlyArray<keyof AlertEvents>;

export type AlertEventName = (typeof ALERT_EVENTS)[number];

export function isAlertEvent(event: string): event is AlertEventName {
  return (ALERT_EVENTS as readonly string[]).includes(event);
}
