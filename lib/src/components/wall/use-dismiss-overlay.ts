import { useEffect } from 'react';

/**
 * The pane-header popovers' shared dismissal contract (docs/specs/layout.md):
 * any window `pointerdown` (an overlay that should survive its own clicks stops
 * propagation on its root), Escape, `resize`, or capture-phase `scroll`.
 * Register only while the overlay is mounted — consumers render only when open.
 */
export function useDismissOverlay(onClose: () => void): void {
  useEffect(() => {
    const close = () => onClose();
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', closeOnKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', closeOnKey);
    };
  }, [onClose]);
}
