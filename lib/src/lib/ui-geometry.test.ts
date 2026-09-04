/**
 * @vitest-environment jsdom
 *
 * The two pure helpers in `ui-geometry.ts`. `pointInConvexPolygon` decides
 * whether the TodoAlertDialog's hot area still holds the cursor (a false
 * negative closes the dialog out from under a mouse still travelling toward
 * it), and `clampOverlayPosition` is what keeps a measured popover on screen —
 * both are geometry with edge cases the callers cannot show.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clampOverlayPosition, OVERLAY_VIEWPORT_MARGIN_PX, pointInConvexPolygon } from './ui-geometry';

const SQUARE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe('pointInConvexPolygon', () => {
  it('accepts an interior point and rejects an exterior one', () => {
    expect(pointInConvexPolygon(5, 5, SQUARE)).toBe(true);
    expect(pointInConvexPolygon(-1, 5, SQUARE)).toBe(false);
    expect(pointInConvexPolygon(5, 11, SQUARE)).toBe(false);
  });

  it('reads the same in either winding order', () => {
    const reversed = [...SQUARE].reverse();
    expect(pointInConvexPolygon(5, 5, reversed)).toBe(true);
    expect(pointInConvexPolygon(-1, 5, reversed)).toBe(false);
  });

  it('counts a point on an edge or at a vertex as inside', () => {
    // A zero cross product is skipped rather than latching a sign, so the
    // boundary belongs to the polygon — the hot area must not close on a
    // cursor sitting exactly on its own border.
    expect(pointInConvexPolygon(0, 5, SQUARE)).toBe(true);
    expect(pointInConvexPolygon(0, 0, SQUARE)).toBe(true);
  });

  it('holds a cursor inside the dialog funnel trapezoid', () => {
    // The shape TodoAlertDialog builds: the trigger button's top edge widening
    // to the dialog's top edge below it.
    const funnel = [
      { x: 100, y: 0 },
      { x: 110, y: 0 },
      { x: 300, y: 40 },
      { x: 12, y: 40 },
    ];
    expect(pointInConvexPolygon(105, 20, funnel)).toBe(true);
    expect(pointInConvexPolygon(20, 20, funnel)).toBe(false);
    expect(pointInConvexPolygon(105, 41, funnel)).toBe(false);
  });

  it('is convex-only: a concave polygon reports false inside its notch', () => {
    // Pins the documented limitation. An L shape, with the point inside the
    // short arm: a same-side test cannot represent the reflex vertex, so this
    // must stay a caller's obligation rather than becoming a silent wrong
    // answer someone relies on.
    const ell = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInConvexPolygon(2, 8, ell)).toBe(false);
  });
});

describe('clampOverlayPosition', () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  function setViewport(width: number, height: number): void {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  }

  afterEach(() => setViewport(originalWidth, originalHeight));

  it('leaves a position that already fits', () => {
    setViewport(1000, 800);
    expect(clampOverlayPosition({ left: 100, top: 200, width: 300, height: 150 }))
      .toEqual({ position: 'fixed', left: 100, top: 200 });
  });

  it('pulls an overflowing overlay back inside the margin', () => {
    setViewport(1000, 800);
    const m = OVERLAY_VIEWPORT_MARGIN_PX;
    expect(clampOverlayPosition({ left: 900, top: 780, width: 300, height: 150 }))
      .toEqual({ position: 'fixed', left: 1000 - 300 - m, top: 800 - 150 - m });
  });

  it('pushes a position above the margin back down to it', () => {
    setViewport(1000, 800);
    expect(clampOverlayPosition({ left: -50, top: 0, width: 300, height: 150 }))
      .toEqual({ position: 'fixed', left: OVERLAY_VIEWPORT_MARGIN_PX, top: OVERLAY_VIEWPORT_MARGIN_PX });
  });

  it('pins an overlay larger than the viewport to the top-left margin', () => {
    // `maxLeft`/`maxTop` floor at the margin, so an oversized overlay stays
    // anchored where its content starts rather than being pushed off-screen
    // by a negative bound.
    setViewport(200, 200);
    expect(clampOverlayPosition({ left: 100, top: 100, width: 400, height: 400 }))
      .toEqual({ position: 'fixed', left: OVERLAY_VIEWPORT_MARGIN_PX, top: OVERLAY_VIEWPORT_MARGIN_PX });
  });
});
