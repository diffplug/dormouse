import { describe, expect, it } from 'vitest';
import { cursorHalfSide, placeTerminalContext } from './terminal-context-placement';
const wall = { x: 0, y: 0, width: 1200, height: 800 };
describe('terminal context placement', () => {
  it('places beside either column without covering the source', () => {
    expect(placeTerminalContext(wall, { x: 0, y: 0, width: 596, height: 800 }, true)).toMatchObject({ side: 'right', rect: { x: 604, y: 0, width: 596, height: 800 } });
    expect(placeTerminalContext(wall, { x: 604, y: 0, width: 596, height: 800 }, true)).toMatchObject({ side: 'left', rect: { x: 0, y: 0, width: 596, height: 800 } });
  });
  it('uses below/above in stacked layouts', () => {
    expect(placeTerminalContext(wall, { ...wall, height: 396 }, true).side).toBe('bottom');
    expect(placeTerminalContext(wall, { ...wall, y: 404, height: 396 }, true).side).toBe('top');
  });
  it('breaks equal grid fits right-first and honors manual sides', () => {
    const source = { x: 0, y: 0, width: 596, height: 396 };
    expect(placeTerminalContext(wall, source, true).side).toBe('right');
    expect(placeTerminalContext(wall, source, true, 'bottom').side).toBe('bottom');
  });
  it('shrinks into an uneven neighbor and rejects unusable slivers', () => {
    expect(placeTerminalContext(wall, { ...wall, width: 800 }, true)).toMatchObject({ mode: 'adjacent', rect: { width: 392 } });
    expect(placeTerminalContext(wall, { ...wall, width: 1000 }, true)).toMatchObject({ mode: 'half', side: 'top' });
  });
  it('uses source halves for single or zoomed panes', () => {
    expect(placeTerminalContext(wall, wall, false)).toMatchObject({ rect: { ...wall, height: 400 }, available: ['top', 'bottom'] });
    expect(placeTerminalContext(wall, wall, false, 'bottom').rect.y).toBe(400);
  });
  it('keeps even tiny fallback panels inside offset Wall bounds', () => {
    const tiny = { x: 40, y: 60, width: 250, height: 180 };
    expect(placeTerminalContext(tiny, tiny, false, 'bottom').rect).toEqual(tiny);
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
