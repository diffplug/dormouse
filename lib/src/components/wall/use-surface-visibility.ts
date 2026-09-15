import { useContext, useEffect, useState } from 'react';
import { WorkspaceActiveContext } from './wall-context';

/**
 * Whether a Surface is actually on screen. Three things can hide one: the window is
 * backgrounded, its Workspace is not the visible one, or the leaf is **parked** —
 * mounted but out of the tree, so its DOM survives while it paints nothing
 * (docs/specs/tiling-engine.md → "Parked leaves"). Callers gate streaming work on it
 * so a hidden pane stops consuming resources while its daemon/session stays alive.
 *
 * Pass the pane's `parked` prop; omitting it means "never parked", which is right for
 * any surface rendered outside LathHost.
 */
export function useSurfaceVisibility(parked = false): boolean {
  const [docVisible, setDocVisible] = useState<boolean>(() => document.visibilityState !== 'hidden');
  const workspaceActive = useContext(WorkspaceActiveContext);

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return docVisible && workspaceActive && !parked;
}
