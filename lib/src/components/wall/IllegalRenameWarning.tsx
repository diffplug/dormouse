import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { SetTerminalUserTitleResult } from '../../lib/terminal-registry';

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

  useEffect(() => {
    const dismiss = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    const timeout = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="alert"
      data-testid="illegal-rename-warning"
      aria-label={`Illegal name: ${describeReason(reason, attemptedValue)}`}
      className="z-[1000] max-w-72 rounded border border-border bg-surface-raised px-2.5 py-1.5 font-mono text-xs leading-snug text-foreground shadow-md"
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
