import { subscribeWorkspaceMotionFrames } from '../workspace-motion';
import type { LathWallEngine } from './lath-wall-engine';

/**
 * Call `onChange` whenever `element`, a pane or other Wall chrome, may have
 * moved or resized with no React render to say so (docs/specs/layout.md →
 * "Position tracking"): its own resize, a window resize, a scroll of a
 * scroller that contains it, each Lath animation frame, and each Workspace
 * motion frame. Callers coalesce as they need. Returns the unsubscribe.
 */
export function subscribePaneMotion(
  element: Element | null | undefined,
  onChange: () => void,
  subscribeLathFrames?: LathWallEngine['subscribeFrames'] | null,
): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  window.addEventListener('resize', onChange, { signal });
  // Only a scroller the element sits inside can move it. `document` is itself a
  // Node containing everything, so viewport scrolling, dispatched at the
  // Document, counts too.
  document.addEventListener('scroll', (event) => {
    if (element && event.target instanceof Node && event.target.contains(element)) onChange();
  }, { capture: true, signal });
  const observer = new ResizeObserver(() => onChange());
  if (element) observer.observe(element);
  const unsubscribes = [subscribeLathFrames?.(() => onChange()), subscribeWorkspaceMotionFrames(onChange)];
  return () => {
    controller.abort();
    observer.disconnect();
    for (const unsubscribe of unsubscribes) unsubscribe?.();
  };
}
