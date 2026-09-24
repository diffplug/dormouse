import type { AlertManager, AlertState } from './alert-manager';
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
 * `window.speechSynthesis`, so it goes to the realm showing the Session.
 * Platform-free, like the manager: both hosts run it inside `createAlertHost`.
 */

export interface AlertDeliverySchedulerOptions {
  manager: Pick<AlertManager, 'onStateChange' | 'has' | 'isEngaged' | 'viewerIds'>;
  /** A spoken alarm is due, for the realm showing the Session to speak. */
  speak(id: string, episodeId: string): void;
  /** A push is due, titled by the Session's published Pane label. */
  push(id: string, title: string): void;
}

export interface AlertDeliveryScheduler {
  /**
   * One realm's Sessions, `{ label, overrides }` by id, revalidated. Replaces
   * what that realm published before, except a Session another realm has
   * published since.
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

export function createAlertDeliveryScheduler(options: AlertDeliverySchedulerOptions): AlertDeliveryScheduler {
  const { manager } = options;
  let defaults = DEFAULT_ALERT_SETTINGS;
  /** Each ringing Session's episode, and the sinks whose deadline is still to
   *  come; a sink missing from `timers` is consumed for that episode. */
  const episodes = new Map<string, { episodeId: string; timers: Map<AlertSink, ReturnType<typeof setTimeout>> }>();
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
    const timers = episodes.get(id)?.timers;
    if (!timers) return;
    const effective = policy(id);
    for (const [sink, timer] of timers) {
      if (sinks[sink].enabled(effective)) continue;
      clearTimeout(timer);
      timers.delete(sink);
    }
  }

  function onState(id: string, state: AlertState): void {
    if (!manager.has(id)) published.delete(id);
    const episode = state.episode ?? null;
    const current = episodes.get(id);
    // At most once per sink per episode: a source joining it delivers nothing.
    if (current && current.episodeId === episode?.id) return;
    if (current) {
      for (const timer of current.timers.values()) clearTimeout(timer);
      episodes.delete(id);
    }
    if (!episode) return;
    const effective = policy(id);
    const timers = new Map<AlertSink, ReturnType<typeof setTimeout>>();
    episodes.set(id, { episodeId: episode.id, timers });
    for (const sink of Object.keys(sinks) as AlertSink[]) {
      const rule = sinks[sink];
      // Off at the start consumes it: turning the sink on never replays it.
      if (!rule.enabled(effective)) continue;
      // Fixed here, so a later delay edit never moves it. A deadline that
      // fails is consumed, never retried.
      const dueAt = episode.startedAt + rule.delayMs(effective);
      timers.set(sink, setTimeout(() => {
        timers.delete(sink);
        if (!rule.blocked(id)) rule.deliver(id, episode.id);
      }, Math.max(0, dueAt - Date.now())));
    }
  }

  const stop = manager.onStateChange(onState);

  return {
    publish(realmId, raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const next = new Map<string, Omit<Published, 'realmId'>>();
      for (const [id, value] of Object.entries(raw)) {
        if (!id || !value || typeof value !== 'object') continue;
        const { label, overrides } = value as Record<string, unknown>;
        next.set(id, {
          label: typeof label === 'string' ? label.slice(0, LABEL_LIMIT) : '',
          overrides: normalizeAlertDeliveryOverrides(overrides),
        });
      }
      const changed: string[] = [];
      for (const [id, entry] of published) {
        if (entry.realmId !== realmId || next.has(id)) continue;
        published.delete(id);
        if (Object.keys(entry.overrides).length > 0) changed.push(id);
      }
      for (const [id, entry] of next) {
        const prior = published.get(id)?.overrides ?? {};
        published.set(id, { realmId, ...entry });
        if (!sameAlertDeliveryOverrides(prior, entry.overrides)) changed.push(id);
      }
      for (const id of changed) recheck(id);
    },

    setDefaults(settings) {
      defaults = settings;
      for (const id of episodes.keys()) recheck(id);
    },

    dispose() {
      stop();
      for (const { timers } of episodes.values()) {
        for (const timer of timers.values()) clearTimeout(timer);
      }
      episodes.clear();
      published.clear();
    },
  };
}
