import { useEffect } from 'react';

/**
 * Manages focus trapping, Escape-to-close, and click-outside-to-close for
 * portal-based popovers. Scopes keyboard handling to the popover's DOM subtree
 * so Tab/Escape don't leak to the rest of the app.
 */
export function usePopoverFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle keys when focus is inside the popover
      if (!el.contains(document.activeElement)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusables.length === 0) return;

      const currentIndex = focusables.findIndex((f) => f === document.activeElement);
      const nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;

      e.preventDefault();
      focusables[nextIndex]?.focus();
    };

    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [ref, onClose]);
}
