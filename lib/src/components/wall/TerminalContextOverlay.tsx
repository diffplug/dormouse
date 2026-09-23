import { useLayoutEffect, useRef, useState } from 'react';
import type { Rect } from '../../lib/lath/model';
import { getTerminalInstance } from '../../lib/terminal-registry';
import { TerminalContext } from './TerminalContext';
import type { TerminalContextState } from './wall-context';
import { nowMs, type LathWallEngine } from './lath-wall-engine';
import { cursorHalfSide, placeTerminalContext, type ContextPlacement, type ContextSide } from './terminal-context-placement';

/** Above LathHost's drop preview (`Z_PREVIEW`). */
const Z_CONTEXT = 50;

const boxStyle = ({ x, y, width, height }: Rect) => ({ left: x, top: y, width, height });
function writeBox(element: HTMLElement | null, rect: Rect) {
  if (element) Object.assign(element.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

/** One stable host per opening: moving the overlay never remounts its terminal. Animator
 *  frames write bounds straight to the DOM; React re-renders only when the side or the
 *  available sides change. */
export function TerminalContextOverlay({ context, title, tool, wall, source, multiPane, lath, preferences }: {
  context: TerminalContextState; title?: string; tool: boolean; wall: Rect; source: Rect;
  multiPane: boolean; lath: LathWallEngine; preferences: Map<string, ContextSide>;
}) {
  const [cursorSide] = useState(() => {
    const terminal = getTerminalInstance(context.id);
    return cursorHalfSide(terminal?.buffer.active, terminal?.rows ?? 0);
  });
  const [manual, setManual] = useState(() => preferences.get(context.id));
  const lastSide = useRef<ContextSide | undefined>(manual);
  const host = useRef<HTMLDivElement>(null);
  const measure = () => {
    const painted = lath.animator.framesAt(nowMs()).get(context.id)?.rect ?? source;
    return { painted, placement: placeTerminalContext(wall, painted, multiPane, manual ?? lastSide.current, cursorSide) };
  };
  const [shown, setShown] = useState<{ painted: Rect; placement: ContextPlacement }>(measure);
  useLayoutEffect(() => {
    const update = () => {
      const next = measure();
      lastSide.current = next.placement.side;
      writeBox(host.current, next.placement.rect);
      setShown(previous => previous.placement.side === next.placement.side
        && previous.placement.available.join() === next.placement.available.join() ? previous : next);
    };
    update();
    return lath.subscribeFrames(update);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` reads exactly these inputs
  }, [lath, context.id, manual, multiPane, cursorSide, wall.x, wall.y, wall.width, wall.height, source.x, source.y, source.width, source.height]);
  return <>
    <div ref={host} data-context-for={context.id} className="absolute" style={{ ...boxStyle(shown.placement.rect), zIndex: Z_CONTEXT }}>
      <TerminalContext {...context} title={title} tool={tool} compact placement={{ ...shown.placement, manual: manual !== undefined, onChange: side => {
        if (side) preferences.set(context.id, side); else preferences.delete(context.id);
        lastSide.current = side;
        setManual(side);
      } }} />
    </div>
  </>;
}
