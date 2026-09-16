import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * A pane header's responsive tier, quantized from its own border-box width
 * (`docs/specs/layout.md` → "Pane header responsive sizing"). The Lath animator
 * resizes leaves every frame of a tween or sash drag, so the observer keeps the
 * raw width out of React state: the header re-renders only when `tierFor`
 * changes its answer. The first measurement is synchronous so a narrow pane
 * never paints one frame of full-width chrome; a zero width (a hidden leaf)
 * keeps the previous tier. `onResize` fires on every observed resize regardless.
 */
export function useHeaderTier<T>(
  ref: RefObject<HTMLElement | null>,
  tierFor: (width: number) => T,
  onResize?: () => void,
): T {
  const [tier, setTier] = useState<T>(() => tierFor(Number.POSITIVE_INFINITY));
  const latest = useRef({ tierFor, onResize });
  latest.current = { tierFor, onResize };
  useLayoutEffect(() => {
    const header = ref.current;
    if (!header) return;
    const measure = (width: number) => { if (width > 0) setTier(latest.current.tierFor(width)); };
    measure(header.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      measure(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
      latest.current.onResize?.();
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [ref]);
  return tier;
}
