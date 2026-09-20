import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PopupButtonRow, renderShortcuts } from './design';

export interface HeaderActionButtonProps {
  className: string;
  ariaLabel: string;
  tooltip?: string | null;
  tooltipDetail?: string;
  tooltipAlign?: 'left' | 'right';
  onMouseDownCapture?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}

export function HeaderActionButton({
  className,
  ariaLabel,
  tooltip,
  tooltipDetail,
  tooltipAlign = 'right',
  onMouseDownCapture,
  onMouseDown,
  onClick,
  onContextMenu,
  children,
}: HeaderActionButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties | null>(null);
  const tooltipPrimary = tooltip === null ? null : (tooltip ?? ariaLabel);

  useEffect(() => {
    if (!isVisible || !buttonRef.current) return;

    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltipStyle({
        position: 'fixed',
        left: tooltipAlign === 'left' ? rect.left : rect.right,
        top: rect.bottom + 8,
        transform: tooltipAlign === 'left' ? 'translate(0, 0)' : 'translate(-100%, 0)',
      });
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isVisible, tooltipAlign]);

  return (
    <>
    <div className="relative flex shrink-0 items-center">
      <button
        ref={buttonRef}
        type="button"
        className={className}
        onMouseDownCapture={onMouseDownCapture}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMouseDown?.(e);
        }}
        onClick={(e) => {
          e.stopPropagation();
          setIsVisible(false);
          onClick(e);
        }}
        onContextMenu={onContextMenu ? (e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e);
        } : undefined}
        aria-label={ariaLabel}
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        onFocus={() => setIsVisible(true)}
        onBlur={() => setIsVisible(false)}
      >
        {children}
      </button>
    </div>
    {isVisible && tooltipStyle && tooltipPrimary && createPortal(
      <PopupButtonRow
        role="tooltip"
        className="pointer-events-none z-[9999] whitespace-nowrap px-2 py-1.5"
        style={tooltipStyle}
      >
        <div className="flex flex-col gap-0.5 leading-none">
          <div>{renderShortcuts(tooltipPrimary)}</div>
          {tooltipDetail && <div>{renderShortcuts(tooltipDetail)}</div>}
        </div>
      </PopupButtonRow>,
      document.body,
    )}
    </>
  );
}
