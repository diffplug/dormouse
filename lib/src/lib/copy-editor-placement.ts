// Where the copy editor sits in the window (docs/specs/mouse-and-clipboard.md
// §4.5): a pure function of the viewport, the source pane, and the band of text
// being copied. Every coordinate is in viewport (fixed-position) pixels. The
// decision reads the band fresh each call and only the previous *side*, never
// the displayed rect, so a selection or scope change always re-places it.

import type { Span } from './copy-text';
import type { RingRect } from './rect-tween';
import type { TerminalOverlayDims } from './terminal-store';
import { OVERLAY_VIEWPORT_MARGIN_PX } from './ui-geometry';

export type CopyEditorSide = 'below' | 'above' | 'left' | 'right' | 'squish-below' | 'squish-above' | 'overlay';

/** Space between the editor and the band, and between the editor and the pane. */
export const GAP_PX = 4;
/** Below this, a squished editor yields to the overlay. */
export const MIN_HEIGHT_PX = 120;
/** The spare room a higher-priority spot needs before the editor leaves a
 *  natural-size spot, and the lead the other squish side needs. */
export const HYSTERESIS_PX = 24;
/** The overlay's height cap, as a fraction of the usable viewport. */
const OVERLAY_MAX_FRACTION = 0.6;

/** A vertical extent in viewport y. */
export interface Band {
  top: number;
  bottom: number;
}

export interface CopyEditorPlacementInput {
  /** `overlayViewportBounds()`. */
  viewport: { left: number; top: number; right: number; bottom: number };
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

/** A spot the editor could take at natural size; `spare` is the room it
 *  leaves, negative when the editor does not fit there. */
interface Candidate extends CopyEditorPlacement {
  spare: number;
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

/**
 * Natural size first, in order: desktop below, above, then the roomier side of
 * the pane; touch above, below, side. Then squished into the roomier of below
 * and above, while that leaves `MIN_HEIGHT_PX`. Last, the overlay docked at the
 * pane's bottom, the only spot that covers the band.
 */
export function placeCopyEditor(i: CopyEditorPlacementInput): CopyEditorPlacement {
  const { pane, band, naturalWidth, naturalHeight, touch, previous } = i;
  const m = OVERLAY_VIEWPORT_MARGIN_PX;
  const b = { left: i.viewport.left + m, top: i.viewport.top + m, right: i.viewport.right - m, bottom: i.viewport.bottom - m };
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
  const below: Candidate = { side: 'below', spare: roomBelow - height, rect: { left, top: belowTop, width, height } };
  const above: Candidate = { side: 'above', spare: roomAbove - height, rect: { left, top: aboveBottom - height, width, height } };

  const beside = (side: 'left' | 'right') => {
    const room = side === 'left' ? pane.left - GAP_PX - b.left : b.right - (pane.left + pane.width + GAP_PX);
    if (room < Math.min(floor, naturalWidth)) return null;
    const w = widthIn(room);
    const h = naturalHeight(w);
    if (h > b.bottom - b.top) return null;
    const x = side === 'left' ? pane.left - GAP_PX - w : pane.left + pane.width + GAP_PX;
    // A side never ranks above another natural spot, so its spare only says it fits.
    return { side, room, spare: 0, rect: { left: x, top: clamp(band.top, b.top, b.bottom - h), width: w, height: h } };
  };
  const sides = [beside('right'), beside('left')].filter((c) => c !== null);
  const [first, second] = sides;
  // Left and right share a rank: the held one stays while it fits, else the roomier.
  const side = sides.find((c) => c.side === previous) ?? (second && second.room > first.room ? second : first);

  const fits = (touch ? [above, below, side] : [below, above, side]).filter((c): c is Candidate => !!c && c.spare >= 0);
  const held = fits.findIndex((c) => c.side === previous);
  const chosen = held >= 0 ? fits.slice(0, held).find((c) => c.spare >= HYSTERESIS_PX) ?? fits[held] : fits[0];
  if (chosen) return { side: chosen.side, rect: chosen.rect };

  // No room at natural size: squish into the roomier of below and above.
  const squishes = [{ side: 'squish-below' as const, room: roomBelow }, { side: 'squish-above' as const, room: roomAbove }];
  const roomier = roomAbove > roomBelow ? squishes[1] : squishes[0];
  const kept = squishes.find((c) => c.side === previous && c.room >= MIN_HEIGHT_PX);
  const squish = kept && roomier.room - kept.room < HYSTERESIS_PX ? kept : roomier;
  // Neither natural spot fit, so the editor fills the room it gets.
  if (squish.room >= MIN_HEIGHT_PX) {
    const h = squish.room;
    return { side: squish.side, rect: { left, top: squish.side === 'squish-below' ? belowTop : aboveBottom - h, width, height: h } };
  }

  // Last resort: dock at the pane's bottom, over the selection.
  const h = Math.min(height, (b.bottom - b.top) * OVERLAY_MAX_FRACTION);
  const bottom = Math.min(pane.top + pane.height, b.bottom) - GAP_PX;
  return { side: 'overlay', rect: { left, top: Math.max(b.top, bottom - h), width, height: h } };
}
