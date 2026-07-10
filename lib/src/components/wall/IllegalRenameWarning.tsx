import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { POPUP_SURFACE_CLASS } from '../design';
import type { SetTerminalUserTitleResult } from '../../lib/terminal-registry';
import { useDismissOverlay } from './use-dismiss-overlay';

export type RenameRejection = Extract<SetTerminalUserTitleResult, { accepted: false }>['reason'];

const POPOVER_GAP = 6;
const POPOVER_MARGIN = 8;
const AUTO_DISMISS_MS = 3000;

export interface IllegalRenameWarningProps {
  anchorRect: DOMRect;
  reason: RenameRejection;
  attemptedValue: string;
  onClose: () => void;
}

export function IllegalRenameWarning({ anchorRect, reason, attemptedValue, onClose }: IllegalRenameWarningProps) {
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

  useDismissOverlay(onClose);

  useEffect(() => {
    const timeout = window.setTimeout(onClose, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeout);
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="alert"
      data-testid="illegal-rename-warning"
      aria-label={`Illegal name: ${describeReason(reason, attemptedValue)}`}
      className={`${POPUP_SURFACE_CLASS} max-w-72 px-2.5 py-1.5 text-xs leading-snug`}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="font-medium" style={{ color: 'var(--color-error)' }}>Illegal name</div>
      <div className="mt-0.5 text-muted">{describeReason(reason, attemptedValue)}</div>
    </div>,
    document.body,
  );
}

function describeReason(reason: RenameRejection, attemptedValue: string): string {
  if (reason === 'empty') return 'Pane names cannot be blank.';
  const trimmed = attemptedValue.trim();
  return `"${trimmed}" is reserved for derived labels.`;
}
