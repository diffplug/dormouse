import { clsx } from 'clsx';
import { tv, type VariantProps } from 'tailwind-variants';
import { XIcon } from '@phosphor-icons/react';
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode, RefObject } from 'react';

// App-wide type scale, color strategy, and chrome conventions: see
// docs/specs/theme.md and AGENTS.md.

// Pane headers/doors own the top corners; terminal bodies own the bottom.
// All terminal-radius constants derive from this single source so the CSS
// class, the SVG-friendly px value, and the inline-style rem string can't
// drift apart. Tailwind's `lg` step is 0.5rem; if that ever changes, both
// the class names and BASE_REM must move together.
// Keep the class names as literals so Tailwind's scanner emits them.
const TERMINAL_BORDER_RADIUS_REM = 0.5;
export const TERMINAL_BORDER_RADIUS_PX = TERMINAL_BORDER_RADIUS_REM * 16;
export const TERMINAL_TOP_RADIUS_CLASS = 'rounded-t-lg';
export const TERMINAL_BOTTOM_RADIUS_CLASS = 'rounded-b-lg';
export const TERMINAL_SELECTION_BORDER_RADIUS = `${TERMINAL_BORDER_RADIUS_REM}rem`;
export const DOOR_SELECTION_BORDER_RADIUS = `${TERMINAL_BORDER_RADIUS_REM}rem ${TERMINAL_BORDER_RADIUS_REM}rem 0 0`;

// Letter-spacing for the small semibold TODO pill — wider tracking keeps the
// tiny label legible. Shared so both pill sites stay in sync.
export const TODO_PILL_TRACKING_CLASS = 'tracking-[0.08em]';

export function PopupButtonRow({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        'flex items-stretch overflow-hidden rounded border border-border bg-surface-raised font-mono text-sm text-foreground shadow-md',
        className,
      )}
      {...props}
    />
  );
}

export const popupButton = tv({
  base: 'm-0 px-1.5 py-0.5',
  variants: {
    tone: {
      foreground: '',
      muted: 'text-muted hover:text-foreground',
    },
    flashed: {
      true: 'animate-copy-flash bg-header-active-bg/25 text-header-active-bg',
      false: 'hover:bg-foreground/10',
    },
  },
  defaultVariants: { tone: 'foreground', flashed: false },
});

export type PopupButtonVariants = VariantProps<typeof popupButton>;

export interface ModalRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export const MODAL_LAYERS = {
  app: 50,
  pane: 100,
  critical: 9999,
} as const;

export type ModalLayer = keyof typeof MODAL_LAYERS;

export const modalOverlay = tv({
  base: 'flex items-center justify-center',
  variants: {
    scope: {
      viewport: 'fixed inset-0',
      target: 'rounded',
    },
    backdrop: {
      standard: 'bg-app-bg/50',
      strong: 'bg-app-bg/55',
    },
  },
  defaultVariants: { scope: 'viewport', backdrop: 'standard' },
});

export type ModalOverlayVariants = VariantProps<typeof modalOverlay>;

export const modalSurface = tv({
  base: 'rounded-lg border border-border bg-surface-raised font-mono text-foreground shadow-lg',
  variants: {
    padding: {
      none: 'p-0',
      compact: 'p-3',
      default: 'p-4',
      spacious: 'px-6 py-4',
    },
    align: {
      start: 'text-left',
      center: 'text-center',
    },
    elevation: {
      raised: 'shadow-lg',
      modal: 'shadow-2xl',
    },
  },
  defaultVariants: { padding: 'default', align: 'start', elevation: 'raised' },
});

export type ModalSurfaceVariants = VariantProps<typeof modalSurface>;

export const modalActionButton = tv({
  base: 'rounded px-2 py-1.5 text-xs transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-45',
  variants: {
    tone: {
      primary: 'bg-header-active-bg text-header-active-fg',
      secondary: 'border border-border text-muted hover:bg-header-inactive-bg hover:text-foreground',
    },
  },
  defaultVariants: { tone: 'secondary' },
});

export type ModalActionButtonVariants = VariantProps<typeof modalActionButton>;

export const modalReviewBlock = tv({
  base: 'block rounded border border-border bg-app-bg font-mono text-foreground whitespace-pre-wrap',
  variants: {
    density: {
      compact: 'p-2 text-xs',
      default: 'px-2.5 py-2 text-sm leading-relaxed',
    },
    overflow: {
      short: 'max-h-32 overflow-auto',
      medium: 'max-h-40 overflow-auto',
    },
    wrap: {
      breakAll: 'break-all',
      breakWords: 'break-words',
    },
  },
  defaultVariants: {
    density: 'default',
    overflow: 'medium',
    wrap: 'breakWords',
  },
});

export type ModalReviewBlockVariants = VariantProps<typeof modalReviewBlock>;
export type ModalReviewBlockProps = HTMLAttributes<HTMLDivElement> & ModalReviewBlockVariants;

export function ModalReviewBlock({
  density,
  overflow,
  wrap,
  className,
  ...props
}: ModalReviewBlockProps) {
  return (
    <div
      className={clsx(modalReviewBlock({ density, overflow, wrap }), className)}
      {...props}
    />
  );
}

export const modalIconButton = tv({
  base: 'shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring',
});

export type ModalCloseButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const ModalCloseButton = forwardRef<HTMLButtonElement, ModalCloseButtonProps>(
  function ModalCloseButton({
    children,
    className,
    type = 'button',
    ...props
  }, ref) {
    const ariaLabel = props['aria-label'] ?? 'Close';
    return (
      <button
        ref={ref}
        type={type}
        {...props}
        aria-label={ariaLabel}
        className={clsx(modalIconButton(), className)}
      >
        {children ?? <XIcon size={13} weight="bold" />}
      </button>
    );
  },
);

export function useMeasuredElementRect(element: HTMLElement | null): ModalRect | null {
  const [rect, setRect] = useState<ModalRect | null>(null);

  useLayoutEffect(() => {
    if (!element) {
      setRect(null);
      return;
    }

    const update = () => {
      const next = element.getBoundingClientRect();
      setRect({
        top: next.top,
        left: next.left,
        width: next.width,
        height: next.height,
      });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(element);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [element]);

  return rect;
}

export function ModalOverlay({
  children,
  targetElement,
  layer = 'pane',
  zIndex,
  backdrop = 'standard',
  className,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & ModalOverlayVariants & {
  targetElement?: HTMLElement | null;
  layer?: ModalLayer;
  zIndex?: number;
}) {
  const rect = useMeasuredElementRect(targetElement ?? null);
  const resolvedZIndex = zIndex ?? MODAL_LAYERS[layer];
  const overlayStyle: CSSProperties = rect
    ? {
        position: 'fixed',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        zIndex: resolvedZIndex,
        ...style,
      }
    : { zIndex: resolvedZIndex, ...style };

  return (
    <div
      className={clsx(modalOverlay({ scope: rect ? 'target' : 'viewport', backdrop }), className)}
      style={overlayStyle}
      {...props}
    >
      {children}
    </div>
  );
}

export type ModalSurfaceProps = HTMLAttributes<HTMLDivElement> & ModalSurfaceVariants;

export const ModalSurface = forwardRef<HTMLDivElement, ModalSurfaceProps>(function ModalSurface({
  children,
  padding,
  align,
  elevation,
  className,
  ...props
}, ref) {
  return (
    <div
      ref={ref}
      className={clsx(modalSurface({ padding, align, elevation }), className)}
      {...props}
    >
      {children}
    </div>
  );
});

export type ModalFrameProps = HTMLAttributes<HTMLDivElement> & ModalSurfaceVariants & {
  titleId: string;
  targetElement?: HTMLElement | null;
  layer?: ModalLayer;
  backdrop?: ModalOverlayVariants['backdrop'];
  overlayClassName?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onEscape?: () => void;
};

export function ModalFrame({
  children,
  titleId,
  targetElement,
  layer,
  backdrop,
  overlayClassName,
  initialFocusRef,
  onEscape,
  padding,
  align,
  elevation,
  className,
  ...props
}: ModalFrameProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(surfaceRef, { initialFocusRef, onEscape });

  return (
    <ModalOverlay
      targetElement={targetElement}
      layer={layer}
      backdrop={backdrop}
      className={overlayClassName}
    >
      <ModalSurface
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        padding={padding}
        align={align}
        elevation={elevation}
        className={className}
        {...props}
      >
        {children}
      </ModalSurface>
    </ModalOverlay>
  );
}

const MODAL_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function useModalFocusTrap<TModal extends HTMLElement, TInitial extends HTMLElement>(
  modalRef: RefObject<TModal | null>,
  {
    initialFocusRef,
    onEscape,
  }: {
    initialFocusRef?: RefObject<TInitial | null>;
    onEscape?: () => void;
  } = {},
): void {
  useEffect(() => {
    initialFocusRef?.current?.focus();
  }, [initialFocusRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const modal = modalRef.current;
      if (!modal) return;

      if (event.key === 'Escape') {
        if (onEscape) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const focusables = Array.from(modal.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;

      const currentIndex = focusables.findIndex((item) => item === document.activeElement);
      const nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;

      event.preventDefault();
      focusables[nextIndex]?.focus();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [modalRef, onEscape]);
}

// Chrome buttons: icon-only and labeled triggers used in the standalone app
// bar, plus the Windows/Linux native-style window controls. All inherit text
// color from the surrounding chrome so they tint with the active/inactive
// header palette — except `windowClose`, whose hover red matches the native
// OS close button across themes.
export const chromeButton = tv({
  base: 'flex items-center transition-colors',
  variants: {
    kind: {
      icon: 'h-5 min-w-5 justify-center rounded hover:bg-current/10',
      labeled: 'h-5 min-w-5 gap-1 rounded px-1.5 text-xs text-inherit hover:bg-current/10',
      window: 'w-11 justify-center text-inherit hover:bg-current/10',
      windowClose: 'w-11 justify-center text-inherit hover:bg-[#b92a1b] hover:text-white',
    },
  },
  defaultVariants: { kind: 'icon' },
});

export type ChromeButtonVariants = VariantProps<typeof chromeButton>;

/** Keyboard shortcut rendered as `[keys]` in muted color. Use everywhere key
 *  bindings appear in UI text so the bracket convention is consistent. */
export function Shortcut({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={clsx('text-muted', className)}>[{children}]</span>;
}

/** Render a string with any `[...]` segments replaced by <Shortcut>. */
export function renderShortcuts(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /\[([^\]]+)\]/g;
  let lastIndex = 0;
  let idx = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(<Shortcut key={idx++}>{match[1]}</Shortcut>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}
