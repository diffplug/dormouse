import type { EngagementLapse } from './alert-manager';
import { subscribeWindowFocus } from './window-focus';

/** What counts as a human at this window (`docs/specs/alert.md` -> Engagement). */
const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'compositionupdate'] as const;

/** Every input listener is a capture-phase, passive stamp: it sees input a
 *  terminal or dialog stops, and never delays it. */
const LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

/**
 * Whether a human is at this renderer realm: its window focused and visible,
 * with typing, pointer, or wheel input inside the inactivity timeout, or an
 * iframe Surface holding focus. Emits transitions only, each end of presence
 * with why it ended.
 */
export interface PresenceTracker {
  readonly present: boolean;
  /** The timeout changed: re-arm against the new value from the last input. */
  refresh(): void;
  dispose(): void;
}

export interface PresenceTrackerOptions {
  /** Read at every deadline, so a settings edit needs only `refresh`. */
  timeoutMs: () => number;
  /** Each transition; an end of presence names its lapse. */
  onChange: (present: boolean, lapse?: EngagementLapse) => void;
}

export function createPresenceTracker({ timeoutMs, onChange }: PresenceTrackerOptions): PresenceTracker {
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let present = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const windowActive = (): boolean => document.hasFocus() && document.visibilityState === 'visible';
  // A focused iframe Surface keeps the input typed into it from these
  // listeners, so its focus stands in for input (`docs/specs/alert.md` ->
  // Engagement).
  const iframeHoldsFocus = (): boolean => document.activeElement?.tagName === 'IFRAME';

  const set = (next: boolean, lapse?: EngagementLapse): void => {
    if (next === present) return;
    present = next;
    onChange(present, lapse);
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  // One timer per idle window, not one per event: input only stamps a time,
  // and the wake re-arms for whatever remains.
  const arm = (): void => {
    if (timer !== null || !present) return;
    timer = setTimeout(expire, Math.max(0, lastInputAt + timeoutMs() - Date.now()));
  };

  function expire(): void {
    timer = null;
    if (!present) return;
    // Left while an iframe held focus, so no blur reached this window.
    if (!windowActive()) {
      set(false, 'leave');
      return;
    }
    if (iframeHoldsFocus()) lastInputAt = Date.now();
    if (Date.now() - lastInputAt >= timeoutMs()) set(false, 'idle');
    else arm();
  }

  const onInput = (): void => {
    lastInputAt = Date.now();
    if (!present && windowActive()) set(true);
    arm();
  };

  const leave = (): void => {
    clearTimer();
    set(false, 'leave');
  };

  // Bringing the window back is a human act, so it counts as input.
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') onInput();
    else leave();
  };

  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, LISTENER_OPTIONS);
  const unsubscribeFocus = subscribeWindowFocus((focused) => (focused ? onInput() : leave()));
  document.addEventListener('visibilitychange', onVisibility);

  return {
    get present() {
      return present;
    },
    refresh() {
      clearTimer();
      arm();
    },
    dispose() {
      clearTimer();
      for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, LISTENER_OPTIONS);
      unsubscribeFocus();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
