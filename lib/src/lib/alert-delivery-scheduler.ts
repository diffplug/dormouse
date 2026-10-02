import type { AlertManager, AlertState } from './alert-manager';
import { isAlertPaused } from './alert-episode';
import {
  normalizeAlertDeliveryOverrides,
  resolveAlertDeliveryPolicy,
  sameAlertDeliveryOverrides,
  type AlertDeliveryOverrides,
  type AlertDeliveryPolicy,
  type AlertSink,
} from './alert-delivery-model';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from './alert-settings-model';

/**
 * When a ring is spoken or pushed (`docs/specs/alert.md` -> Alarm settings),
 * decided in the host beside the `AlertManager`, which sees every episode from
 * its start and outlives every renderer. A push goes from here; speech needs
 * the renderer's audio or `window.speechSynthesis`, so it goes to the realm
 * showing the Session.
 * Platform-free, like the manager: both hosts run it inside `createAlertHost`.
 */

export interface AlertDeliverySchedulerOptions {
  manager: Pick<AlertManager, 'onStateChange' | 'onRemove' | 'isEngaged' | 'viewerIds' | 'has'>;
  /** A spoken alarm is due, for the realm showing the Session to speak. */
  speak(id: string, episodeId: string): void;
  /** A push is due, titled by the Session's published Pane label. */
  push(id: string, title: string): void;
}

export interface AlertDeliveryScheduler {
  /**
   * The Sessions one realm shows, `{ label, overrides }` by id, revalidated.
   * Each overwrites its Session's record, whichever realm made it. One the
   * realm published before and omits now is forgotten only while it has no
   * alert state, which nothing can be pending on: a partial publication must
   * never consume what an override armed.
   */
  publish(realmId: string, sessions: unknown): void;
  /** The application defaults, from the host's settings store. */
  setDefaults(settings: AlertSettings): void;
  dispose(): void;
}

/** Longest label the host keeps. `toPushText` cuts far shorter at send time;
 *  this only bounds what a renderer can make the host hold. */
const LABEL_LIMIT = 1_024;

interface Published {
  realmId: string;
  label: string;
  overrides: AlertDeliveryOverrides;
}

/** A sink's fixed deadline, armed only while the Session is visibly ringing. */
interface Delivery {
  dueAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function disarm(delivery: Delivery): void {
  clearTimeout(delivery.timer);
  delivery.timer = undefined;
}

export function createAlertDeliveryScheduler(options: AlertDeliverySchedulerOptions): AlertDeliveryScheduler {
  const { manager } = options;
  let defaults = DEFAULT_ALERT_SETTINGS;
  /** Deadlines survive pauses; a sink missing from `pending` is consumed. */
  const episodes = new Map<string, { episodeId: string; pending: Map<AlertSink, Delivery> }>();
  /** Each Session's last publication, and the realm that made it. */
  const published = new Map<string, Published>();

  /** Speech spares the pane the user is looking at; a push waits until the
   *  user has left every viewer (rationale). */
  const sinks: Record<AlertSink, {
    enabled(policy: AlertDeliveryPolicy): boolean;
    delayMs(policy: AlertDeliveryPolicy): number;
    blocked(id: string): boolean;
    deliver(id: string, episodeId: string): void;
  }> = {
    speech: {
      enabled: (policy) => policy.speakEnabled,
      delayMs: (policy) => policy.speakDelayMs,
      blocked: (id) => manager.isEngaged(id),
      deliver: (id, episodeId) => options.speak(id, episodeId),
    },
    push: {
      enabled: (policy) => policy.pushEnabled,
      delayMs: (policy) => policy.pushDelayMs,
      blocked: () => manager.viewerIds().length > 0,
      deliver: (id) => options.push(id, published.get(id)?.label || 'terminal'),
    },
  };

  const policy = (id: string): AlertDeliveryPolicy =>
    resolveAlertDeliveryPolicy(defaults, published.get(id)?.overrides);

  /** A sink turned off consumes its pending deadline; one turned on never
   *  replays it. */
  function recheck(id: string): void {
    const pending = episodes.get(id)?.pending;
    if (!pending) return;
    const effective = policy(id);
    for (const [sink, delivery] of pending) {
      if (sinks[sink].enabled(effective)) continue;
      disarm(delivery);
      pending.delete(sink);
    }
  }

  function onState(id: string, state: AlertState): void {
    const episode = state.episode ?? null;
    let current = episodes.get(id);
    if (current && current.episodeId !== episode?.id) {
      current.pending.forEach(disarm);
      episodes.delete(id);
      current = undefined;
    }
    if (!episode) return;
    if (!current) {
      const effective = policy(id);
      current = { episodeId: episode.id, pending: new Map() };
      episodes.set(id, current);
      for (const sink of Object.keys(sinks) as AlertSink[]) {
        const rule = sinks[sink];
        // Fixed at episode start; disabled sinks and delay edits never replay it.
        if (rule.enabled(effective)) current.pending.set(sink, {
          dueAt: episode.startedAt + rule.delayMs(effective), timer: undefined,
        });
      }
    }
    const { pending } = current;
    // Disarm without consuming, so quiet re-arms the original deadline.
    if (isAlertPaused(state)) {
      pending.forEach(disarm);
      return;
    }
    for (const [sink, delivery] of pending) {
      if (delivery.timer !== undefined) continue;
      const rule = sinks[sink];
      delivery.timer = setTimeout(() => {
        pending.delete(sink);
        if (!rule.blocked(id)) rule.deliver(id, episode.id);
      }, Math.max(0, delivery.dueAt - Date.now()));
    }
  }

  const stops = [
    manager.onStateChange(onState),
    // Only a Session gone for good: a respawn under the same id keeps what its
    // realm published, which the realm never sends again unchanged.
    manager.onRemove((id) => void published.delete(id)),
  ];

  return {
    publish(realmId, raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const named = new Set<string>();
      for (const [id, value] of Object.entries(raw)) {
        if (!id || !value || typeof value !== 'object') continue;
        named.add(id);
        const { label, overrides: rawOverrides } = value as Record<string, unknown>;
        const overrides = normalizeAlertDeliveryOverrides(rawOverrides);
        const prior = published.get(id)?.overrides ?? {};
        published.set(id, { realmId, label: typeof label === 'string' ? label.slice(0, LABEL_LIMIT) : '', overrides });
        if (!sameAlertDeliveryOverrides(prior, overrides)) recheck(id);
      }
      // Never a record a ring could be pending on: dropping it would consume
      // that ring's sinks, and the realm's next, whole publication could never
      // re-arm them. One with no alert state (a browser Surface, a terminal
      // that has printed nothing) goes, so the host holds no more than realms
      // show.
      for (const [id, entry] of published) {
        if (entry.realmId === realmId && !named.has(id) && !manager.has(id)) published.delete(id);
      }
    },

    setDefaults(settings) {
      defaults = settings;
      for (const id of episodes.keys()) recheck(id);
    },

    dispose() {
      for (const stop of stops) stop();
      for (const { pending } of episodes.values()) pending.forEach(disarm);
      episodes.clear();
      published.clear();
    },
  };
}
