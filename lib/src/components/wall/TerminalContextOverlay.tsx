import { useLayoutEffect, useRef, useState } from 'react';
import type { Rect } from '../../lib/lath/model';
import { getTerminalInstance } from '../../lib/terminal-registry';
import { TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import { TerminalContext } from './TerminalContext';
import type { TerminalContextState } from './wall-context';
import { nowMs, type LathWallEngine } from './lath-wall-engine';
import { cursorHalfSide, placeTerminalContext, type ContextSide } from './terminal-context-placement';

/** One stable host per opening: moving the overlay never remounts its terminal. */
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
  const [painted, setPainted] = useState(source);
  useLayoutEffect(() => {
    const update = () => {
      const next = lath.animator.framesAt(nowMs()).get(context.id)?.rect ?? source;
      setPainted(previous => previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height ? previous : next);
    };
    update();
    return lath.subscribeFrames(update);
  }, [lath, context.id, source.x, source.y, source.width, source.height]);
  const placement = placeTerminalContext(wall, painted, multiPane, manual ?? lastSide.current, cursorSide);
  useLayoutEffect(() => { lastSide.current = placement.side; }, [placement.side]);
  const { rect } = placement;
  return <>
    <div aria-hidden data-context-source={context.id} className="pointer-events-none absolute border border-focus-ring" style={{
      left: painted.x, top: painted.y, width: painted.width, height: painted.height,
      borderRadius: TERMINAL_SELECTION_BORDER_RADIUS, zIndex: 49,
    }} />
    <TerminalContext {...context} title={title} tool={tool} presentation={{
      compact: true,
      style: { left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 50 },
      placement: { ...placement, manual: manual !== undefined, onChange: side => {
        if (side) preferences.set(context.id, side); else preferences.delete(context.id);
        lastSide.current = side;
        setManual(side);
      } },
    }} />
  </>;
}
