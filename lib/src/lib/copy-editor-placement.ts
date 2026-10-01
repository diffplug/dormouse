// Where the copy editor sits in the window (docs/specs/mouse-and-clipboard.md
// §4.5): a pure function of the viewport, the source pane, and the band of text
// being copied. Every coordinate is in viewport (fixed-position) pixels. The
// decision reads the band fresh each call and only the previous *side*, never
// the displayed rect, so a selection or scope change always re-places it.

import type { Span } from './copy-text';
import type { RingRect } from './rect-tween';
import type { TerminalOverlayDims } from './terminal-store';
import { insetOverlayBounds, type overlayViewportBounds } from './ui-geometry';

export type CopyEditorSide =
  | 'below' | 'above' | 'left' | 'right'
  | 'squish-below' | 'squish-above' | 'squish-left' | 'squish-right'
  | 'overlay';

/** Space between the editor and the band, and between the editor and the pane. */
export const GAP_PX = 4;
/** Below this, a squished editor yields to the overlay. */
const MIN_HEIGHT_PX = 120;
/** The spare room a higher-priority spot needs before the editor leaves a
 *  natural-size spot, and the lead, as rows this tall at the held spot's
 *  width, another squish needs. */
const HYSTERESIS_PX = 24;
/** The overlay's height cap, as a fraction of the usable viewport. */
const OVERLAY_MAX_FRACTION = 0.6;

/** A touch or pen press this close outside the editor is a missed tap on it. */
export const TOUCH_SLOP_PX = 16;

/** Whether (x, y) is outside `rect` but within `TOUCH_SLOP_PX` of it. */
export function nearMiss(rect: { left: number; top: number; right: number; bottom: number }, x: number, y: number): boolean {
  const within = (slop: number) => x >= rect.left - slop && x <= rect.right + slop && y >= rect.top - slop && y <= rect.bottom + slop;
  return within(TOUCH_SLOP_PX) && !within(0);
}

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
  /** The header and footer laid out whole, which never wrap. */
  chromeWidth: number;
  /** The segments, the count, and Copy, without the key hints and legend:
   *  the least room a side needs. */
  essentialWidth: number;
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
 * the pane; touch above, below, side. Then squished into whichever of the four
 * gives the most area, while that leaves `MIN_HEIGHT_PX`. Last, the overlay
 * docked at the pane's bottom, the only spot that covers the band.
 */
export function placeCopyEditor(i: CopyEditorPlacementInput): CopyEditorPlacement {
  const { pane, band, naturalWidth, chromeWidth, essentialWidth, naturalHeight, touch, previous } = i;
  const b = insetOverlayBounds(i.viewport);
  const fullHeight = b.bottom - b.top;
  const floor = pane.width - 2 * GAP_PX;
  // At least the pane and the chrome, at most the longest line or the chrome.
  const widthIn = (room: number) => Math.min(room, Math.max(floor, chromeWidth, naturalWidth));

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

  // Each side of the pane with room for the editor's buttons, the roomier
  // first, at the width it would take there; measured once, only if asked. A
  // side narrower than the chrome clips the key hints and legend.
  let sides: { side: 'left' | 'right'; left: number; width: number; height: number }[] | undefined;
  const beside = () => {
    if (sides) return sides;
    const room = { left: pane.left - GAP_PX - b.left, right: b.right - (pane.left + pane.width + GAP_PX) };
    const order = room.left > room.right ? (['left', 'right'] as const) : (['right', 'left'] as const);
    sides = order.filter((side) => room[side] >= essentialWidth).map((side) => {
      const w = widthIn(room[side]);
      const x = side === 'left' ? pane.left - GAP_PX - w : pane.left + pane.width + GAP_PX;
      return { side, left: x, width: w, height: naturalHeight(w) };
    });
    return sides;
  };
  // A side's rect, top-aligned to the band and clamped into the window.
  const at = (s: { left: number; width: number }, h: number) => ({ left: s.left, top: clamp(band.top, b.top, b.bottom - h), width: s.width, height: h });

  const vertical = (touch ? [above, below] : [below, above]).filter((c) => spare(c) >= 0);
  // A side matters only when neither natural spot fits, or while it is held.
  // Left and right share a rank: the held one stays while it fits, else the roomier.
  const side = vertical.length === 0 || previous === 'left' || previous === 'right'
    ? hold(beside().filter((s) => s.height <= fullHeight).map((s) => ({ side: s.side, rect: at(s, s.height) })), previous)
    : undefined;
  const natural = hold(side ? [...vertical, side] : vertical, previous, (c) => spare(c) >= HYSTERESIS_PX);
  if (natural) return natural;

  // No room at natural size: squish into whichever spot gives the most area,
  // ties in the natural order. Below and above fill their room; a side takes
  // the window's height.
  const squishBelow: CopyEditorPlacement = { side: 'squish-below', rect: { left, top: belowTop, width, height: roomBelow } };
  const squishAbove: CopyEditorPlacement = { side: 'squish-above', rect: { left, top: b.top, width, height: roomAbove } };
  const squishSides = beside().map((s): CopyEditorPlacement => {
    const h = Math.min(s.height, fullHeight);
    return { side: s.side === 'left' ? 'squish-left' : 'squish-right', rect: at(s, h) };
  });
  const area = (c: CopyEditorPlacement) => c.rect.width * c.rect.height;
  const squishes = [...(touch ? [squishAbove, squishBelow] : [squishBelow, squishAbove]), ...squishSides]
    .filter((c) => c.rect.height >= MIN_HEIGHT_PX)
    .sort((x, y) => area(y) - area(x));
  const squish = hold(squishes, previous, (c, held) => area(c) - area(held) >= HYSTERESIS_PX * held.rect.width);
  if (squish) return squish;

  // Last resort: dock at the pane's bottom, over the selection.
  const h = Math.min(height, fullHeight * OVERLAY_MAX_FRACTION);
  const bottom = Math.min(pane.top + pane.height, b.bottom) - GAP_PX;
  return { side: 'overlay', rect: { left, top: Math.max(b.top, bottom - h), width, height: h } };
}
