import { useContext, useEffect, useLayoutEffect, type RefObject } from 'react';
import { FreshlySpawnedContext, PaneElementsContext } from './wall-context';

/**
 * Shared surface-pane boilerplate used by every panel component
 * (terminal / iframe / agent-browser):
 *
 * - registers the pane's root element in `PaneElementsContext` so overlays can
 *   measure it, and unregisters on unmount;
 * - runs the `pane-spawn-from-<direction>` animation once when the pane was
 *   freshly spawned, on the element the engine designates via `getAnimEl`
 *   (dockview: the group element; Lath: the leaf div).
 */
export function usePaneChrome(
  id: string,
  elRef: RefObject<HTMLDivElement | null>,
  getAnimEl: () => HTMLElement | null,
): void {
  const { elements: paneElements, bumpVersion } = useContext(PaneElementsContext);
  const freshlySpawned = useContext(FreshlySpawnedContext);

  useEffect(() => {
    if (!elRef.current) return;
    paneElements.set(id, elRef.current);
    bumpVersion();
    return () => {
      paneElements.delete(id);
      bumpVersion();
    };
  }, [id, paneElements, bumpVersion, elRef]);

  useLayoutEffect(() => {
    const direction = freshlySpawned.get(id);
    if (!direction) return;
    freshlySpawned.delete(id);
    const animEl = getAnimEl();
    if (!animEl) return;
    const className = `pane-spawning-from-${direction}`;
    const animationName = `pane-spawn-from-${direction}`;
    animEl.classList.add(className);
    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== animationName) return;
      animEl.classList.remove(className);
      animEl.removeEventListener('animationend', onEnd);
    };
    animEl.addEventListener('animationend', onEnd);
    return () => {
      animEl.removeEventListener('animationend', onEnd);
      animEl.classList.remove(className);
    };
  }, [id, freshlySpawned, getAnimEl]);
}
