// Where the copy editor sits in the window (docs/specs/mouse-and-clipboard.md
// §4.5): a pure function of the viewport, the source pane, and the band of text
// being copied. Every coordinate is in viewport (fixed-position) pixels. The
// decision reads the band fresh each call and only the previous *side*, never
// the displayed rect, so a selection or scope change always re-places it.

import type { Span } from './copy-text';
import type { RingRect } from './rect-tween';
import type { TerminalOverlayDims } from './terminal-store';
import { insetOverlayBounds, type overlayViewportBounds } from './ui-geometry';

export type CopyEditorSide = 'below' | 'above' | 'left' | 'right' | 'squish-below' | 'squish-above' | 'overlay';

/** Space between the editor and the band, and between the editor and the pane. */
export const GAP_PX = 4;
/** Below this, a squished editor yields to the overlay. */
const MIN_HEIGHT_PX = 120;
/** The spare room a higher-priority spot needs before the editor leaves a
 *  natural-size spot, and the lead the other squish side needs. */
const HYSTERESIS_PX = 24;
/** The overlay's height cap, as a fraction of the usable viewport. */
const OVERLAY_MAX_FRACTION = 0.6;

/** A vertical extent in viewport y. */
export interface Band {
  top: number;
  bottom: number;
}

export interface CopyEditorPlacementInput {
  viewport: ReturnType<typeof overlayViewportBounds>;
  /** The source terminal's box. */
  pane: RingRect;
  /** `selectionBand`: the text the editor must not cover. */
  band: Band;
  /** The longest line across every format of the current scope. */
  naturalWidth: number;
  /** The editor's whole height when laid out at `width`. */
  naturalHeight: (width: number) => number;
  touch: boolean;
  previous: CopyEditorSide | null;
}

export interface CopyEditorPlacement {
  side: CopyEditorSide;
  rect: RingRect;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** The union of `spans` in viewport y, each row clamped to the visible grid. */
export function selectionBand(dims: TerminalOverlayDims, spans: readonly [Span, ...Span[]]): Band {
  const y = (row: number) => dims.elementTop + dims.gridTop + clamp(row - dims.viewportY, 0, dims.rows) * dims.cellHeight;
  return {
    top: y(Math.min(...spans.map((s) => s.start.row))),
    bottom: y(Math.max(...spans.map((s) => s.end.row)) + 1),
  };
}

/** The first of `ranked`, unless `previous` is among them and nothing ranked
 *  above it `outranks` it. */
function hold<C extends CopyEditorPlacement>(
  ranked: readonly C[],
  previous: CopyEditorSide | null,
  outranks: (candidate: C, held: C) => boolean = () => false,
): C | undefined {
  const held = ranked.find((c) => c.side === previous);
  return held ? ranked.find((c) => c === held || outranks(c, held)) : ranked[0];
}

/**
 * Natural size first, in order: desktop below, above, then the roomier side of
 * the pane; touch above, below, side. Then squished into the roomier of below
 * and above, while that leaves `MIN_HEIGHT_PX`. Last, the overlay docked at the
 * pane's bottom, the only spot that covers the band.
 */
export function placeCopyEditor(i: CopyEditorPlacementInput): CopyEditorPlacement {
  const { pane, band, naturalWidth, naturalHeight, touch, previous } = i;
  const b = insetOverlayBounds(i.viewport);
  const floor = pane.width - 2 * GAP_PX;
  const widthIn = (room: number) => Math.min(room, Math.max(floor, naturalWidth));

  // Above and below may spill over neighbouring panes; only the window clamps them.
  const width = widthIn(b.right - b.left);
  const left = clamp(pane.left + GAP_PX, b.left, b.right - width);
  const height = naturalHeight(width);
  const belowTop = band.bottom + GAP_PX;
  const aboveBottom = band.top - GAP_PX;
  const roomBelow = b.bottom - belowTop;
  const roomAbove = aboveBottom - b.top;
  const below: CopyEditorPlacement = { side: 'below', rect: { left, top: belowTop, width, height } };
  const above: CopyEditorPlacement = { side: 'above', rect: { left, top: aboveBottom - height, width, height } };
  // The room a natural spot leaves, negative when the editor does not fit. A
  // side ranks last, so it is never asked.
  const spare = (c: CopyEditorPlacement) => (c === below ? roomBelow : roomAbove) - height;

  // Left and right share a rank: the held one stays while it fits, else the roomier.
  const beside = () => {
    const room = { left: pane.left - GAP_PX - b.left, right: b.right - (pane.left + pane.width + GAP_PX) };
    const spot = (side: 'left' | 'right'): CopyEditorPlacement | null => {
      if (room[side] < Math.min(floor, naturalWidth)) return null;
      const w = widthIn(room[side]);
      const h = naturalHeight(w);
      if (h > b.bottom - b.top) return null;
      const x = side === 'left' ? pane.left - GAP_PX - w : pane.left + pane.width + GAP_PX;
      return { side, rect: { left: x, top: clamp(band.top, b.top, b.bottom - h), width: w, height: h } };
    };
    const order = room.left > room.right ? (['left', 'right'] as const) : (['right', 'left'] as const);
    return hold(order.map(spot).filter((c) => c !== null), previous);
  };

  const vertical = (touch ? [above, below] : [below, above]).filter((c) => spare(c) >= 0);
  // A side matters only when neither natural spot fits, or while it is held.
  const side = vertical.length === 0 || previous === 'left' || previous === 'right' ? beside() : undefined;
  const natural = hold(side ? [...vertical, side] : vertical, previous, (c) => spare(c) >= HYSTERESIS_PX);
  if (natural) return natural;

  // No room at natural size: squish into the roomier of below and above, which
  // the editor fills.
  const squishBelow: CopyEditorPlacement = { side: 'squish-below', rect: { left, top: belowTop, width, height: roomBelow } };
  const squishAbove: CopyEditorPlacement = { side: 'squish-above', rect: { left, top: b.top, width, height: roomAbove } };
  const squishes = (roomAbove > roomBelow ? [squishAbove, squishBelow] : [squishBelow, squishAbove]).filter((c) => c.rect.height >= MIN_HEIGHT_PX);
  const squish = hold(squishes, previous, (c, held) => c.rect.height - held.rect.height >= HYSTERESIS_PX);
  if (squish) return squish;

  // Last resort: dock at the pane's bottom, over the selection.
  const h = Math.min(height, (b.bottom - b.top) * OVERLAY_MAX_FRACTION);
  const bottom = Math.min(pane.top + pane.height, b.bottom) - GAP_PX;
  return { side: 'overlay', rect: { left, top: Math.max(b.top, bottom - h), width, height: h } };
}
