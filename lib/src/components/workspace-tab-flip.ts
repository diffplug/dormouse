import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { motionIsInstant } from '../lib/ui-geometry';
import { getWorkspacesSnapshot, subscribeToWorkspaces, type WorkspaceMeta } from '../lib/workspace-store';

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

/** Whether two lists put the same Workspaces in the same groups and order. A
 *  rename or an activation changes neither, so it never sets tabs sliding. */
function sameOrder(a: readonly WorkspaceMeta[], b: readonly WorkspaceMeta[]): boolean {
  return a === b || (a.length === b.length
    && a.every((workspace, index) => workspace.id === b[index].id && !!workspace.pinned === !!b[index].pinned));
}

/**
 * Slides the strip's tabs and `+` to their new places when the order changes —
 * a drag's live reorder, Pin right / Unpin, a move, a create or close — rather
 * than snapping (FLIP). Keyed by Workspace id, not element, so a tab that
 * pinning remounts into the other group still slides from where it was.
 */
export function useWorkspaceTabFlip(stripRef: RefObject<HTMLElement | null>): void {
  /** Where everything was drawn when the order first changed since the last
   *  commit. Visual rects, so an interrupted slide restarts from where it is. */
  const firstRef = useRef<Map<string, DOMRect> | null>(null);
  const slides = useRef(new WeakMap<HTMLElement, Animation>());

  // A store listener runs before React commits the change it announces, even
  // inside `flushSync`, so the DOM here is still the old order. Every order
  // change is followed by a commit, which consumes the snapshot.
  useEffect(() => {
    let seen = getWorkspacesSnapshot().workspaces;
    return subscribeToWorkspaces(() => {
      const next = getWorkspacesSnapshot().workspaces;
      const changed = !sameOrder(seen, next);
      seen = next;
      const strip = stripRef.current;
      if (!changed || !strip || firstRef.current) return;
      firstRef.current = new Map([...flipItems(strip)].map(([key, element]) => [key, element.getBoundingClientRect()]));
    });
  }, [stripRef]);

  useLayoutEffect(() => {
    const first = firstRef.current;
    firstRef.current = null;
    const strip = stripRef.current;
    // jsdom has no Web Animations.
    if (!first || !strip || motionIsInstant() || typeof HTMLElement.prototype.animate !== 'function') return;
    const items = [...flipItems(strip)].filter(([key]) => first.has(key));
    // Cancel, measure, then animate, each over every item, so the strip lays
    // out once rather than once per tab.
    for (const [, element] of items) slides.current.get(element)?.cancel();
    const moves = items.map(([key, element]) => {
      const from = first.get(key)!;
      const to = element.getBoundingClientRect();
      return { element, dx: from.left - to.left, dy: from.top - to.top };
    });
    for (const { element, dx, dy } of moves) {
      if (dx === 0 && dy === 0) continue;
      slides.current.set(element, element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
      ));
    }
  });
}
