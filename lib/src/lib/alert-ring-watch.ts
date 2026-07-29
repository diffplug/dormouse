import { getActivity, getActivitySnapshot, subscribeToActivity } from './session-activity-store';

/**
 * The shared "unattended ring, delayed, re-checked" machine behind every alarm
 * sink (`docs/specs/alert.md` -> Alarm settings).
 *
 * Spoken alarms and push notifications are the same state machine with a
 * different sink: watch the activity store, detect a fresh transition into
 * `ALERT_RINGING`, wait a configurable delay, re-check that it is *still*
 * ringing, then act. Only the sink and which settings field gates it differ, so
 * they share this rather than each carrying a copy of the freshness and
 * cancellation rules — those rules are subtle enough that two copies would
 * drift.
 *
 * Renderer-side by design: the ring already arrives here as an activity-store
 * transition, and the delay timer needs no host round-trip.
 */
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
  // Last seen status per Session. A Session missing from this map has never been
  // observed, so its first sighting can never count as a transition — that is
  // what keeps a restore or reconnect that arrives already ringing silent
  // (`docs/specs/alert.md` -> WATCHING Track). For push this is the difference
  // between "works" and "buzzes your phone every time you open your laptop".
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
