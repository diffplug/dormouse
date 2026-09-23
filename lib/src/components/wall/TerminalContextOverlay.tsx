import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Rect } from '../../lib/lath/model';
import { getTerminalInstance } from '../../lib/terminal-registry';
import { TerminalContext } from './TerminalContext';
import type { TerminalContextState } from './wall-context';
import { nowMs, type LathWallEngine } from './lath-wall-engine';
import { cursorHalfSide, placeTerminalContext, type ContextPlacement, type ContextSide } from './terminal-context-placement';

/** Above LathHost's drop preview (`Z_PREVIEW`). */
const Z_CONTEXT = 50;

const boxPx = ({ x, y, width, height }: Rect) => ({ left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });

/** One stable host per opening: moving the overlay never remounts its terminal. Animator
 *  frames write bounds and side straight to the host, which the selection ring observes;
 *  React re-renders only when the side or the available sides change. */
export function TerminalContextOverlay({ context, title, tool, wall, source, multiPane, lath, preferences }: {
  context: TerminalContextState; title?: string; tool: boolean; wall: Rect; source: Rect;
  multiPane: boolean; lath: LathWallEngine; preferences: Map<string, ContextSide>;
}) {
  const [cursorSide] = useState(() => {
    const terminal = getTerminalInstance(context.id);
    return cursorHalfSide(terminal?.buffer.active, terminal?.rows ?? 0);
  });
  const [manual, setManual] = useState(() => preferences.get(context.id));
  const lastSide = useRef<ContextSide | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const measure = () => placeTerminalContext(wall, lath.animator.framesAt(nowMs()).get(context.id)?.rect ?? source,
    multiPane, manual ?? lastSide.current, cursorSide);
  // Mount geometry only: children measure the host in layout effects that run before ours.
  const [initial] = useState(measure);
  const [shown, setShown] = useState<Omit<ContextPlacement, 'rect'>>(initial);
  useLayoutEffect(() => {
    const update = () => {
      const next = measure();
      lastSide.current = next.side;
      if (host.current) {
        Object.assign(host.current.style, boxPx(next.rect));
        host.current.dataset.contextSide = next.side;
      }
      setShown(previous => previous.side === next.side && previous.available.join() === next.available.join() ? previous : next);
    };
    update();
    return lath.subscribeFrames(update);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` reads exactly these inputs
  }, [lath, context.id, manual, multiPane, cursorSide, wall.x, wall.y, wall.width, wall.height, source.x, source.y, source.width, source.height]);
  const onChange = useCallback((side: ContextSide) => {
    preferences.set(context.id, side);
    setManual(side);
  }, [context.id, preferences]);
  // LathHost re-renders on every commit and resize frame; the panel needs only these.
  const panel = useMemo(() => <TerminalContext {...context} title={title} tool={tool}
    placement={{ side: shown.side, available: shown.available, onChange }} />, [context, title, tool, shown, onChange]);
  return <div ref={host} data-context-for={context.id} className="absolute" style={{ ...boxPx(initial.rect), zIndex: Z_CONTEXT }}>{panel}</div>;
}
