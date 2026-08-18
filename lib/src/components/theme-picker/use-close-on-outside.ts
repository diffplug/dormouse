import { useEffect, type RefObject } from 'react';

/**
 * Close on pointerdown outside the ref, on Escape, or on a scroll that moves
 * the dropdown's anchor.
 *
 * The scroll rule follows `wall/use-dismiss-overlay.ts`: a capture-phase
 * listener, *except* scrolls originating inside `ref` itself. The theme list
 * has its own `overflow-y-auto`, and scrolling it does not move the trigger, so
 * it must not dismiss — without the guard, installing a couple of OpenVSX
 * themes makes the list overflow and the menu closes the moment you scroll it.
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
      if (!containedInRef(event.target)) onClose();
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
