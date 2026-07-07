/** A throttled function with a `cancel()` to drop any pending trailing call. */
export interface ThrottledFn {
  (): void;
  /** Drop any pending trailing call and close the window. Call on teardown so a
   *  trailing invocation never fires after the caller has unmounted. */
  cancel(): void;
}

/**
 * Throttle `fn` on the leading edge with a guaranteed trailing call:
 *
 *  - The first call fires `fn` immediately (leading), so a one-off event stays
 *    instant.
 *  - While calls keep arriving, `fn` runs at most once per `ms`.
 *  - Once calls stop, one final trailing call fires so the last state is always
 *    applied exactly.
 *
 * Used for the terminal-refit ResizeObserver: Lath tweens real pane geometry
 * across many animation frames and sash drags stream live resizes, and each
 * fit() reflows the xterm buffer + fires a PTY resize (ioctl + SIGWINCH). The
 * leading edge keeps single resizes (zoom) instant, the throttle caps reflows
 * during motion, and the trailing call fits the final geometry exactly.
 */
export function throttleTrailing(fn: () => void, ms: number): ThrottledFn {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let trailingPending = false;

  const onTimeout = () => {
    if (trailingPending) {
      // Calls arrived during the window — fire once for them, then reopen the
      // window so a continued stream keeps coalescing.
      trailingPending = false;
      fn();
      timer = setTimeout(onTimeout, ms);
    } else {
      timer = null;
    }
  };

  const throttled = (() => {
    if (timer === null) {
      // Leading edge: fire now and open the throttle window.
      fn();
      timer = setTimeout(onTimeout, ms);
    } else {
      // Inside a window: remember to fire once when it closes.
      trailingPending = true;
    }
  }) as ThrottledFn;

  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    trailingPending = false;
  };

  return throttled;
}
