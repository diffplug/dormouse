import { describe, expect, it } from 'vitest';
import {
  beginMobileGesture,
  finishMobileGesture,
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
  it('cancels a tap that never breaks out', () => {
    expect(runGesture([])).toBeUndefined();
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
});
