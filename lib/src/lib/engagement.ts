import type { Engagement, EngagementLapse } from './alert-manager';
import { getAlertSettings, subscribeToAlertSettings } from './alert-settings';
import { getPlatformOrNull } from './platform';
import { createPresenceTracker, type PresenceTracker } from './presence';
import { createRefCount } from './ref-count';

/**
 * This renderer realm's engagement reporter (`docs/specs/alert.md` ->
 * Engagement): presence from the one `PresenceTracker`, focus from whichever
 * mounted Wall is the visible one, sent to the host only when either changes —
 * never per input event.
 */

/** Each mounted Wall's focus; only the visible Wall ever publishes one. */
const focusBySlot = new Map<object, string>();
/** Presence tracking while any Wall holds the reporter. */
let presence: PresenceTracker | null = null;
let reported: Engagement = { present: false, focusId: null };

function currentFocus(): string | null {
  for (const focusId of focusBySlot.values()) return focusId;
  return null;
}

function report(lapse?: EngagementLapse): void {
  const present = presence?.present ?? false;
  const focusId = currentFocus();
  // An absent realm engages nothing, so its focus moving is no news.
  if (present === reported.present && (focusId === reported.focusId || !present)) return;
  reported = { present, focusId };
  getPlatformOrNull()?.alertEngagement(reported, present ? undefined : lapse);
}

/** Hold the reporter while a Wall is mounted; the first holder starts presence
 *  tracking, the last one's release reports the realm gone. */
export const retainEngagementReporter = createRefCount({
  onFirst: () => {
    const tracker = createPresenceTracker({
      timeoutMs: () => getAlertSettings().inactivityTimeoutMs,
      onChange: (_present, lapse) => report(lapse),
    });
    const unsubscribeSettings = subscribeToAlertSettings(() => tracker.refresh());
    presence = tracker;
    return () => {
      unsubscribeSettings();
      tracker.dispose();
      presence = null;
      report('leave');
    };
  },
});

/** Publish one Wall's focus: the terminal Session it points the realm at, or
 *  null — as it publishes on unmount, to withdraw. */
export function publishEngagementFocus(slot: object, focusId: string | null): void {
  if (focusId === null) focusBySlot.delete(slot);
  else focusBySlot.set(slot, focusId);
  report();
}
