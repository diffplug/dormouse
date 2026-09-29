import { useEffect } from 'react';
import { startAlertDelivery } from '../../lib/alert-delivery';
import { createRefCount } from '../../lib/ref-count';

/**
 * Arm this realm's half of alarm delivery for the lifetime of the desktop
 * shell: publishing its Sessions to the host and speaking what the host says
 * is due (`docs/specs/alert.md` -> Alarm settings).
 *
 * One per WINDOW, not per Wall: `startAlertDelivery` publishes every Session
 * the realm shows and clears every Session's speech state, so N Walls would
 * speak each alarm N times and reset each other's delivery state. Reference
 * counted, so the first mounted Wall arms it and the last one disarms it.
 */
const acquire = createRefCount({ onFirst: () => startAlertDelivery() });

export function useAlertDelivery(): void {
  useEffect(acquire, []);
}
