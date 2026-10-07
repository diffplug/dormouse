import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { motionIsInstant } from '../lib/ui-geometry';
import { getWorkspaceUiSnapshot, subscribeToWorkspaceUi } from '../lib/workspace-ui-store';
import { getWorkspacesSnapshot, subscribeToWorkspaces, type WorkspacesState } from '../lib/workspace-store';

/** Short enough that a drag's swaps keep up with the pointer. */
const TWEEN_DURATION_MS = 180;
/** `HEADER_PALETTE_TRANSITION_CLASS`'s curve, so the strip moves as one. */
const TWEEN_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** The strip's tweened items — every tab, keyed by its Workspace id, and `+`. */
function tweenItems(strip: HTMLElement): Map<string, HTMLElement> {
  const items = new Map<string, HTMLElement>();
  for (const element of strip.querySelectorAll<HTMLElement>('[data-workspace-tab], [data-workspace-new]')) {
    items.set(element.dataset.workspaceTab ?? '+', element);
  }
  return items;
}

/** Whether two states draw the same strip: the same tabs in the same groups and
 *  order, with the same names and the same one active (its `×`). */
function sameStrip(a: WorkspacesState, b: WorkspacesState): boolean {
  return a.activeId === b.activeId && (a.workspaces === b.workspaces || (a.workspaces.length === b.workspaces.length
    && a.workspaces.every((workspace, index) => {
      const other = b.workspaces[index];
      return workspace.id === other.id && !!workspace.pinned === !!other.pinned && workspace.name === other.name;
    })));
}

/** The strip's tween, outside React: `capture` just before a change lands,
 *  `play` once it has. */
function createStripTween(strip: () => HTMLElement | null) {
  /** Where everything was drawn just before the change. Visual rects, so an
   *  interrupted tween restarts from where it is. */
  let first: Map<string, DOMRect> | null = null;
  let frame = 0;
  const tweens = new WeakMap<HTMLElement, Animation[]>();

  function animate(element: HTMLElement, keyframes: Keyframe[]): void {
    const animation = element.animate(keyframes, { duration: TWEEN_DURATION_MS, easing: TWEEN_EASING });
    tweens.set(element, [...tweens.get(element) ?? [], animation]);
  }

  function play(): void {
    const before = first;
    first = null;
    cancelAnimationFrame(frame);
    const root = strip();
    // jsdom has no Web Animations.
    if (!before || !root || motionIsInstant() || typeof HTMLElement.prototype.animate !== 'function') return;
    const items = [...tweenItems(root)].filter(([key]) => before.has(key)).map(([key, element]) => ({ element, from: before.get(key)! }));
    // Each pass over every item, so the strip lays out twice rather than per tab.
    for (const { element } of items) {
      for (const animation of tweens.get(element) ?? []) animation.cancel();
      tweens.delete(element);
    }
    const widths = items.map(({ element }) => element.getBoundingClientRect().width);
    items.forEach(({ element, from }, index) => {
      if (Math.abs(from.width - widths[index]) < 0.5) return;
      // The floor would clamp a tween from below it; it returns at the end.
      animate(element, [{ width: `${from.width}px`, minWidth: '0px' }, { width: `${widths[index]}px`, minWidth: '0px' }]);
    });
    // Measured with the widths at their first frame: the transform makes up
    // only the jump the widths' own tween does not carry.
    const starts = items.map(({ element }) => element.getBoundingClientRect());
    items.forEach(({ element, from }, index) => {
      const dx = from.left - starts[index].left;
      const dy = from.top - starts[index].top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      animate(element, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }]);
    });
  }

  function capture(): void {
    const root = strip();
    if (!root || first) return;
    first = new Map([...tweenItems(root)].map(([key, element]) => [key, element.getBoundingClientRect()]));
    frame = requestAnimationFrame(play);
  }

  return { capture, play, dispose: () => cancelAnimationFrame(frame) };
}

/**
 * Tweens the strip's tabs and `+` into their new places and widths rather than
 * snapping: a drag's live reorder, Pin right / Unpin, a move, a create or close,
 * activation (the `×` moving), a name change, and the rename editor opening,
 * closing, and following its text. Keyed by Workspace id, not element, so a tab
 * that pinning remounts into the other group still slides from where it was.
 *
 * Widths tween as layout, so the tabs after a growing one are pushed along with
 * it; a reorder's jump in position is a transform on top.
 */
export function useWorkspaceTabTween(stripRef: RefObject<HTMLElement | null>): void {
  const [tween] = useState(() => createStripTween(() => stripRef.current));

  // Each capture runs before its change lands: a store listener before React
  // commits what it announces (even inside `flushSync`), `beforeinput` before
  // the editor's text changes. The strip's commit plays it; the editor's own
  // re-render does not reach the strip, so a frame plays what no commit did,
  // before it paints.
  useEffect(() => {
    let seen = getWorkspacesSnapshot();
    let renaming = getWorkspaceUiSnapshot().renamingId;
    const strip = stripRef.current;
    strip?.addEventListener('beforeinput', tween.capture, true);
    const unsubscribes = [
      subscribeToWorkspaces(() => {
        const next = getWorkspacesSnapshot();
        if (!sameStrip(seen, next)) tween.capture();
        seen = next;
      }),
      subscribeToWorkspaceUi(() => {
        const next = getWorkspaceUiSnapshot().renamingId;
        if (next !== renaming) tween.capture();
        renaming = next;
      }),
    ];
    return () => {
      strip?.removeEventListener('beforeinput', tween.capture, true);
      for (const unsubscribe of unsubscribes) unsubscribe();
      tween.dispose();
    };
  }, [stripRef, tween]);

  useLayoutEffect(() => tween.play());
}
