import { describe, expect, it } from 'vitest';
import {
  beginMobileGesture,
  displayOriginAwayFromThumb,
  finishMobileGesture,
  RADIUS_HIGHLIGHT,
  RADIUS_LAYOUT,
  RADIUS_SELECT,
  updateMobileGesture,
  type MobileGestureAction,
  type MobileGesturePoint,
  type MobileGestureTrackingState,
} from './mobile-gesture-menu';

const ORIGIN: MobileGesturePoint = { x: 100, y: 100 };

function runGesture(points: MobileGesturePoint[]): MobileGestureAction | undefined {
  let state: MobileGestureTrackingState = beginMobileGesture(1, ORIGIN);
  for (const point of points) {
    state = updateMobileGesture(state, point);
  }
  return finishMobileGesture(state).action;
}

function point(x: number, y: number): MobileGesturePoint {
  return { x: ORIGIN.x + x, y: ORIGIN.y + y };
}

describe('mobile gesture menu state machine', () => {
  it('derives highlight and select radii from the layout radius', () => {
    expect(RADIUS_LAYOUT).toBe(92);
    expect(RADIUS_SELECT).toBe(RADIUS_LAYOUT * 0.75);
    expect(RADIUS_HIGHLIGHT).toBe(RADIUS_SELECT * 0.5);
  });

  it('cancels a tap that never breaks out', () => {
    expect(runGesture([])).toBeUndefined();
  });

  it('does not highlight a direction before the highlight radius', () => {
    const state = updateMobileGesture(beginMobileGesture(1, ORIGIN), point(RADIUS_HIGHLIGHT - 1, 0));
    expect(state.phase).toBe('root');
    if (state.phase !== 'root') return;
    expect(state.highlightedDirection).toBeUndefined();
    expect(state.primaryDirection).toBeUndefined();
  });

  it('highlights the closest direction after the highlight radius without selecting it', () => {
    const state = updateMobileGesture(beginMobileGesture(1, ORIGIN), point(RADIUS_HIGHLIGHT + 1, 0));
    expect(state.phase).toBe('root');
    if (state.phase !== 'root') return;
    expect(state.highlightedDirection).toBe('e');
    expect(state.primaryDirection).toBeUndefined();
    expect(finishMobileGesture(state).action).toBeUndefined();
  });

  it('selects the closest direction after the select radius', () => {
    const state = updateMobileGesture(beginMobileGesture(1, ORIGIN), point(RADIUS_SELECT + 1, 0));
    expect(state.phase).toBe('root');
    if (state.phase !== 'root') return;
    expect(state.highlightedDirection).toBe('e');
    expect(state.primaryDirection).toBe('e');
  });

  it('selects Right by breaking east and returning to center', () => {
    expect(runGesture([point(70, 0), point(0, 0)])).toEqual({ kind: 'input', input: 'right' });
  });

  it('selects End by breaking east and turning up', () => {
    expect(runGesture([point(70, 0), point(0, -70)])).toEqual({ kind: 'input', input: 'end' });
  });

  it('selects l by breaking east and turning down', () => {
    expect(runGesture([point(70, 0), point(0, 70)])).toEqual({ kind: 'text', text: 'l' });
  });

  it('cancels when released in the original breakout direction', () => {
    expect(runGesture([point(70, 0)])).toBeUndefined();
  });

  it('opens Ctrl+C confirmation from the northwest group', () => {
    expect(runGesture([point(-70, -70), point(-70, 0)])).toEqual({
      kind: 'confirm',
      confirmation: 'ctrlC',
      action: { kind: 'input', input: 'ctrlC' },
    });
  });

  it('opens paste confirmation from the northeast group', () => {
    expect(runGesture([point(70, -70), point(0, -70)])).toEqual({
      kind: 'confirm',
      confirmation: 'paste',
      action: { kind: 'paste' },
    });
  });

  it('uses a second breakout for quit as q', () => {
    expect(runGesture([point(-70, -70), point(0, -70), point(0, 0)])).toEqual({
      kind: 'text',
      text: 'q',
    });
  });

  it('uses a second breakout for quit as Ctrl+X', () => {
    expect(runGesture([point(-70, -70), point(0, -70), point(-70, 0)])).toEqual({
      kind: 'input',
      input: 'ctrlX',
    });
  });

  it('uses a second breakout for quit as :q enter', () => {
    expect(runGesture([point(-70, -70), point(0, -70), point(70, 0)])).toEqual({
      kind: 'text',
      text: ':q\r',
    });
  });

  it('selects Shift+Enter with the southeast counter-clockwise turn', () => {
    expect(runGesture([point(70, 70), point(70, 0)])).toEqual({
      kind: 'input',
      input: 'shiftEnter',
    });
  });

  it('places the display origin up and left from a lower-right thumb press', () => {
    expect(displayOriginAwayFromThumb({ x: 320, y: 300 }, { width: 390, height: 460 })).toEqual({
      x: 188,
      y: 168,
    });
  });

  it('places the display origin up and right from a lower-left thumb press', () => {
    expect(displayOriginAwayFromThumb({ x: 70, y: 300 }, { width: 390, height: 460 })).toEqual({
      x: 202,
      y: 168,
    });
  });
});
