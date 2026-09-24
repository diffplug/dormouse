import type { AlertManager, AlertState } from './alert-manager';
import {
  ALERT_SINKS,
  normalizeAlertDeliveryOverrides,
  resolveAlertDeliveryPolicy,
  sinkDelayMs,
  sinkEnabled,
  type AlertDeliveryOverrides,
  type AlertDeliveryPolicy,
  type AlertSink,
} from './alert-delivery-model';
import type { AlertSettings } from './alert-settings-model';

/**
 * When a ring is spoken or pushed (`docs/specs/alert.md` -> Alarm settings),
 * decided in the host beside the `AlertManager`, which sees every episode from
 * its start and outlives every renderer. The renderer only performs a delivery:
 * speech needs `window.speechSynthesis`, and both need the Pane's label.
 * Platform-free, like the manager: both hosts run it inside `createAlertHost`.
 */

/** One due delivery, for the realm showing its Session to perform. `id` is the
 *  Session, named so standalone routes it to the window showing it. */
export interface AlertDelivery {
  sink: AlertSink;
  id: string;
  episodeId: string;
}

export interface AlertDeliverySchedulerOptions {
  manager: Pick<AlertManager, 'onStateChange' | 'has' | 'isEngaged' | 'viewerIds'>;
  /** The application defaults, read at every decision. */
  defaults: () => AlertSettings;
  deliver: (delivery: AlertDelivery) => void;
}

export interface AlertDeliveryScheduler {
  /**
   * One realm's Sessions, each with its Workspace's sparse overrides,
   * revalidated. Replaces what that realm published before, except a Session
   * another realm has published since.
   */
  publish(realmId: string, overrides: unknown): void;
  /** The realm is gone: what it published for Sessions that are gone too goes. */
  endRealm(realmId: string): void;
  /** The defaults changed. */
  recheck(): void;
  /** The Session's effective policy: the defaults under its published overrides. */
  policy(id: string): AlertDeliveryPolicy;
  dispose(): void;
}

/** One sink's record of one episode: pending while it has a timer, consumed after. */
interface Receipt {
  episodeId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createAlertDeliveryScheduler(options: AlertDeliverySchedulerOptions): AlertDeliveryScheduler {
  const { manager } = options;
  const receipts: Record<AlertSink, Map<string, Receipt>> = { speech: new Map(), push: new Map() };
  /** Each Session's overrides, and the realm that last published them. */
  const published = new Map<string, { realmId: string; overrides: AlertDeliveryOverrides }>();

  const policy = (id: string): AlertDeliveryPolicy =>
    resolveAlertDeliveryPolicy(options.defaults(), published.get(id)?.overrides);

  const consume = (receipt: Receipt | undefined): void => {
    if (receipt?.timer) clearTimeout(receipt.timer);
    if (receipt) receipt.timer = null;
  };

  /** The deadline of an episode still ringing (its end consumed the receipt):
   *  still on, and still owed. A deadline that fails is consumed, never
   *  retried. */
  function due(sink: AlertSink, id: string, receipt: Receipt): void {
    receipt.timer = null;
    if (!sinkEnabled(policy(id), sink)) return;
    // Speech never talks over the pane the user is looking at; a push goes
    // only to a user away from every viewer (rationale).
    if (sink === 'speech' ? manager.isEngaged(id) : manager.viewerIds().length > 0) return;
    options.deliver({ sink, id, episodeId: receipt.episodeId });
  }

  function onState(id: string, state: AlertState): void {
    const episode = state.status === 'ALERT_RINGING' ? state.episode ?? null : null;
    for (const sink of ALERT_SINKS) {
      const current = receipts[sink].get(id);
      if (!episode) {
        consume(current);
        receipts[sink].delete(id);
        continue;
      }
      // At most once per sink per episode: a source joining it delivers nothing.
      if (current?.episodeId === episode.id) continue;
      consume(current);
      const effective = policy(id);
      const receipt: Receipt = { episodeId: episode.id, timer: null };
      receipts[sink].set(id, receipt);
      // Off at the start consumes it: turning the sink on never replays it.
      if (!sinkEnabled(effective, sink)) continue;
      // Fixed here, so a later delay edit never moves it.
      const dueAt = episode.startedAt + sinkDelayMs(effective, sink);
      receipt.timer = setTimeout(() => due(sink, id, receipt), Math.max(0, dueAt - Date.now()));
    }
  }

  function recheck(): void {
    for (const sink of ALERT_SINKS) {
      for (const [id, receipt] of receipts[sink]) {
        if (receipt.timer && !sinkEnabled(policy(id), sink)) consume(receipt);
      }
    }
  }

  const stop = manager.onStateChange(onState);

  return {
    publish(realmId, raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const next = new Map<string, AlertDeliveryOverrides>();
      for (const [id, value] of Object.entries(raw)) {
        if (id) next.set(id, normalizeAlertDeliveryOverrides(value));
      }
      for (const [id, entry] of published) {
        if (entry.realmId === realmId && !next.has(id)) published.delete(id);
      }
      for (const [id, overrides] of next) published.set(id, { realmId, overrides });
      recheck();
    },

    endRealm(realmId) {
      // A live Session keeps them: a reloading or recreated realm publishes
      // again, and a VS Code view's Sessions outlive its disposal.
      for (const [id, entry] of published) {
        if (entry.realmId === realmId && !manager.has(id)) published.delete(id);
      }
    },

    recheck,
    policy,

    dispose() {
      stop();
      for (const sink of ALERT_SINKS) {
        for (const receipt of receipts[sink].values()) consume(receipt);
        receipts[sink].clear();
      }
      published.clear();
    },
  };
}
