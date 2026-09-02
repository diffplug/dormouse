import { getActivity, getActivitySnapshot, subscribeToActivity } from './session-activity-store';

/** Shared renderer-side fresh-ring→delay→recheck machine for alarm sinks. */
export interface UnattendedRingWatch {
  /**
   * Whether this sink is switched on. Read when a ring is scheduled *and*
   * again when the timer fires, so toggling the setting mid-delay drops the
   * pending alarm.
   */
  readonly enabled: () => boolean;
  /** How long a ring must stay unattended before firing, read at schedule time. */
  readonly delayMs: () => number;
  /** Act on a ring that survived the delay. Must not throw. */
  readonly fire: (sessionId: string) => void;
}

/**
 * Watch the activity store and fire on unattended rings. Returns a disposer
 * that cancels everything pending.
 */
export function watchUnattendedRings(watch: UnattendedRingWatch): () => void {
  // Absence means never observed, so restore/reconnect cannot turn an existing
  // ring into a fresh transition.
  const lastStatus = new Map<string, string>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const cancel = (id: string): void => {
    const timer = pending.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    pending.delete(id);
  };

  const onActivityChange = (): void => {
    const snapshot = getActivitySnapshot();

    for (const [id, state] of snapshot) {
      const previous = lastStatus.get(id);
      lastStatus.set(id, state.status);

      if (state.status !== 'ALERT_RINGING') {
        // Attended, dismissed, or never ringing — either way nothing to do.
        cancel(id);
        continue;
      }
      // Already ringing, or seen for the first time already ringing.
      if (previous === 'ALERT_RINGING' || previous === undefined) continue;

      if (!watch.enabled()) continue;

      pending.set(id, setTimeout(() => {
        pending.delete(id);
        // Re-read rather than trusting the closure: the user may have attended
        // or dismissed during the delay, and the setting may have been toggled.
        if (getActivity(id).status !== 'ALERT_RINGING') return;
        if (!watch.enabled()) return;
        watch.fire(id);
      }, watch.delayMs()));
    }

    // A Session that left the store entirely (pane killed) must not fire.
    for (const id of [...lastStatus.keys()]) {
      if (snapshot.has(id)) continue;
      lastStatus.delete(id);
      cancel(id);
    }
  };

  // Seed from the current snapshot so nothing already on screen counts as fresh.
  onActivityChange();
  const unsubscribe = subscribeToActivity(onActivityChange);

  return () => {
    unsubscribe();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    lastStatus.clear();
  };
}
