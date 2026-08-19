import { useEffect, useState } from 'react';

/**
 * Whether a Surface is actually on screen. Two things can hide one: the window is
 * backgrounded, or the leaf is **parked** — mounted but out of the tree, so its DOM
 * survives while it paints nothing (docs/specs/tiling-engine.md → "Parked leaves").
 * Callers gate streaming work on it so a hidden pane stops consuming resources while
 * its daemon/session stays alive.
 *
 * Pass the pane's `parked` prop; omitting it means "never parked", which is right for
 * any surface rendered outside LathHost.
 */
export function useSurfaceVisibility(parked = false): boolean {
  const [docVisible, setDocVisible] = useState<boolean>(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return docVisible && !parked;
}
