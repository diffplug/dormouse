import { useEffect, type RefObject } from 'react';

/**
 * The pane-header popovers' shared dismissal contract (docs/specs/layout.md):
 * any window `pointerdown` (an overlay that should survive its own clicks stops
 * propagation on its root), Escape, `resize`, or capture-phase `scroll` —
 * except scrolls originating inside `overlayRef` itself, which never dismiss:
 * internal overflow scrolling (e.g. arrow-key focus moves auto-scrolling an
 * overflowing list) doesn't move the overlay's anchor, so it must not close it.
 * Register only while the overlay is mounted — consumers render only when open.
 */
export function useDismissOverlay(
  onClose: () => void,
  overlayRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const close = () => onClose();
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const closeOnScroll = (event: Event) => {
      const overlay = overlayRef.current;
      if (overlay && event.target instanceof Node && overlay.contains(event.target)) return;
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
  }, [onClose, overlayRef]);
}
