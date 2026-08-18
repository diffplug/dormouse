import { useEffect, type RefObject } from 'react';

/**
 * Close on pointerdown outside the ref, on Escape, or on a scroll that actually
 * moves the dropdown's anchor.
 *
 * The scroll rule is narrower than `wall/use-dismiss-overlay.ts`'s. That one
 * exempts scrolls originating *inside* the overlay; a capture-phase listener on
 * `window` still sees every other scroller in the document, which for this
 * dropdown means a background terminal pane auto-scrolling closes a theme list
 * the user is reading. Only a scroller the trigger actually sits inside can
 * move it, so that is the test — which also exempts the theme list's own
 * `overflow-y-auto` (a descendant, never an ancestor) for free.
 */
export function useCloseOnOutsideAndEscape(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;

    const containedInRef = (target: EventTarget | null): boolean =>
      !!ref.current && target instanceof Node && ref.current.contains(target);

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containedInRef(event.target)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const closeOnScroll = (event: Event) => {
      const root = ref.current;
      // Only a scroller the trigger sits inside can move it. `document` is
      // itself a Node containing everything, so viewport scrolling — which the
      // DOM dispatches at the Document — satisfies this too.
      if (!root || !(event.target instanceof Node)) return;
      if (event.target.contains(root)) onClose();
    };

    window.addEventListener('pointerdown', closeOnPointerDown, true);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, true);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [open, ref, onClose]);
}
