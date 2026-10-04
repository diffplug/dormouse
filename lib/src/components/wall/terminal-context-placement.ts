import { edgeAxis, type Edge, type Rect } from '../../lib/lath/model';
import { TERMINAL_CONTEXT_TEETH_PX } from '../design';

export type ContextSide = Edge;
export type ContextPlacement = { rect: Rect; side: ContextSide; available: ContextSide[] };
const SIDES: ContextSide[] = ['right', 'left', 'bottom', 'top'];
/** Adjacent helpers overlap the source only by their teeth, which the rect includes. */
const OVERLAP = TERMINAL_CONTEXT_TEETH_PX;
/** Above helpers only graze the source title, extending upward over peer headers instead. */
const ABOVE_EXTENSION = 32;
// Compact source/directory/status chrome plus a useful terminal viewport.
const MIN_WIDTH = 280;
const MIN_HEIGHT = 240;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Only an on-screen cursor is evidence about which half should stay visible. */
export function cursorHalfSide(buffer: { baseY: number; cursorY: number; viewportY: number } | undefined, rows: number): ContextSide {
  if (!buffer || rows <= 0) return 'top';
  const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
  return row >= 0 && row < rows / 2 ? 'bottom' : 'top';
}

/** Bounds are in Wall coordinates. Overlays may cover peers, never resize them. */
export function placeTerminalContext(wall: Rect, source: Rect, multiPane: boolean, preferred?: ContextSide, fallback: ContextSide = 'top'): ContextPlacement {
  const right = wall.x + wall.width;
  const bottom = wall.y + wall.height;
  const candidates = !multiPane ? [] : SIDES.map(side => {
    const horizontal = edgeAxis(side) === 'row';
    const space = OVERLAP + (side === 'right' ? right - source.x - source.width
      : side === 'left' ? source.x - wall.x
      : side === 'bottom' ? bottom - source.y - source.height : source.y - wall.y);
    const width = Math.max(0, Math.min(source.width, horizontal ? space : wall.width));
    const desiredHeight = source.height + (side === 'top' ? ABOVE_EXTENSION + OVERLAP : 0);
    const height = Math.max(0, Math.min(desiredHeight, horizontal ? wall.height : space));
    return { side, rect: {
      x: side === 'right' ? source.x + source.width - OVERLAP : side === 'left' ? source.x + OVERLAP - width : clamp(source.x, wall.x, right - width),
      y: side === 'bottom' ? source.y + source.height - OVERLAP : side === 'top' ? source.y + OVERLAP - height : clamp(source.y, wall.y, bottom - height),
      width, height,
    } };
  }).filter(candidate => candidate.rect.width >= MIN_WIDTH && candidate.rect.height >= MIN_HEIGHT);
  const chosen = candidates.find(candidate => candidate.side === preferred)
    ?? candidates.reduce<typeof candidates[number] | undefined>((best, candidate) => !best || candidate.rect.width * candidate.rect.height > best.rect.width * best.rect.height ? candidate : best, undefined);
  if (chosen) return { ...chosen, available: candidates.map(candidate => candidate.side) };

  // Cover the source's half on its own edges, as adjacent helpers align with theirs.
  // Small sources may borrow Wall space for usable chrome.
  const side = preferred === 'top' || preferred === 'bottom' ? preferred : fallback;
  const width = Math.min(wall.width, Math.max(source.width, MIN_WIDTH));
  const height = Math.min(wall.height, Math.max(source.height / 2, MIN_HEIGHT));
  return { side, available: ['top', 'bottom'], rect: {
    x: clamp(source.x, wall.x, right - width),
    y: clamp(side === 'bottom' ? source.y + source.height - height : source.y, wall.y, bottom - height),
    width, height,
  } };
}
