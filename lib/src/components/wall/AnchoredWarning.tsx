import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { POPUP_SURFACE_CLASS } from '../design';
import { cfg } from '../../cfg';
import { useDismissOverlay } from './use-dismiss-overlay';

const POPOVER_GAP = 6;
const POPOVER_MARGIN = 8;

export interface AnchoredWarningProps {
  anchorRect: DOMRect;
  title: string;
  message: string;
  onClose: () => void;
  [key: `data-${string}`]: string;
}

/** A header field's refusal, anchored under the field it came from; dismissed
 *  like every pane-header popover (`useDismissOverlay`) or after a timeout. */
export function AnchoredWarning({ anchorRect, title, message, onClose, ...dataAttrs }: AnchoredWarningProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    left: anchorRect.left,
    top: anchorRect.bottom + POPOVER_GAP,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = anchorRect.bottom + POPOVER_GAP;
    const maxLeft = Math.max(POPOVER_MARGIN, window.innerWidth - rect.width - POPOVER_MARGIN);
    setStyle({
      position: 'fixed',
      left: Math.min(Math.max(anchorRect.left, POPOVER_MARGIN), maxLeft),
      top,
    });
  }, [anchorRect]);

  useDismissOverlay(onClose, ref);

  useEffect(() => {
    const autoDismissMs = cfg.overlays.warningAutoDismissMs;
    if (autoDismissMs <= 0) return;
    const timeout = window.setTimeout(onClose, autoDismissMs);
    return () => window.clearTimeout(timeout);
  }, [onClose]);

  return createPortal(
    <div
      {...dataAttrs}
      ref={ref}
      role="alert"
      aria-label={`${title}: ${message}`}
      className={`${POPUP_SURFACE_CLASS} max-w-72 px-2.5 py-1.5 text-xs leading-snug`}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="font-medium" style={{ color: 'var(--color-error)' }}>{title}</div>
      <div className="mt-0.5 text-muted">{message}</div>
    </div>,
    document.body,
  );
}
