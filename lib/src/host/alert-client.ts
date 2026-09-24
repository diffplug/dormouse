import type { AwaitHandle, AwaitOptions, AwaitOutcome, Engagement, EngagementLapse } from '../lib/alert-manager';
import type { AlertSettings } from '../lib/alert-settings-model';
import type { AlertStateDetail, PlatformAdapter } from '../lib/platform/types';
import type { PersistedAlertState } from '../lib/session-types';
import {
  ALERT_AWAIT_RESULT_EVENT,
  ALERT_STATE_EVENT,
  type AlertAwaitResult,
  type AlertCommand,
} from './alert-protocol';

/**
 * A standalone window's end of the sidecar's alerts (`lib/src/host/alert-host.ts`):
 * every `alert*` platform method as one command, and the sidecar's events back
 * to the renderer's handlers. Shared by both standalone adapters, which differ
 * only in how a command travels and an event arrives.
 *
 * Every method is a closure, so an adapter may take them as its own members.
 */
export type SidecarAlertMethods = Required<Pick<
  PlatformAdapter,
  | 'alertRemove'
  | 'alertSetWatchedCommands'
  | 'alertSetCommandWatched'
  | 'alertPublishSettings'
  | 'alertDismiss'
  | 'alertEngagement'
  | 'alertAcknowledge'
  | 'alertResize'
  | 'alertToggleTodo'
  | 'alertClearTodo'
  | 'alertAwait'
  | 'alertSeed'
  | 'onAlertState'
  | 'onWatchedCommands'
  | 'onAlertSettings'
>>;

export interface SidecarAlertClient extends SidecarAlertMethods {
  /** One sidecar event. Returns whether it was an alert event. */
  onEvent(event: string, data: unknown): boolean;
  /** This realm is new — a boot or a reload: what the window's previous realm
   *  engaged or parked is gone (`hello`). */
  hello(): void;
  /** Offer the last startup seeds again, so the sidecar republishes both
   *  stores to a stream that dropped their broadcasts. */
  reofferSeeds(): void;
  /** Settle every await this realm parked `cancelled`, synchronously: nothing
   *  will deliver their outcomes once the adapter is gone. */
  dispose(): void;
}

export function createSidecarAlertClient(send: (command: AlertCommand) => void): SidecarAlertClient {
  const stateHandlers = new Set<(detail: AlertStateDetail) => void>();
  const watchedHandlers = new Set<(names: string[]) => void>();
  const settingsHandlers = new Set<(settings: AlertSettings) => void>();
  const awaits = new Map<string, { resolve: (outcome: AwaitOutcome) => void; startedAt: number }>();
  const seeds = new Map<string, AlertCommand>();

  const seed = (command: AlertCommand): void => {
    seeds.set(command.op, command);
    send(command);
  };

  return {
    alertRemove: (id) => send({ op: 'remove', id }),
    alertSeed: (id: string, state: PersistedAlertState) => send({ op: 'seed', id, state }),
    alertSetWatchedCommands: (names) => seed({ op: 'initializeWatchedCommands', names }),
    // A delta, never a replacement, so a window that has not heard about a
    // rule cannot drop it.
    alertSetCommandWatched: (name, watched) => send({ op: 'setCommandWatched', name, watched }),
    alertPublishSettings: (settings, opts) => {
      if (opts.seed) seed({ op: 'initializeSettings', settings });
      else send({ op: 'updateSettings', settings });
    },
    alertDismiss: (id) => send({ op: 'dismiss', id }),
    alertEngagement: (state: Engagement, lapse?: EngagementLapse) => send({ op: 'engagement', state, ...(lapse ? { lapse } : {}) }),
    alertAcknowledge: (id) => send({ op: 'acknowledge', id }),
    alertResize: (id) => send({ op: 'resize', id }),
    alertToggleTodo: (id) => send({ op: 'toggleTodo', id }),
    alertClearTodo: (id) => send({ op: 'clearTodo', id }),

    /**
     * Parked in the sidecar, which owns the wake condition and the ceiling; only
     * the outcome crosses back, broadcast under this adapter's own random id.
     * `cancel()` asks rather than answers: the `cancelled` outcome arrives on
     * the same result as every other, so a claim is never released twice.
     */
    alertAwait(id: string, options: AwaitOptions): AwaitHandle {
      const awaitId = `await-${crypto.randomUUID()}`;
      const promise = new Promise<AwaitOutcome>((resolve) => {
        awaits.set(awaitId, { resolve, startedAt: Date.now() });
      });
      send({ op: 'await', awaitId, id, until: options.until, timeoutMs: options.timeoutMs });
      return {
        promise,
        cancel: () => {
          if (awaits.has(awaitId)) send({ op: 'awaitCancel', awaitId });
        },
      };
    },

    onAlertState: (handler) => void stateHandlers.add(handler),
    onWatchedCommands: (handler) => void watchedHandlers.add(handler),
    onAlertSettings: (handler) => void settingsHandlers.add(handler),

    onEvent(event, data) {
      switch (event) {
        case ALERT_STATE_EVENT: {
          const detail = data as AlertStateDetail;
          if (typeof detail?.id !== 'string') return true;
          for (const handler of stateHandlers) handler(detail);
          return true;
        }
        case ALERT_AWAIT_RESULT_EVENT: {
          const result = data as Partial<AlertAwaitResult> | null;
          const parked = typeof result?.awaitId === 'string' ? awaits.get(result.awaitId) : undefined;
          // Another window's await, or one this realm already settled.
          if (!parked || !result?.outcome) return true;
          awaits.delete(result.awaitId!);
          parked.resolve(result.outcome);
          return true;
        }
        case 'alert:watchedCommands': {
          const names = (data as { names?: string[] } | null)?.names ?? [];
          for (const handler of watchedHandlers) handler(names);
          return true;
        }
        case 'alert:settings': {
          const settings = (data as { settings?: AlertSettings } | null)?.settings;
          // A broadcast with no blob is dropped, not applied as "no settings".
          if (settings) for (const handler of settingsHandlers) handler(settings);
          return true;
        }
        default:
          return false;
      }
    },

    hello: () => send({ op: 'hello' }),

    reofferSeeds() {
      for (const command of seeds.values()) send(command);
    },

    dispose() {
      for (const [awaitId, parked] of [...awaits]) {
        awaits.delete(awaitId);
        parked.resolve({ kind: 'cancelled', waitedMs: Date.now() - parked.startedAt });
      }
    },
  };
}
