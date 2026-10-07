import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { subscribeToWorkspaces } from '../lib/workspace-store';

/** Short enough that a drag's swaps keep up with the pointer. */
const FLIP_DURATION_MS = 180;
/** `HEADER_PALETTE_TRANSITION_CLASS`'s curve, so the strip moves as one. */
const FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** The strip's sliding items — every tab, keyed by its Workspace id, and `+`. */
function flipItems(strip: HTMLElement): Map<string, HTMLElement> {
  const items = new Map<string, HTMLElement>();
  for (const element of strip.querySelectorAll<HTMLElement>('[data-workspace-tab], [data-workspace-new]')) {
    items.set(element.dataset.workspaceTab ?? '+', element);
  }
  return items;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Slides the strip's tabs and `+` to their new places when the order changes —
 * a drag's live reorder, Pin right / Unpin, a move, a create or close — rather
 * than snapping (FLIP). Keyed by Workspace id, not element, so a tab that
 * pinning remounts into the other group still slides from where it was.
 *
 * `orderKey` changes exactly when the strip's order or grouping does; a rename
 * or an auto-name changes widths and must not set the neighbours sliding.
 */
export function useWorkspaceTabFlip(stripRef: RefObject<HTMLElement | null>, orderKey: string): void {
  /** Where everything was drawn when the store first changed since the last
   *  commit. Visual rects, so an interrupted slide restarts from where it is. */
  const firstRef = useRef<Map<string, DOMRect> | null>(null);
  const lastKeyRef = useRef(orderKey);
  const slides = useRef(new WeakMap<HTMLElement, Animation>());

  // A store listener runs before React commits the change it announces, even
  // inside `flushSync`, so the DOM here is still the old order.
  useEffect(() => subscribeToWorkspaces(() => {
    const strip = stripRef.current;
    if (!strip || firstRef.current) return;
    firstRef.current = new Map([...flipItems(strip)].map(([key, element]) => [key, element.getBoundingClientRect()]));
  }), [stripRef]);

  // Every commit consumes the snapshot, so one taken for a rename never serves
  // a later reorder as stale positions.
  useLayoutEffect(() => {
    const first = firstRef.current;
    firstRef.current = null;
    const changed = lastKeyRef.current !== orderKey;
    lastKeyRef.current = orderKey;
    const strip = stripRef.current;
    if (!first || !changed || !strip || prefersReducedMotion()) return;
    for (const [key, element] of flipItems(strip)) {
      const from = first.get(key);
      // jsdom has no Web Animations.
      if (!from || typeof element.animate !== 'function') continue;
      slides.current.get(element)?.cancel();
      const to = element.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx === 0 && dy === 0) continue;
      slides.current.set(element, element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
      ));
    }
  });
}
