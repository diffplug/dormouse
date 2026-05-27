import { describe, expect, it } from 'vitest';
import {
  beginMobileGesture,
  completeMobileGesture,
  displayOriginAwayFromThumb,
  finishMobileGesture,
  MOBILE_GESTURE_COMPLETE_MS,
  MOBILE_GESTURE_DIRECTION_VECTORS,
  MOBILE_GESTURE_OPTION_DIRECTIONS,
  RADIUS_HIGHLIGHT,
  RADIUS_LAYOUT,
  RADIUS_SELECT,
  updateMobileGesture,
  type MobileGestureAction,
  type MobileGestureDirection,
  type MobileGestureOptionIndex,
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

function pointInDirection(
  origin: MobileGesturePoint,
  direction: MobileGestureDirection,
  distance: number,
): MobileGesturePoint {
  const vector = MOBILE_GESTURE_DIRECTION_VECTORS[direction];
  return {
    x: origin.x + vector.x * distance,
    y: origin.y + vector.y * distance,
  };
}

function rootSelectionPoint(direction: MobileGestureDirection): MobileGesturePoint {
  return pointInDirection(ORIGIN, direction, RADIUS_SELECT + 1);
}

function optionOrigin(direction: MobileGestureDirection): MobileGesturePoint {
  return pointInDirection(ORIGIN, direction, RADIUS_SELECT);
}

function optionSelectionPoint(
  direction: MobileGestureDirection,
  optionIndex: MobileGestureOptionIndex,
): MobileGesturePoint {
  return pointInDirection(
    optionOrigin(direction),
    MOBILE_GESTURE_OPTION_DIRECTIONS[direction][optionIndex],
    RADIUS_SELECT + 1,
  );
}

function quitOrigin(
  direction: MobileGestureDirection,
  optionIndex: MobileGestureOptionIndex,
): MobileGesturePoint {
  return pointInDirection(
    optionOrigin(direction),
    MOBILE_GESTURE_OPTION_DIRECTIONS[direction][optionIndex],
    RADIUS_SELECT,
  );
}

function quitSelectionPoint(
  direction: MobileGestureDirection,
  quitMenuIndex: MobileGestureOptionIndex,
  optionIndex: MobileGestureOptionIndex,
): MobileGesturePoint {
  const quitDirection = MOBILE_GESTURE_OPTION_DIRECTIONS[direction][quitMenuIndex];
  return pointInDirection(
    quitOrigin(direction, quitMenuIndex),
    MOBILE_GESTURE_OPTION_DIRECTIONS[quitDirection][optionIndex],
    RADIUS_SELECT + 1,
  );
}

describe('mobile gesture menu state machine', () => {
  it('derives highlight and select radii from the layout radius', () => {
    expect(RADIUS_LAYOUT).toBe(92);
    expect(RADIUS_SELECT).toBe(RADIUS_LAYOUT * 0.75);
    expect(RADIUS_HIGHLIGHT).toBe(RADIUS_SELECT * 0.5);
    expect(MOBILE_GESTURE_COMPLETE_MS).toBe(220);
  });

  it('places exploded options opposite the selected direction', () => {
    expect(MOBILE_GESTURE_OPTION_DIRECTIONS.n).toEqual(['s', 'sw', 'se']);
    expect(MOBILE_GESTURE_OPTION_DIRECTIONS.e).toEqual(['w', 'nw', 'sw']);
    expect(MOBILE_GESTURE_OPTION_DIRECTIONS.s).toEqual(['n', 'nw', 'ne']);
    expect(MOBILE_GESTURE_OPTION_DIRECTIONS.w).toEqual(['e', 'ne', 'se']);
    expect(MOBILE_GESTURE_OPTION_DIRECTIONS.ne).toEqual(['sw', 'w', 's']);
    expect(MOBILE_GESTURE_OPTION_DIRECTIONS.nw).toEqual(['se', 'e', 's']);
  });

  it('cancels a tap that never breaks out', () => {
    expect(runGesture([])).toBeUndefined();
  });

  it('does not highlight a direction before the highlight radius', () => {
    const state = updateMobileGesture(beginMobileGesture(1, ORIGIN), point(RADIUS_HIGHLIGHT - 1, 0));
    expect(state.phase).toBe('root');
    if (state.phase !== 'root') return;
    expect(state.highlightedDirection).toBeUndefined();
  });

  it('highlights the closest direction after the highlight radius without selecting it', () => {
    const state = updateMobileGesture(beginMobileGesture(1, ORIGIN), point(RADIUS_HIGHLIGHT + 1, 0));
    expect(state.phase).toBe('root');
    if (state.phase !== 'root') return;
    expect(state.highlightedDirection).toBe('e');
    expect(finishMobileGesture(state).action).toBeUndefined();
  });

  it('opens the option phase for diagonals after the select radius', () => {
    const state = updateMobileGesture(beginMobileGesture(1, ORIGIN), rootSelectionPoint('se'));
    expect(state.phase).toBe('options');
    if (state.phase !== 'options') return;
    expect(state.selectedDirection).toBe('se');
    expect(state.optionOrigin).toEqual(optionOrigin('se'));
    expect(finishMobileGesture(state).action).toBeUndefined();
  });

  it('selects cardinal arrows directly at the root select radius', () => {
    expect(runGesture([rootSelectionPoint('n')])).toEqual({ kind: 'input', input: 'up' });
    expect(runGesture([rootSelectionPoint('e')])).toEqual({ kind: 'input', input: 'right' });
    expect(runGesture([rootSelectionPoint('s')])).toEqual({ kind: 'input', input: 'down' });
    expect(runGesture([rootSelectionPoint('w')])).toEqual({ kind: 'input', input: 'left' });
  });

  it('makes the direct cardinal action available as soon as the root select radius is crossed', () => {
    const state = updateMobileGesture(beginMobileGesture(1, ORIGIN), rootSelectionPoint('e'));
    expect(state.phase).toBe('root');
    if (state.phase !== 'root') return;
    expect(state.candidate?.option.action).toEqual({ kind: 'input', input: 'right' });
  });

  it('keeps a complete visual state after a direct cardinal action is chosen', () => {
    const state = updateMobileGesture(beginMobileGesture(1, ORIGIN), rootSelectionPoint('e'));
    const complete = completeMobileGesture(state);

    expect(complete?.phase).toBe('complete');
    if (!complete || complete.phase !== 'complete') return;
    expect(complete.selectedDirection).toBe('e');
    expect(complete.candidate.phase).toBe('root');
    expect(complete.candidate.optionIndex).toBe(0);
    expect(complete.candidate.option.action).toEqual({ kind: 'input', input: 'right' });
    expect(updateMobileGesture(complete, optionSelectionPoint('e', 2))).toBe(complete);
  });

  it('makes the option action available as soon as the second select radius is crossed', () => {
    let state = updateMobileGesture(beginMobileGesture(1, ORIGIN), rootSelectionPoint('se'));
    state = updateMobileGesture(state, optionSelectionPoint('se', 0));
    expect(state.phase).toBe('options');
    if (state.phase !== 'options') return;
    expect(state.candidate?.option.action).toEqual({ kind: 'input', input: 'enter' });
  });

  it('keeps a complete visual state after the second select radius is crossed', () => {
    let state = updateMobileGesture(beginMobileGesture(1, ORIGIN), rootSelectionPoint('se'));
    state = updateMobileGesture(state, optionSelectionPoint('se', 0));
    const complete = completeMobileGesture(state);

    expect(complete?.phase).toBe('complete');
    if (!complete || complete.phase !== 'complete') return;
    expect(complete.selectedDirection).toBe('se');
    expect(complete.candidate.phase).toBe('options');
    expect(complete.candidate.optionIndex).toBe(0);
    expect(complete.candidate.option.action).toEqual({ kind: 'input', input: 'enter' });
    expect(updateMobileGesture(complete, optionSelectionPoint('se', 2))).toBe(complete);
  });

  it('clears the option highlight when the drag moves back inside the highlight radius', () => {
    let state = updateMobileGesture(beginMobileGesture(1, ORIGIN), rootSelectionPoint('se'));
    state = updateMobileGesture(state, pointInDirection(optionOrigin('se'), 'n', RADIUS_HIGHLIGHT + 1));
    expect(state.phase).toBe('options');
    if (state.phase !== 'options') return;
    expect(state.highlightedOptionIndex).toBe(1);

    state = updateMobileGesture(state, optionOrigin('se'));
    expect(state.phase).toBe('options');
    if (state.phase !== 'options') return;
    expect(state.highlightedOptionIndex).toBeUndefined();
    expect(state.candidate).toBeUndefined();
  });

  it('cancels diagonal groups when released in the original breakout direction', () => {
    expect(runGesture([rootSelectionPoint('ne')])).toBeUndefined();
  });

  it('opens Ctrl+C confirmation from the northwest group', () => {
    expect(runGesture([rootSelectionPoint('nw'), optionSelectionPoint('nw', 1)])).toEqual({
      kind: 'confirm',
      confirmation: 'ctrlC',
      action: { kind: 'input', input: 'ctrlC' },
    });
  });

  it('opens paste confirmation from the northeast group', () => {
    expect(runGesture([rootSelectionPoint('ne'), optionSelectionPoint('ne', 1)])).toEqual({
      kind: 'confirm',
      confirmation: 'paste',
      action: { kind: 'paste' },
    });
  });

  it('uses a second breakout for quit as q', () => {
    expect(runGesture([rootSelectionPoint('nw'), optionSelectionPoint('nw', 2), quitSelectionPoint('nw', 2, 0)])).toEqual({
      kind: 'text',
      text: 'q',
    });
  });

  it('uses a second breakout for quit as Ctrl+X', () => {
    expect(runGesture([rootSelectionPoint('nw'), optionSelectionPoint('nw', 2), quitSelectionPoint('nw', 2, 1)])).toEqual({
      kind: 'input',
      input: 'ctrlX',
    });
  });

  it('uses a second breakout for quit as :q enter', () => {
    expect(runGesture([rootSelectionPoint('nw'), optionSelectionPoint('nw', 2), quitSelectionPoint('nw', 2, 2)])).toEqual({
      kind: 'text',
      text: ':q\r',
    });
  });

  it('selects Shift+Enter with the southeast counter-clockwise turn', () => {
    expect(runGesture([rootSelectionPoint('se'), optionSelectionPoint('se', 1)])).toEqual({
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
