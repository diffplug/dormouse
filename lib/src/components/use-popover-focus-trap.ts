import { useEffect } from 'react';
import { stepFocus } from './focus-step';
import { isComposingKey } from '../lib/dom';

/** What Tab reaches inside a popover: real buttons plus explicit tab stops. */
export const POPOVER_FOCUSABLE_SELECTOR = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Manages focus trapping and Escape-to-close for portal-based popovers.
 * Scopes keyboard handling to the popover's DOM subtree so Tab/Escape don't
 * leak to the rest of the app.
 */
export function usePopoverFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle keys when focus is inside the popover
      if (!el.contains(document.activeElement) || isComposingKey(e)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      e.preventDefault();
      stepFocus(
        Array.from(el.querySelectorAll<HTMLElement>(POPOVER_FOCUSABLE_SELECTOR)),
        e.shiftKey ? -1 : 1,
      );
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [ref, onClose]);
}
