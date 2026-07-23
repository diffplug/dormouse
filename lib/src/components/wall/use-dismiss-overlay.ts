import { useEffect, type RefObject } from 'react';

/**
 * The pane-header popovers' shared dismissal contract (docs/specs/layout.md):
 * any window `pointerdown` (an overlay that should survive its own clicks stops
 * propagation on its root), Escape, `resize`, or capture-phase `scroll`.
 * Register only while the overlay is mounted — consumers render only when open.
 *
 * When `insideRef` is provided, a capture-phase `scroll` whose `event.target`
 * is a Node inside `insideRef.current` does NOT dismiss (arrow-key focus moves
 * auto-scroll the menu's own overflow container, which must not close it).
 * Scrolls from anywhere else still dismiss.
 */
export function useDismissOverlay(
  onClose: () => void,
  insideRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const close = () => onClose();
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const closeOnScroll = (event: Event) => {
      const inside = insideRef?.current;
      if (inside && event.target instanceof Node && inside.contains(event.target)) return;
      close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('keydown', closeOnKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('keydown', closeOnKey);
    };
  }, [onClose, insideRef]);
}
