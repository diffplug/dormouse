import { useContext, useEffect, useLayoutEffect, type RefObject } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { FreshlySpawnedContext, PaneElementsContext } from './wall-context';

/**
 * Shared surface-pane boilerplate used by every panel component
 * (terminal / iframe / agent-browser):
 *
 * - registers the pane's root element in `PaneElementsContext` so overlays can
 *   measure it, and unregisters on unmount;
 * - runs the `pane-spawn-from-<direction>` animation once when the pane was
 *   freshly spawned.
 */
export function usePaneChrome(
  api: IDockviewPanelProps['api'],
  elRef: RefObject<HTMLDivElement | null>,
): void {
  const { elements: paneElements, bumpVersion } = useContext(PaneElementsContext);
  const freshlySpawned = useContext(FreshlySpawnedContext);

  useEffect(() => {
    if (!elRef.current) return;
    paneElements.set(api.id, elRef.current);
    bumpVersion();
    return () => {
      paneElements.delete(api.id);
      bumpVersion();
    };
  }, [api.id, paneElements, bumpVersion, elRef]);

  useLayoutEffect(() => {
    const direction = freshlySpawned.get(api.id);
    if (!direction) return;
    freshlySpawned.delete(api.id);
    const groupEl = api.group?.element;
    if (!groupEl) return;
    const className = `pane-spawning-from-${direction}`;
    const animationName = `pane-spawn-from-${direction}`;
    groupEl.classList.add(className);
    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== animationName) return;
      groupEl.classList.remove(className);
      groupEl.removeEventListener('animationend', onEnd);
    };
    groupEl.addEventListener('animationend', onEnd);
    return () => {
      groupEl.removeEventListener('animationend', onEnd);
      groupEl.classList.remove(className);
    };
  }, [api, freshlySpawned]);
}
