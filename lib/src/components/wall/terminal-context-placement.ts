import { edgeAxis, type Edge, type Rect } from '../../lib/lath/model';

export type ContextSide = Edge;
export type ContextPlacement = { rect: Rect; side: ContextSide; available: ContextSide[] };
const SIDES: ContextSide[] = ['right', 'left', 'bottom', 'top'];
/** Adjacent helpers reach into the source to align with its inset helper edge. */
const OVERLAP_INSET = 16;
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
    const space = side === 'right' ? right - source.x - source.width + OVERLAP_INSET
      : side === 'left' ? source.x - wall.x + OVERLAP_INSET
      : side === 'bottom' ? bottom - source.y - source.height + OVERLAP_INSET : source.y - wall.y + OVERLAP_INSET;
    const width = Math.max(0, Math.min(source.width, horizontal ? space : wall.width));
    const height = Math.max(0, Math.min(source.height, horizontal ? wall.height : space));
    return { side, rect: {
      x: side === 'right' ? source.x + source.width - OVERLAP_INSET : side === 'left' ? source.x + OVERLAP_INSET - width : clamp(source.x, wall.x, right - width),
      y: side === 'bottom' ? source.y + source.height - OVERLAP_INSET : side === 'top' ? source.y + OVERLAP_INSET - height : clamp(source.y, wall.y, bottom - height),
      width, height,
    } };
  }).filter(candidate => candidate.rect.width >= MIN_WIDTH && candidate.rect.height >= MIN_HEIGHT);
  const chosen = candidates.find(candidate => candidate.side === preferred)
    ?? candidates.reduce<typeof candidates[number] | undefined>((best, candidate) => !best || candidate.rect.width * candidate.rect.height > best.rect.width * best.rect.height ? candidate : best, undefined);
  if (chosen) return { ...chosen, available: candidates.map(candidate => candidate.side) };

  const side = preferred === 'top' || preferred === 'bottom' ? preferred : fallback;
  // Leave the source visible around overlapping helpers. Small sources may borrow
  // Wall space for usable chrome, but keep the inset even below the minimum size.
  const insetX = Math.min(OVERLAP_INSET, wall.width / 2);
  const insetY = Math.min(OVERLAP_INSET, wall.height / 2);
  const width = Math.min(wall.width - 2 * insetX, Math.max(source.width - 2 * insetX, MIN_WIDTH));
  const height = Math.min(wall.height - 2 * insetY, Math.max(source.height / 2 - 2 * insetY, MIN_HEIGHT));
  return { side, available: ['top', 'bottom'], rect: {
    x: clamp(source.x + insetX, wall.x + insetX, right - insetX - width),
    y: clamp(side === 'bottom' ? source.y + source.height - insetY - height : source.y + insetY, wall.y + insetY, bottom - insetY - height),
    width, height,
  } };
}
