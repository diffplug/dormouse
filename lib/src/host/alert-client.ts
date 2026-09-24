import type { AwaitHandle, AwaitOptions, AwaitOutcome, Engagement, EngagementLapse } from '../lib/alert-manager';
import type { AlertSettings } from '../lib/alert-settings-model';
import type { AlertStateDetail, PlatformAdapter } from '../lib/platform/types';
import { isAlertEvent, type AlertAwaitResult, type AlertCommand, type AlertEvents } from './alert-protocol';

/**
 * A renderer realm's end of its host's alerts (`lib/src/host/alert-host.ts`),
 * shared by every adapter whose host holds the `AlertManager` — VS Code and
 * both standalone adapters, which differ only in how a command travels and an
 * event arrives: each `alert*` platform verb is one `AlertCommand`, and the
 * host's events reach the renderer's handlers.
 */
export type AlertClientMethods = Required<Pick<
  PlatformAdapter,
  | 'alertSetWatchedCommands'
  | 'alertSetCommandWatched'
  | 'alertPublishSettings'
  | 'alertDismiss'
  | 'alertEngagement'
  | 'alertAcknowledge'
  | 'alertToggleTodo'
  | 'alertClearTodo'
  | 'alertAwait'
  | 'onAlertState'
  | 'onWatchedCommands'
  | 'onAlertSettings'
>>;

export interface AlertClient {
  /** Every `alert*` platform method, each a closure, so an adapter can take
   *  them as its own members (`Object.assign(this, client.methods)`). */
  readonly methods: AlertClientMethods;
  /** One host event. Returns whether it was an alert event. */
  onEvent(event: string, data: unknown): boolean;
  /** This realm is new — a boot or a reload: what the previous realm under
   *  the same name engaged or parked is gone. */
  hello(): void;
  /** Ask the host to re-send this realm's Sessions' state and both stores,
   *  for a transport that may have dropped them. */
  sync(): void;
  /** Settle every await this realm parked `cancelled`, synchronously: nothing
   *  will deliver their outcomes once the adapter is gone. */
  dispose(): void;
}

/**
 * A short random component for this realm's `awaitId`s: a standalone host
 * answers from one process for every window, so a plain counter would let two
 * realms mint the same id.
 */
function randomTag(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? uuid.slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

export function createAlertClient(send: (command: AlertCommand) => void): AlertClient {
  const stateHandlers = new Set<(detail: AlertStateDetail) => void>();
  const watchedHandlers = new Set<(names: string[]) => void>();
  const settingsHandlers = new Set<(settings: AlertSettings) => void>();
  const awaits = new Map<string, { resolve: (outcome: AwaitOutcome) => void; startedAt: number }>();
  const tag = randomTag();
  let awaitSeq = 0;

  const methods: AlertClientMethods = {
    alertSetWatchedCommands: (names) => send({ op: 'initializeWatchedCommands', names }),
    // A delta, never a replacement, so a realm that has not heard about a rule
    // cannot drop it.
    alertSetCommandWatched: (name, watched) => send({ op: 'setCommandWatched', name, watched }),
    alertPublishSettings: (settings, opts) =>
      send({ op: opts.seed ? 'initializeSettings' : 'updateSettings', settings }),
    alertDismiss: (id) => send({ op: 'dismiss', id }),
    alertEngagement: (state: Engagement, lapse?: EngagementLapse) =>
      send({ op: 'engagement', state, ...(lapse ? { lapse } : {}) }),
    alertAcknowledge: (id) => send({ op: 'acknowledge', id }),
    alertToggleTodo: (id) => send({ op: 'toggleTodo', id }),
    alertClearTodo: (id) => send({ op: 'clearTodo', id }),

    /**
     * Parked in the host, which owns the wake condition and the ceiling; only
     * the outcome crosses back, under this realm's own id. `cancel()` asks
     * rather than answers: the `cancelled` outcome arrives like every other, so
     * a claim is never released twice.
     */
    alertAwait(id: string, options: AwaitOptions): AwaitHandle {
      const awaitId = `await-${tag}-${++awaitSeq}`;
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
  };

  return {
    methods,

    onEvent(event, data) {
      if (!isAlertEvent(event)) return false;
      switch (event) {
        case 'alert:state': {
          // Forwarded whole, so a new `AlertState` field needs no edit here.
          const detail = data as AlertEvents['alert:state'] | null;
          if (typeof detail?.id === 'string') for (const handler of stateHandlers) handler(detail);
          break;
        }
        case 'alert:awaitResult': {
          const result = data as Partial<AlertAwaitResult> | null;
          const parked = typeof result?.awaitId === 'string' ? awaits.get(result.awaitId) : undefined;
          // Another realm's await, or one this realm already settled.
          if (!parked || !result?.outcome) break;
          awaits.delete(result.awaitId!);
          parked.resolve(result.outcome);
          break;
        }
        case 'alert:watchedCommands': {
          const names = (data as Partial<AlertEvents['alert:watchedCommands']> | null)?.names ?? [];
          for (const handler of watchedHandlers) handler(names);
          break;
        }
        case 'alert:settings': {
          const settings = (data as Partial<AlertEvents['alert:settings']> | null)?.settings;
          // A snapshot with no blob is dropped, not applied as "no settings".
          if (settings) for (const handler of settingsHandlers) handler(settings);
          break;
        }
        default:
          event satisfies never;
      }
      return true;
    },

    hello: () => send({ op: 'hello' }),
    sync: () => send({ op: 'sync' }),

    dispose() {
      for (const [awaitId, parked] of [...awaits]) {
        awaits.delete(awaitId);
        parked.resolve({ kind: 'cancelled', waitedMs: Date.now() - parked.startedAt });
      }
    },
  };
}
