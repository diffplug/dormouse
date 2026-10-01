import { describe, expect, it, vi } from 'vitest';
import { GAP_PX, nearMiss, placeCopyEditor, selectionBand, TOUCH_SLOP_PX, type Band, type CopyEditorPlacementInput, type CopyEditorSide } from './copy-editor-placement';
import type { Span } from './copy-text';
import type { RingRect } from './rect-tween';
import type { TerminalOverlayDims } from './terminal-store';

// A 1200×800 window: usable bounds are inset 12px, so x 12..1188 and y 12..788.
const VIEWPORT = { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 };
/** A pane filling the window. */
const FULL = { left: 0, top: 0, width: 1200, height: 800 };
// A 600px pane with 300px either side; floor width 592, left edge 304.
const PANE = { left: 300, top: 100, width: 600, height: 600 };
// Room below 424, room above 284: a 200px editor fits either way.
const BAND = { top: 300, bottom: 360 };

// The segments, count, and Copy need 200px: the least a side takes.
const place = (o: Partial<CopyEditorPlacementInput> = {}) => placeCopyEditor({
  viewport: VIEWPORT, pane: PANE, band: BAND, naturalWidth: 400, chromeWidth: 0, essentialWidth: 200, naturalHeight: () => 200, touch: false, previous: null, ...o,
});

/** Three columns, the middle one selected nearly top to bottom. */
const COLUMN = { left: 400, top: 0, width: 400, height: 800 };
const TALL = { top: 20, bottom: 780 };

/** Whether `rect` covers any of the band's text, which spans the pane's columns. */
const covers = (rect: RingRect, band: Band, pane = PANE) =>
  rect.top < band.bottom && rect.top + rect.height > band.top && rect.left < pane.left + pane.width && rect.left + rect.width > pane.left;

describe('placeCopyEditor', () => {
  it.each<[string, Partial<CopyEditorPlacementInput>, CopyEditorSide, RingRect]>([
    ['below, hugging the last row', {}, 'below', { left: 304, top: 364, width: 592, height: 200 }],
    ['above when below is short', { band: { top: 300, bottom: 640 } }, 'above', { left: 304, top: 96, width: 592, height: 200 }],
    ['right on a tie of side room', { pane: COLUMN, band: TALL, naturalWidth: 300 }, 'right', { left: 804, top: 20, width: 384, height: 200 }],
    ['left when only it has room', { pane: { ...COLUMN, left: 700, width: 300 }, band: TALL, naturalWidth: 300 }, 'left', { left: 396, top: 20, width: 300, height: 200 }],
    ['the roomier side', { pane: { ...COLUMN, left: 700, width: 200 }, band: TALL, naturalWidth: 150 }, 'left', { left: 504, top: 20, width: 192, height: 200 }],
    ['a side as wide as its region', { pane: { ...COLUMN, left: 700, width: 300 }, band: TALL, naturalWidth: 1000 }, 'left', { left: 12, top: 20, width: 684, height: 200 }],
    ['a side top clamped into the window', { pane: COLUMN, band: { top: 700, bottom: 780 }, naturalWidth: 300, naturalHeight: () => 700 }, 'right', { left: 804, top: 88, width: 384, height: 700 }],
    ['squished below, the roomier side', { pane: FULL, band: { top: 300, bottom: 450 }, naturalHeight: () => 500 }, 'squish-below', { left: 12, top: 454, width: 1176, height: 334 }],
    ['squished above, the roomier side', { pane: FULL, band: { top: 350, bottom: 500 }, naturalHeight: () => 500 }, 'squish-above', { left: 12, top: 12, width: 1176, height: 334 }],
    ['the overlay, docked at the pane bottom', { pane: FULL, band: { top: 100, bottom: 700 }, naturalHeight: () => 400 }, 'overlay', { left: 12, top: 384, width: 1176, height: 400 }],
  ])('places %s', (_name, input, side, rect) => {
    expect(place(input)).toEqual({ side, rect });
  });

  it('prefers above on touch, then below, then a side', () => {
    expect(place({ touch: true }).side).toBe('above');
    expect(place({ touch: true, band: { top: 200, bottom: 360 } }).side).toBe('below');
    expect(place({ touch: true, pane: COLUMN, band: TALL, naturalWidth: 300 }).side).toBe('right');
  });

  it('measures a side only when neither natural spot fits, or while a side is held', () => {
    const naturalHeight = vi.fn(() => 200);
    // Below fits, and the right side has room for a 300px line.
    expect(place({ pane: COLUMN, naturalWidth: 300, naturalHeight }).side).toBe('below');
    expect(naturalHeight.mock.calls).toEqual([[392]]);
    naturalHeight.mockClear();
    // Held, both sides are measured, though below has room to spare and wins.
    expect(place({ pane: COLUMN, naturalWidth: 300, naturalHeight, previous: 'right' }).side).toBe('below');
    expect(naturalHeight.mock.calls).toEqual([[392], [384], [384]]);
  });

  it('rejects a side too narrow for the editor', () => {
    expect(place({ pane: { ...COLUMN, left: 100, width: 1000 }, band: TALL, naturalWidth: 300 }).side).toBe('overlay');
  });

  it('squishes into a side where wrapping makes the editor taller than the window', () => {
    const naturalHeight = (w: number) => (w >= 390 ? 200 : 900);
    expect(place({ pane: COLUMN, band: TALL, naturalWidth: 300, naturalHeight }))
      .toEqual({ side: 'squish-right', rect: { left: 804, top: 12, width: 384, height: 776 } });
  });

  it('caps the overlay at 60% of the window and keeps it inside', () => {
    expect(place({ pane: FULL, band: { top: 100, bottom: 700 }, naturalHeight: () => 1000 }).rect.height).toBeCloseTo(776 * 0.6, 6);
    const short = place({ viewport: { ...VIEWPORT, bottom: 200, height: 200 }, pane: { ...FULL, height: 100 }, band: { top: 0, bottom: 100 } });
    expect(short.side).toBe('overlay');
    expect(short.rect.top).toBe(12);
    expect(short.rect.height).toBeCloseTo(176 * 0.6, 6);
  });

  it('keeps a natural spot unless a higher one fits with room to spare', () => {
    // Below leaves 10px spare: not enough to leave above.
    const band = { top: 300, bottom: 574 };
    expect(place({ band }).side).toBe('below');
    expect(place({ band, previous: 'above' }).side).toBe('above');
    // 30px spare is enough.
    expect(place({ band: { top: 300, bottom: 554 }, previous: 'above' }).side).toBe('below');
    // Left and right share a rank: the held side stays while it fits.
    const pane = { ...COLUMN, left: 400, width: 300 };
    expect(place({ pane, band: TALL, naturalWidth: 200 }).side).toBe('right');
    expect(place({ pane, band: TALL, naturalWidth: 200, previous: 'left' }).side).toBe('left');
  });

  it('switches squish spots only when another is roomier by the hysteresis', () => {
    const squished = { pane: FULL, naturalHeight: () => 500 };
    // Below 334, above 314.
    expect(place({ ...squished, band: { top: 330, bottom: 450 } }).side).toBe('squish-below');
    expect(place({ ...squished, band: { top: 330, bottom: 450 }, previous: 'squish-above' }).side).toBe('squish-above');
    // Below 334, above 304.
    expect(place({ ...squished, band: { top: 320, bottom: 450 }, previous: 'squish-above' }).side).toBe('squish-below');
    // A held side that fell under the minimum yields to one that has it.
    expect(place({ ...squished, band: { top: 126, bottom: 659 }, previous: 'squish-above' }).side).toBe('squish-below');
    // A squished side and below, above too short: by area, with a lead of 24
    // rows at the held width.
    const beside = { pane: { left: 0, top: 0, width: 800, height: 800 }, naturalWidth: 1200, naturalHeight: () => 900 };
    // Right: 384 × 776 = 297,984. Below: 1176 × 254 = 298,704.
    expect(place({ ...beside, band: { top: 100, bottom: 530 } }).side).toBe('squish-below');
    expect(place({ ...beside, band: { top: 100, bottom: 530 }, previous: 'squish-right' }).side).toBe('squish-right');
    // Below: 1176 × 274 = 322,224, past the right's lead of 24 × 384.
    expect(place({ ...beside, band: { top: 100, bottom: 510 }, previous: 'squish-right' }).side).toBe('squish-below');
  });

  it('moves off a spot the band grows onto, never keeping one that covers it', () => {
    const first = place();
    expect(first.side).toBe('below');
    // The scope grows down over the editor's spot, leaving too little below.
    const grown = { top: 300, bottom: 640 };
    const next = place({ band: grown, previous: first.side });
    expect(next.side).toBe('above');
    expect(covers(first.rect, grown)).toBe(true);
    expect(covers(next.rect, grown)).toBe(false);
    // A spot that still fits follows the band rather than holding its old rect.
    expect(place({ band: { top: 300, bottom: 400 }, previous: 'below' }).rect.top).toBe(400 + GAP_PX);
    // Growing up over the spot above moves it below.
    const up = place({ touch: true });
    expect(up.side).toBe('above');
    expect(place({ touch: true, band: { top: up.rect.top, bottom: 360 }, previous: 'above' }).side).toBe('below');
  });

  it('yields the overlay as soon as anything else fits', () => {
    // Below fits with no spare at all.
    expect(place({ band: { top: 300, bottom: 584 }, previous: 'overlay' }).side).toBe('below');
    expect(place({ pane: FULL, band: { top: 300, bottom: 450 }, naturalHeight: () => 500, previous: 'overlay' }).side).toBe('squish-below');
  });

  it('floors the width at the pane, caps it at the natural width, and clamps it to the window', () => {
    expect(place({ naturalWidth: 100 }).rect).toMatchObject({ left: 304, width: 592 });
    expect(place({ naturalWidth: 800 }).rect).toMatchObject({ left: 304, width: 800 });
    expect(place({ naturalWidth: 2000 }).rect).toMatchObject({ left: 12, width: 1176 });
    // Too wide to start at the pane: shifted left to stay in the window.
    expect(place({ naturalWidth: 1000 }).rect).toMatchObject({ left: 188, width: 1000 });
  });

  it('widens past a narrow pane and its lines to show the chrome whole, still inside the window', () => {
    const narrow = { ...PANE, width: 150 };
    expect(place({ pane: narrow, naturalWidth: 120, chromeWidth: 460 }).rect).toMatchObject({ left: 304, width: 460 });
    // Lines wider than the chrome still set the width.
    expect(place({ pane: narrow, naturalWidth: 700, chromeWidth: 460 }).rect).toMatchObject({ left: 304, width: 700 });
    expect(place({ pane: narrow, naturalWidth: 120, chromeWidth: 2000 }).rect).toMatchObject({ left: 12, width: 1176 });
  });

  it('takes a side narrower than the chrome, never than its buttons', () => {
    // Either side of the column has 384px: the key hints and legend clip.
    expect(place({ pane: COLUMN, band: TALL, naturalWidth: 300, chromeWidth: 522 }).rect).toMatchObject({ left: 804, width: 384 });
    expect(place({ pane: COLUMN, band: TALL, naturalWidth: 300, chromeWidth: 522, essentialWidth: 390 }).side).toBe('overlay');
  });

  it('places inside an offset visual viewport', () => {
    // The keyboard is up and the page is scrolled: usable y 312..688, x 62..428.
    const viewport = { left: 50, top: 300, right: 440, bottom: 700, width: 390, height: 400 };
    const pane = { left: 50, top: 250, width: 390, height: 500 };
    // Above has 84px, too short; below has 244.
    expect(place({ viewport, pane, band: { top: 400, bottom: 440 }, naturalWidth: 200, naturalHeight: () => 150, touch: true }))
      .toEqual({ side: 'below', rect: { left: 62, top: 444, width: 366, height: 150 } });
  });
});

// Probed in a 1440×900 window (usable x 12..1428, y 12..888), with the key
// hints' 522px chrome and 300px of segments, count, and Copy; each went to
// below, or over the selection, before sides could squish or clip the chrome.
describe('placeCopyEditor: sides in a wide window', () => {
  const WIDE = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
  const wide = (o: Partial<CopyEditorPlacementInput>) => placeCopyEditor({
    viewport: WIDE, pane: { left: 0, top: 0, width: 720, height: 900 }, band: { top: 300, bottom: 600 }, naturalWidth: 700,
    chromeWidth: 522, essentialWidth: 300, naturalHeight: () => 970, touch: false, previous: null, ...o,
  });

  it('squishes a 50-line preview beside the left of two columns, not 284px below', () => {
    expect(wide({})).toEqual({ side: 'squish-right', rect: { left: 724, top: 12, width: 704, height: 876 } });
  });

  it('takes a 464px side of the middle of three columns, narrower than the chrome', () => {
    expect(wide({ pane: { left: 480, top: 0, width: 480, height: 900 }, naturalHeight: () => 400 }))
      .toEqual({ side: 'right', rect: { left: 964, top: 300, width: 464, height: 400 } });
  });

  it('squishes into the 424px beside a 1000px pane rather than covering its tall selection', () => {
    const naturalHeight = (w: number) => (w >= 990 ? 500 : 1100);
    expect(wide({ pane: { left: 0, top: 0, width: 1000, height: 900 }, band: { top: 20, bottom: 880 }, naturalWidth: 990, naturalHeight }))
      .toEqual({ side: 'squish-right', rect: { left: 1004, top: 12, width: 424, height: 876 } });
  });

  it('keeps the natural order: a side only when neither below nor above holds it', () => {
    expect(wide({ naturalHeight: () => 280 }).side).toBe('below');
    expect(wide({ naturalHeight: () => 280, touch: true }).side).toBe('above');
  });
});

describe('nearMiss', () => {
  const rect = { left: 100, top: 100, right: 300, bottom: 200 };

  it('is a press outside the rect within the slop, on any side or corner', () => {
    expect(nearMiss(rect, 200, 200 + TOUCH_SLOP_PX)).toBe(true);
    expect(nearMiss(rect, 100 - TOUCH_SLOP_PX, 150)).toBe(true);
    expect(nearMiss(rect, 310, 90)).toBe(true);
  });

  it('is never a press inside, or past the slop', () => {
    expect(nearMiss(rect, 200, 150)).toBe(false);
    expect(nearMiss(rect, 300, 200)).toBe(false);
    expect(nearMiss(rect, 200, 201 + TOUCH_SLOP_PX)).toBe(false);
  });
});

describe('selectionBand', () => {
  // A 24-row grid scrolled to line 100, its first row at y 52.
  const dims: TerminalOverlayDims = {
    cols: 80, rows: 24, viewportY: 100, baseY: 100,
    elementLeft: 0, elementTop: 50, elementWidth: 800, elementHeight: 242,
    cellWidth: 10, cellHeight: 10, gridLeft: 0, gridTop: 2,
  };
  const span = (r0: number, r1: number): Span => ({ start: { row: r0, col: 0 }, end: { row: r1, col: 5 }, block: false });

  it('runs from the first row to below the last, in window y', () => {
    expect(selectionBand(dims, [span(105, 110)])).toEqual({ top: 102, bottom: 162 });
  });

  it('unions the selection with the current scope', () => {
    expect(selectionBand(dims, [span(105, 110), span(103, 108)])).toEqual({ top: 82, bottom: 162 });
    expect(selectionBand(dims, [span(105, 110), span(106, 115)])).toEqual({ top: 102, bottom: 212 });
  });

  it('clamps rows scrolled out of view to the grid', () => {
    expect(selectionBand(dims, [span(90, 104)])).toEqual({ top: 52, bottom: 102 });
    expect(selectionBand(dims, [span(120, 130)])).toEqual({ top: 252, bottom: 292 });
  });
});
