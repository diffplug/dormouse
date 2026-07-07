import { useContext, useEffect, type RefObject } from 'react';
import { PaneElementsContext } from './wall-context';

/**
 * Shared surface-pane boilerplate used by every panel component
 * (terminal / iframe / agent-browser): registers the pane's root element in
 * `PaneElementsContext` so overlays (the selection ring, kill overlay,
 * shell-spawn notice) can measure it, and unregisters on unmount.
 */
export function usePaneChrome(id: string, elRef: RefObject<HTMLDivElement | null>): void {
  const { elements: paneElements, bumpVersion } = useContext(PaneElementsContext);

  useEffect(() => {
    if (!elRef.current) return;
    paneElements.set(id, elRef.current);
    bumpVersion();
    return () => {
      paneElements.delete(id);
      bumpVersion();
    };
  }, [id, paneElements, bumpVersion, elRef]);
}
