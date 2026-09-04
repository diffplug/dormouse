import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { MODAL_LAYERS, useMeasuredElementRect } from './design';
import { clampOverlayPosition, OVERLAY_VIEWPORT_MARGIN_PX } from '../lib/ui-geometry';

/** Gap between the trigger's bottom edge and the top of the menu. */
const MENU_GAP_PX = 4;

interface AnchoredMenuOptions {
  side?: 'above' | 'below';
  align?: 'start' | 'end';
}

/**
 * Position a dropdown menu off its trigger's measured rect, `position: fixed`.
 *
 * Fixed rather than absolute because the Settings dialog surface is
 * `overflow-y-auto` and would clip an absolutely-positioned menu; a fixed
 * descendant escapes ancestor overflow because no modal ancestor sets
 * `transform`. The menu's own rect feeds the viewport clamp, so a long list
 * can't run off the bottom of a short window — it is 0 on the first pass, which
 * is why the returned style keeps the menu hidden until it has been measured.
 * The returned height cap also reserves the real space between the trigger and
 * the viewport edge; a full-viewport cap alone is too tall once the panel starts
 * below the top edge.
 *
 * The style also carries the stacking (`MODAL_LAYERS.app`): inside the Settings
 * dialog the alarm sections' `opacity-50` wrappers are stacking contexts too,
 * and being later in tree order they would otherwise paint through the menu.
 *
 * `open` gates the measurement so closed pickers do not keep observers alive.
 */
export function useAnchoredMenu(
  open: boolean,
  widthPx: number,
  { side = 'below', align = 'start' }: AnchoredMenuOptions = {},
): {
  setTriggerEl: (element: HTMLElement | null) => void;
  setMenuEl: (element: HTMLElement | null) => void;
  menuStyle: CSSProperties;
} {
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);

  const triggerRect = useMeasuredElementRect(open ? triggerEl : null);
  const menuRect = useMeasuredElementRect(open ? menuEl : null);

  const availableHeight = triggerRect
    ? Math.max(
        0,
        side === 'above'
          ? triggerRect.top - MENU_GAP_PX - OVERLAY_VIEWPORT_MARGIN_PX
          : window.innerHeight
            - (triggerRect.top + triggerRect.height + MENU_GAP_PX)
            - OVERLAY_VIEWPORT_MARGIN_PX,
      )
    : null;

  const menuStyle: CSSProperties = {
    width: widthPx,
    zIndex: MODAL_LAYERS.app,
    ...(availableHeight === null
      ? null
      : {
          maxHeight: `min(var(--overlay-max-h-popover, calc(100dvh - 24px)), ${availableHeight}px)`,
        }),
    ...(triggerRect && menuRect
      ? clampOverlayPosition({
          left: align === 'end'
            ? triggerRect.left + triggerRect.width - widthPx
            : triggerRect.left,
          top: side === 'above'
            ? triggerRect.top - menuRect.height - MENU_GAP_PX
            : triggerRect.top + triggerRect.height + MENU_GAP_PX,
          width: widthPx,
          height: menuRect.height,
        })
      : { position: 'fixed', visibility: 'hidden' }),
  };

  return { setTriggerEl, setMenuEl, menuStyle };
}

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
