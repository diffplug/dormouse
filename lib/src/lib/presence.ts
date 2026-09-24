import type { EngagementLapse } from './alert-manager';

/** What counts as a human at this window (`docs/specs/alert.md` -> Engagement). */
const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'compositionupdate'] as const;

/** Every input listener is a capture-phase, passive stamp: it sees input a
 *  terminal or dialog stops, and never delays it. */
const LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };

/**
 * Whether a human is at this renderer realm: its window focused and visible,
 * with typing, pointer, or wheel input inside the inactivity timeout. Emits
 * transitions only, each end of presence with why it ended.
 */
export interface PresenceTracker {
  readonly present: boolean;
  subscribe(listener: (present: boolean, lapse?: EngagementLapse) => void): () => void;
  /** The timeout changed: re-arm against the new value from the last input. */
  refresh(): void;
  dispose(): void;
}

export interface PresenceTrackerOptions {
  /** Read at every deadline, so a settings edit needs only `refresh`. */
  timeoutMs: () => number;
  target?: Window;
  doc?: Document;
}

export function createPresenceTracker({
  timeoutMs,
  target = window,
  doc = document,
}: PresenceTrackerOptions): PresenceTracker {
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let present = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(present: boolean, lapse?: EngagementLapse) => void>();

  const windowActive = (): boolean => doc.hasFocus() && doc.visibilityState === 'visible';

  const set = (next: boolean, lapse?: EngagementLapse): void => {
    if (next === present) return;
    present = next;
    for (const listener of [...listeners]) listener(present, present ? undefined : lapse);
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

  // An iframe Surface taking focus blurs this window while the document keeps
  // it (`docs/specs/layout.md` -> Corner cases #2): not a leave.
  const onBlur = (): void => {
    if (!doc.hasFocus()) leave();
  };

  // Bringing the window back is a human act, so it counts as input.
  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible') onInput();
    else leave();
  };

  for (const type of INPUT_EVENTS) target.addEventListener(type, onInput, LISTENER_OPTIONS);
  target.addEventListener('focus', onInput);
  target.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    get present() {
      return present;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      clearTimer();
      arm();
    },
    dispose() {
      clearTimer();
      listeners.clear();
      for (const type of INPUT_EVENTS) target.removeEventListener(type, onInput, LISTENER_OPTIONS);
      target.removeEventListener('focus', onInput);
      target.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
