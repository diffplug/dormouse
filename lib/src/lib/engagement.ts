import type { Engagement, EngagementLapse } from './alert-manager';
import { getAlertSettings, subscribeToAlertSettings } from './alert-settings';
import { getPlatformOrNull } from './platform';
import { createPresenceTracker, type PresenceTracker } from './presence';

/**
 * This renderer realm's engagement reporter (`docs/specs/alert.md` ->
 * Engagement): presence from the one `PresenceTracker`, focus from whichever
 * mounted Wall is the visible one, sent to the host only when either changes —
 * never per input event.
 */

/** Each mounted Wall's focus; only the visible Wall's is ever non-null. */
const focusBySlot = new Map<object, string | null>();
let holders = 0;
let presence: PresenceTracker | null = null;
let releasePresence: (() => void) | null = null;
let reported: Engagement = { present: false, focusId: null };

function currentFocus(): string | null {
  for (const focusId of focusBySlot.values()) {
    if (focusId !== null) return focusId;
  }
  return null;
}

function report(lapse?: EngagementLapse): void {
  const next: Engagement = { present: presence?.present ?? false, focusId: currentFocus() };
  if (next.present === reported.present && next.focusId === reported.focusId) return;
  reported = next;
  getPlatformOrNull()?.alertEngagement(next, next.present ? undefined : lapse);
}

/** Hold the reporter while a Wall is mounted; the first holder starts presence
 *  tracking, the last one's release reports the realm gone. */
export function retainEngagementReporter(): () => void {
  if (holders++ === 0) {
    const tracker = createPresenceTracker({ timeoutMs: () => getAlertSettings().inactivityTimeoutMs });
    const unsubscribe = tracker.subscribe((_present, lapse) => report(lapse));
    const unsubscribeSettings = subscribeToAlertSettings(() => tracker.refresh());
    presence = tracker;
    releasePresence = () => {
      unsubscribe();
      unsubscribeSettings();
      tracker.dispose();
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders > 0) return;
    releasePresence?.();
    releasePresence = null;
    presence = null;
    report('leave');
  };
}

/** Publish one Wall's focus: the terminal Session it points the realm at, or null. */
export function publishEngagementFocus(slot: object, focusId: string | null): void {
  focusBySlot.set(slot, focusId);
  report();
}

export function withdrawEngagementFocus(slot: object): void {
  if (!focusBySlot.delete(slot)) return;
  report();
}
