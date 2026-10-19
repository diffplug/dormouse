import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { hostShown, subscribeHostShown } from '../../lib/host-shown';
import { coveredByZoom, isSeenObserved, type SurfaceSightObserved } from '../../lib/surface-sight';
import { WorkspaceActiveContext, ZoomedIdContext } from './wall-context';

/**
 * Whether a Surface is actually on screen (`lib/src/lib/surface-sight.ts`): its
 * window — or VS Code webview — is shown, its Workspace is the visible one, its
 * leaf is not **parked** (mounted but out of the tree,
 * docs/specs/tiling-engine.md → "Parked leaves"), and, given its leaf `id`, no
 * other leaf is zoomed over it. Callers gate streaming work on it so a hidden
 * pane stops consuming resources while its daemon/session stays alive.
 *
 * Pass the pane's `parked` prop; omitting it means "never parked", which is right for
 * any surface rendered outside LathHost. Omitting `id` ignores zoom: chrome
 * that stays visible in the zoom margin passes none.
 */
export function useSurfaceVisibility(parked = false, id?: string): boolean {
  return isSeenObserved(useSurfaceSight(parked, id));
}

/** What `useSurfaceVisibility` judges by, as observed, for a caller that
 *  records why (the browser controller's debug ring). Keeps its identity
 *  until an input changes. */
export function useSurfaceSight(parked = false, id?: string): SurfaceSightObserved {
  const [docVisible, setDocVisible] = useState<boolean>(() => document.visibilityState !== 'hidden');
  const workspaceActive = useContext(WorkspaceActiveContext);
  const zoomedId = useContext(ZoomedIdContext);
  const hostShownNow = useSyncExternalStore(subscribeHostShown, hostShown);

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const covered = id !== undefined && coveredByZoom(id, zoomedId);
  return useMemo(
    () => ({ docVisible, hostShown: hostShownNow, workspaceActive, parked, covered }),
    [docVisible, hostShownNow, workspaceActive, parked, covered],
  );
}
