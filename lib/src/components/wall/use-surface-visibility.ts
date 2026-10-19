import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { hostShown, subscribeHostShown } from '../../lib/host-shown';
import { coveredByZoom, isSeen } from '../../lib/surface-sight';
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
  return useSurfaceSight(parked, id).seen;
}

/** What `useSurfaceVisibility` judges by, each input as observed. */
export interface SurfaceSightObserved {
  /** `document.visibilityState` is not hidden. */
  docVisible: boolean;
  /** The host reports the window (VS Code: webview) shown. */
  hostShown: boolean;
  workspaceActive: boolean;
  parked: boolean;
  covered: boolean;
}

/** `useSurfaceVisibility` with the inputs it read, for a caller that records
 *  why (the browser controller's debug ring). `inputs` keeps its identity
 *  until one of them changes. */
export function useSurfaceSight(parked = false, id?: string): { seen: boolean; inputs: SurfaceSightObserved } {
  const [docVisible, setDocVisible] = useState<boolean>(() => document.visibilityState !== 'hidden');
  const workspaceActive = useContext(WorkspaceActiveContext);
  const zoomedId = useContext(ZoomedIdContext);
  const shownByHost = useSyncExternalStore(subscribeHostShown, hostShown);

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const covered = id !== undefined && coveredByZoom(id, zoomedId);
  const inputs = useMemo(
    () => ({ docVisible, hostShown: shownByHost, workspaceActive, parked, covered }),
    [docVisible, shownByHost, workspaceActive, parked, covered],
  );
  return {
    seen: isSeen({ windowShown: docVisible && shownByHost, workspaceActive, parked, covered }),
    inputs,
  };
}
