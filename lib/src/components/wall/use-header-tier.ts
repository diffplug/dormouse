import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * A pane header's responsive tier, quantized from its own border-box width
 * (`docs/specs/layout.md` → "Pane header responsive sizing"). The Lath animator
 * resizes leaves every frame of a tween or sash drag, so the observer keeps the
 * raw width out of React state: the header re-renders only when `tierFor`
 * changes its answer. The first measurement is synchronous so a narrow pane
 * never paints one frame of full-width chrome; a zero width (a hidden leaf)
 * keeps the previous tier. `onResize` fires on every observed resize regardless.
 *
 * `reservePx` is the width of leading controls the header shows now, taken off
 * before `tierFor`. One appearing inside a flex header changes no border box,
 * so a change re-derives the tier from the last measurement.
 */
export function useHeaderTier<T>(
  ref: RefObject<HTMLElement | null>,
  tierFor: (width: number) => T,
  { onResize, reservePx = 0 }: { onResize?: () => void; reservePx?: number } = {},
): T {
  const [tier, setTier] = useState<T>(() => tierFor(Number.POSITIVE_INFINITY));
  const measured = useRef(0);
  const latest = useRef({ tierFor, onResize, reservePx });
  latest.current = { tierFor, onResize, reservePx };
  useLayoutEffect(() => {
    const header = ref.current;
    if (!header) return;
    const measure = (width: number) => {
      if (width <= 0) return;
      measured.current = width;
      setTier(latest.current.tierFor(width - latest.current.reservePx));
    };
    measure(header.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      measure(entry.borderBoxSize?.[0]?.inlineSize ?? header.getBoundingClientRect().width);
      latest.current.onResize?.();
    });
    observer.observe(header, { box: 'border-box' });
    return () => observer.disconnect();
  }, [ref]);
  useLayoutEffect(() => {
    if (measured.current > 0) setTier(tierFor(measured.current - reservePx));
  }, [tierFor, reservePx]);
  return tier;
}
