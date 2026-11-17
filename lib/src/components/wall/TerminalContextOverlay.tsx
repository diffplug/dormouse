import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Rect } from '../../lib/lath/model';
import { getTerminalInstance } from '../../lib/terminal-registry';
import { TerminalContext } from './TerminalContext';
import type { ContextMode, TerminalContextState } from './wall-context';
import { nowMs, type LathWallEngine } from './lath-wall-engine';
import { cursorHalfSide, placeTerminalContext, type ContextPlacement, type ContextSide } from './terminal-context-placement';

/** Above LathHost's drop preview (`Z_PREVIEW`). */
const Z_CONTEXT = 50;

/** The host's box: all of `rect`, or, for properties, only as tall as its rows, held to `anchor`. */
export function contextHostStyle({ rect: { x, y, width, height }, anchor }: ContextPlacement, mode: ContextMode): Record<'left' | 'top' | 'width' | 'height' | 'maxHeight' | 'transform', string> {
  if (mode === 'aux') return { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, maxHeight: '', transform: '' };
  const bottom = anchor === 'bottom';
  return { left: `${x}px`, top: `${bottom ? y + height : y}px`, width: `${width}px`, height: '', maxHeight: `${height}px`, transform: bottom ? 'translateY(-100%)' : '' };
}

/** One stable host per opening: moving the overlay never remounts its terminal. LathHost's
 *  paint places the host from the frame it just wrote, then publishes it to the selection
 *  ring; React re-renders only when the side or the available sides change. */
export function TerminalContextOverlay({ context, mode, focusRequest, title, tool, preview = false, params, wall, source, multiPane, lath, preferences }: {
  context: TerminalContextState; mode: ContextMode; focusRequest?: number; title?: string; tool: boolean; preview?: boolean; params?: Record<string, unknown>; wall: Rect; source: Rect;
  multiPane: boolean; lath: LathWallEngine; preferences: Map<string, ContextSide>;
}) {
  // Covering its source, the context takes the top half, where a header click came from;
  // `!` means to type, so it keeps clear of the source's visible cursor instead.
  const [coverSide] = useState<ContextSide>(() => {
    if (!context.keyboard || mode !== 'aux') return 'top';
    const terminal = getTerminalInstance(context.id);
    return cursorHalfSide(terminal?.buffer.active, terminal?.rows ?? 0);
  });
  // Properties never go below their source on their own, whatever was chosen there in an
  // earlier opening; a terminal already below keeps its side when switched to properties.
  const [manual, setManual] = useState(() => { const side = preferences.get(context.id); return mode === 'properties' && side === 'bottom' ? undefined : side; });
  const host = useRef<HTMLDivElement>(null);
  // The last placement, its side the next one's preference.
  const placed = useRef<ContextPlacement | undefined>(undefined);
  // The placer reads the mode as it paints.
  const modeRef = useRef(mode);
  const place = (painted: Rect | undefined) => {
    const avoid = modeRef.current === 'properties' ? 'bottom' : undefined;
    return placeTerminalContext(wall, painted ?? source, multiPane, manual ?? placed.current?.side, coverSide, avoid);
  };
  // Mount geometry only: children measure the host in layout effects that run before LathHost paints.
  const [initial] = useState(() => (placed.current = place(lath.animator.framesAt(nowMs()).get(context.id)?.rect)));
  const [shown, setShown] = useState<Omit<ContextPlacement, 'rect'>>(initial);
  const [initialStyle] = useState(() => contextHostStyle(initial, mode));
  // A switched mode restyles the host at once, without waiting for a paint, and the ring follows.
  useLayoutEffect(() => {
    if (modeRef.current === mode) return;
    modeRef.current = mode;
    if (host.current) Object.assign(host.current.style, contextHostStyle(placed.current ?? initial, mode));
    lath.notifyFrames(true);
  }, [lath, mode]);
  useLayoutEffect(() => {
    lath.setContextPlacer(paint => {
      const element = host.current;
      if (!element) return null;
      const next = place(paint.get(context.id)?.rect);
      placed.current = next;
      Object.assign(element.style, contextHostStyle(next, modeRef.current));
      setShown(previous => previous.side === next.side && previous.available.join() === next.available.join() ? previous : next);
      // Dismissal returns the ring to the source alone while the exit plays.
      return context.closing ? null : { sourceId: context.id, element, side: next.side };
    });
    // `place` reads exactly these inputs
  }, [lath, context.id, context.closing, manual, multiPane, coverSide, wall.x, wall.y, wall.width, wall.height, source.x, source.y, source.width, source.height]);
  useLayoutEffect(() => () => lath.setContextPlacer(null), [lath]);
  // Properties grow and shrink with their rows between paints; the ring follows.
  // The terminal mode's host changes size only in the placer's paint.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || mode !== 'properties') return;
    const observer = new ResizeObserver(() => lath.notifyFrames(true));
    observer.observe(element);
    return () => observer.disconnect();
  }, [lath, mode]);
  const onChange = useCallback((side: ContextSide) => {
    preferences.set(context.id, side);
    setManual(side);
  }, [context.id, preferences]);
  // LathHost re-renders on every commit and resize frame; the panel needs only these.
  const panel = useMemo(() => <TerminalContext {...context} mode={mode} focusRequest={focusRequest} title={title} tool={tool} preview={preview} params={params}
    placement={{ side: shown.side, available: shown.available, onChange }} />, [context, mode, focusRequest, title, tool, preview, params, shown, onChange]);
  return <div ref={host} className="absolute flex flex-col" style={{ ...initialStyle, zIndex: Z_CONTEXT }}>{panel}</div>;
}
