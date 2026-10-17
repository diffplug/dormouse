import { describe, expect, it } from 'vitest';
import { TERMINAL_CONTEXT_TEETH_PX } from '../design';
import { cursorHalfSide, placeTerminalContext } from './terminal-context-placement';
const wall = { x: 0, y: 0, width: 1200, height: 800 };
describe('terminal context placement', () => {
  it('places beside either column, overlapping the source by the teeth', () => {
    expect(placeTerminalContext(wall, { x: 0, y: 0, width: 596, height: 800 }, true)).toMatchObject({ side: 'right', rect: { x: 586, y: 0, width: 596, height: 800 } });
    expect(placeTerminalContext(wall, { x: 604, y: 0, width: 596, height: 800 }, true)).toMatchObject({ side: 'left', rect: { x: 18, y: 0, width: 596, height: 800 } });
  });
  it('uses below/above in stacked layouts', () => {
    expect(placeTerminalContext(wall, { ...wall, height: 396 }, true)).toMatchObject({ side: 'bottom', rect: { x: 0, y: 386, width: 1200, height: 396 } });
    expect(placeTerminalContext(wall, { ...wall, y: 404, height: 396 }, true)).toMatchObject({ side: 'top', rect: { x: 0, y: 0, width: 1200, height: 414 } });
  });
  it('overlaps the source by exactly the teeth on every adjacent side', () => {
    const source = { x: 400, y: 260, width: 400, height: 280 };
    const right = placeTerminalContext(wall, source, true, 'right').rect;
    const left = placeTerminalContext(wall, source, true, 'left').rect;
    const bottom = placeTerminalContext(wall, source, true, 'bottom').rect;
    const top = placeTerminalContext(wall, source, true, 'top').rect;
    expect(right.x).toBe(source.x + source.width - TERMINAL_CONTEXT_TEETH_PX);
    expect(left.x + left.width).toBe(source.x + TERMINAL_CONTEXT_TEETH_PX);
    expect(bottom.y).toBe(source.y + source.height - TERMINAL_CONTEXT_TEETH_PX);
    expect(top.y + top.height).toBe(source.y + TERMINAL_CONTEXT_TEETH_PX);
    expect(top.y).toBe(wall.y);
  });
  it('grows above helpers upward over peer headers while grazing the source top', () => {
    expect(placeTerminalContext(wall, { x: 0, y: 500, width: 1200, height: 280 }, true).rect)
      .toEqual({ x: 0, y: 188, width: 1200, height: 322 });
  });
  it('breaks equal grid fits right-first and honors manual sides', () => {
    const source = { x: 0, y: 0, width: 596, height: 396 };
    expect(placeTerminalContext(wall, source, true).side).toBe('right');
    expect(placeTerminalContext(wall, source, true, 'bottom').side).toBe('bottom');
  });
  it('shrinks into an uneven neighbor and rejects unusable slivers', () => {
    expect(placeTerminalContext(wall, { ...wall, width: 800 }, true)).toMatchObject({ side: 'right', rect: { x: 790, width: 410 } });
    expect(placeTerminalContext(wall, { ...wall, width: 1000 }, true)).toMatchObject({ side: 'top', available: ['top', 'bottom'] });
  });
  it('covers each source half flush with its edges for single or zoomed panes', () => {
    expect(placeTerminalContext(wall, wall, false)).toMatchObject({ rect: { x: 0, y: 0, width: 1200, height: 400 }, available: ['top', 'bottom'] });
    expect(placeTerminalContext(wall, wall, false, 'bottom').rect).toEqual({ x: 0, y: 400, width: 1200, height: 400 });
  });
  it('covers a source half when no adjacent candidate fits', () => {
    const source = { x: 100, y: 80, width: 1000, height: 640 };
    expect(placeTerminalContext(wall, source, true).rect).toEqual({ x: 100, y: 80, width: 1000, height: 320 });
    expect(placeTerminalContext(wall, source, true, 'bottom').rect).toEqual({ x: 100, y: 400, width: 1000, height: 320 });
  });
  it('keeps even tiny fallback panels inside offset Wall bounds', () => {
    const tiny = { x: 40, y: 60, width: 250, height: 180 };
    expect(placeTerminalContext(tiny, tiny, false, 'bottom').rect).toEqual({ x: 40, y: 60, width: 250, height: 180 });
  });
  it('borrows Wall space for small sources', () => {
    const source = { x: 1100, y: 700, width: 100, height: 100 };
    expect(placeTerminalContext(wall, source, false, 'bottom').rect).toEqual({ x: 920, y: 560, width: 280, height: 240 });
  });
  it('keeps an existing side when still usable, then falls back when it is not', () => {
    expect(placeTerminalContext(wall, { x: 400, y: 0, width: 380, height: 800 }, true, 'left').side).toBe('left');
    expect(placeTerminalContext(wall, { x: 0, y: 0, width: 380, height: 800 }, true, 'left').side).toBe('right');
  });
});
it('samples the visible cursor, treating offscreen and unknown cursors as top', () => {
  expect(cursorHalfSide({ baseY: 100, cursorY: 2, viewportY: 100 }, 24)).toBe('bottom');
  expect(cursorHalfSide({ baseY: 100, cursorY: 12, viewportY: 100 }, 24)).toBe('top');
  expect(cursorHalfSide({ baseY: 100, cursorY: 2, viewportY: 0 }, 24)).toBe('top');
  expect(cursorHalfSide({ baseY: 0, cursorY: 2, viewportY: 10 }, 24)).toBe('top');
  expect(cursorHalfSide(undefined, 24)).toBe('top');
});
