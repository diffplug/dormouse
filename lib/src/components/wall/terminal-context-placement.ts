import type { Rect } from '../../lib/lath/model';

export type ContextSide = 'right' | 'left' | 'bottom' | 'top';
export type ContextPlacement = { rect: Rect; side: ContextSide; mode: 'adjacent' | 'half'; available: ContextSide[] };
const SIDES: ContextSide[] = ['right', 'left', 'bottom', 'top'];
const GAP = 8;
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
  const candidates = SIDES.map(side => {
    const horizontal = side === 'left' || side === 'right';
    const space = side === 'right' ? right - source.x - source.width - GAP
      : side === 'left' ? source.x - wall.x - GAP
      : side === 'bottom' ? bottom - source.y - source.height - GAP : source.y - wall.y - GAP;
    const width = Math.max(0, Math.min(source.width, horizontal ? space : wall.width));
    const height = Math.max(0, Math.min(source.height, horizontal ? wall.height : space));
    return { side, rect: {
      x: side === 'right' ? source.x + source.width + GAP : side === 'left' ? source.x - GAP - width : clamp(source.x, wall.x, right - width),
      y: side === 'bottom' ? source.y + source.height + GAP : side === 'top' ? source.y - GAP - height : clamp(source.y, wall.y, bottom - height),
      width, height,
    } };
  }).filter(candidate => multiPane && candidate.rect.width >= MIN_WIDTH && candidate.rect.height >= MIN_HEIGHT);
  const chosen = candidates.find(candidate => candidate.side === preferred)
    ?? candidates.reduce<typeof candidates[number] | undefined>((best, candidate) => !best || candidate.rect.width * candidate.rect.height > best.rect.width * best.rect.height ? candidate : best, undefined);
  if (chosen) return { ...chosen, mode: 'adjacent', available: candidates.map(candidate => candidate.side) };

  const side = preferred === 'top' || preferred === 'bottom' ? preferred : fallback;
  // Small source panes borrow Wall width/height only when the half-pane would be unusable.
  const width = Math.min(wall.width, Math.max(source.width, MIN_WIDTH));
  const height = Math.min(wall.height, Math.max(source.height / 2, MIN_HEIGHT));
  return { side, mode: 'half', available: ['top', 'bottom'], rect: {
    x: clamp(source.x, wall.x, right - width),
    y: clamp(side === 'bottom' ? source.y + source.height - height : source.y, wall.y, bottom - height),
    width, height,
  } };
}
