import { useEffect } from 'react';
import { startAlertDelivery } from '../../lib/alert-delivery';
import { createRefCount } from '../../lib/ref-count';

/**
 * Arm this realm's spoken alarms and pushes for the lifetime of the desktop
 * shell (`docs/specs/alert.md` -> Alarm settings).
 *
 * One performer per WINDOW, not per Wall: `startAlertDelivery` publishes every
 * Workspace's policy and clears every Session's speech state, so N Walls would
 * speak each delivery N times and reset each other's delivery state. Reference
 * counted, so the first mounted Wall arms it and the last one disarms it.
 */
const acquire = createRefCount({ onFirst: () => startAlertDelivery() });

export function useAlertDelivery(): void {
  useEffect(acquire, []);
}
