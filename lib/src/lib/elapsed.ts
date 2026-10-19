/** Milliseconds from `at` to `now`, in one time base; null when `at` never
 *  happened. Diagnostics report times this way, readable without a clock. */
export function msSince(at: number | undefined, now: number): number | null {
  return at === undefined ? null : Math.round(now - at);
}
