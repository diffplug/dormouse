import { useContext, useEffect, type RefObject } from 'react';
import { PaneElementsContext } from './wall-context';

/**
 * Registers a Surface body's root element in
 * `PaneElementsContext` so overlays (the selection ring, kill overlay,
 * shell-spawn notice) can measure it, and unregisters on unmount.
 */
export function usePaneChrome(id: string, elRef: RefObject<HTMLDivElement | null>): void {
  const { elements: paneElements, bumpVersion } = useContext(PaneElementsContext);

  useEffect(() => {
    const element = elRef.current;
    if (!element) return;
    paneElements.set(id, element);
    bumpVersion();
    return () => {
      // A preview slot switch mounts the next body beside its ghost, which
      // must not unregister it on leaving (`docs/specs/dor-tool.md` ->
      // Switching the slot).
      if (paneElements.get(id) === element) paneElements.delete(id);
      bumpVersion();
    };
  }, [id, paneElements, bumpVersion, elRef]);
}
