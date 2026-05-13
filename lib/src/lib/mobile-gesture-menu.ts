export type MobileGestureDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type MobileGestureOptionIndex = 0 | 1 | 2;
export type MobileGestureInputId =
  | 'ctrlC'
  | 'esc'
  | 'tab'
  | 'shiftTab'
  | 'space'
  | 'enter'
  | 'shiftEnter'
  | 'backspace'
  | 'up'
  | 'pageUp'
  | 'down'
  | 'pageDown'
  | 'right'
  | 'end'
  | 'left'
  | 'home'
  | 'ctrlX';

export interface MobileGesturePoint {
  x: number;
  y: number;
}

export interface MobileGestureBounds {
  width: number;
  height: number;
}

export type MobileGestureDirectAction =
  | { kind: 'input'; input: MobileGestureInputId }
  | { kind: 'text'; text: string }
  | { kind: 'paste' }
  | { kind: 'quitMenu' };

export type MobileGestureConfirmableAction = Extract<MobileGestureDirectAction, { kind: 'input' | 'paste' }>;

export type MobileGestureAction =
  | MobileGestureDirectAction
  | {
      kind: 'confirm';
      confirmation: 'ctrlC' | 'paste';
      action: MobileGestureConfirmableAction;
    };

export interface MobileGestureOption {
  label: string;
  action: MobileGestureAction;
}

export interface MobileGestureGroup {
  direction: MobileGestureDirection;
  options: [MobileGestureOption, MobileGestureOption, MobileGestureOption];
}

export interface MobileGestureCandidate {
  phase: 'root' | 'quit';
  groupDirection: MobileGestureDirection;
  optionIndex: MobileGestureOptionIndex;
  turn: 'center' | 'counterClockwise' | 'clockwise';
  option: MobileGestureOption;
}

export type MobileGestureTrackingState =
  | { phase: 'idle' }
  | {
      phase: 'root';
      pointerId: number;
      origin: MobileGesturePoint;
      displayOrigin: MobileGesturePoint;
      currentPoint: MobileGesturePoint;
      primaryDirection?: MobileGestureDirection;
      candidate?: MobileGestureCandidate;
    }
  | {
      phase: 'quit';
      pointerId: number;
      origin: MobileGesturePoint;
      displayOrigin: MobileGesturePoint;
      currentPoint: MobileGesturePoint;
      parentDirection: MobileGestureDirection;
      baseDirection: MobileGestureDirection;
      candidate?: MobileGestureCandidate;
    };

export interface MobileGestureFinishResult {
  state: MobileGestureTrackingState;
  action?: MobileGestureAction;
}

const DIAGONAL = Math.SQRT1_2;

export const MOBILE_GESTURE_IDLE_STATE: MobileGestureTrackingState = { phase: 'idle' };
export const MOBILE_GESTURE_BREAKOUT_RADIUS = 44;
export const MOBILE_GESTURE_RETURN_RADIUS = 26;
export const MOBILE_GESTURE_TURN_THRESHOLD = 0.55;
export const MOBILE_GESTURE_DISPLAY_MARGIN = 112;
export const MOBILE_GESTURE_THUMB_OFFSET = 132;

export const MOBILE_GESTURE_DIRECTION_VECTORS: Record<MobileGestureDirection, MobileGesturePoint> = {
  n: { x: 0, y: -1 },
  ne: { x: DIAGONAL, y: -DIAGONAL },
  e: { x: 1, y: 0 },
  se: { x: DIAGONAL, y: DIAGONAL },
  s: { x: 0, y: 1 },
  sw: { x: -DIAGONAL, y: DIAGONAL },
  w: { x: -1, y: 0 },
  nw: { x: -DIAGONAL, y: -DIAGONAL },
};

const ANGLE_DIRECTIONS: MobileGestureDirection[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];

export const MOBILE_GESTURE_GROUPS: Record<MobileGestureDirection, MobileGestureGroup> = {
  nw: {
    direction: 'nw',
    options: [
      { label: 'Esc', action: { kind: 'input', input: 'esc' } },
      {
        label: '⌃C',
        action: { kind: 'confirm', confirmation: 'ctrlC', action: { kind: 'input', input: 'ctrlC' } },
      },
      { label: 'Quit', action: { kind: 'quitMenu' } },
    ],
  },
  n: {
    direction: 'n',
    options: [
      { label: '▲', action: { kind: 'input', input: 'up' } },
      { label: 'PgUp', action: { kind: 'input', input: 'pageUp' } },
      { label: 'k', action: { kind: 'text', text: 'k' } },
    ],
  },
  ne: {
    direction: 'ne',
    options: [
      { label: 'Backspace', action: { kind: 'input', input: 'backspace' } },
      { label: 'Paste', action: { kind: 'confirm', confirmation: 'paste', action: { kind: 'paste' } } },
      { label: 'n', action: { kind: 'text', text: 'n' } },
    ],
  },
  w: {
    direction: 'w',
    options: [
      { label: '◀', action: { kind: 'input', input: 'left' } },
      { label: 'Home', action: { kind: 'input', input: 'home' } },
      { label: 'h', action: { kind: 'text', text: 'h' } },
    ],
  },
  e: {
    direction: 'e',
    options: [
      { label: '▶', action: { kind: 'input', input: 'right' } },
      { label: 'End', action: { kind: 'input', input: 'end' } },
      { label: 'l', action: { kind: 'text', text: 'l' } },
    ],
  },
  sw: {
    direction: 'sw',
    options: [
      { label: 'Tab', action: { kind: 'input', input: 'tab' } },
      { label: '⬆︎Tab', action: { kind: 'input', input: 'shiftTab' } },
      { label: 'Space', action: { kind: 'input', input: 'space' } },
    ],
  },
  s: {
    direction: 's',
    options: [
      { label: '▼', action: { kind: 'input', input: 'down' } },
      { label: 'PgDn', action: { kind: 'input', input: 'pageDown' } },
      { label: 'j', action: { kind: 'text', text: 'j' } },
    ],
  },
  se: {
    direction: 'se',
    options: [
      { label: 'Enter', action: { kind: 'input', input: 'enter' } },
      { label: '⬆︎Enter', action: { kind: 'input', input: 'shiftEnter' } },
      { label: 'y', action: { kind: 'text', text: 'y' } },
    ],
  },
};

export const MOBILE_GESTURE_GROUP_ORDER: MobileGestureDirection[] = [
  'nw',
  'n',
  'ne',
  'w',
  'e',
  'sw',
  's',
  'se',
];

export const MOBILE_GESTURE_QUIT_GROUP: MobileGestureGroup = {
  direction: 'n',
  options: [
    { label: 'q', action: { kind: 'text', text: 'q' } },
    { label: '⌃X', action: { kind: 'input', input: 'ctrlX' } },
    { label: ':q\u21b5', action: { kind: 'text', text: ':q\r' } },
  ],
};

function distance(a: MobileGesturePoint, b: MobileGesturePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function directionFromVector(dx: number, dy: number): MobileGestureDirection | null {
  if (Math.hypot(dx, dy) === 0) return null;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const index = ((Math.round(angle / 45) % 8) + 8) % 8;
  return ANGLE_DIRECTIONS[index];
}

function candidateForBase(
  phase: 'root' | 'quit',
  groupDirection: MobileGestureDirection,
  options: [MobileGestureOption, MobileGestureOption, MobileGestureOption],
  origin: MobileGesturePoint,
  point: MobileGesturePoint,
): MobileGestureCandidate | undefined {
  const dist = distance(origin, point);
  if (dist <= MOBILE_GESTURE_RETURN_RADIUS) {
    return {
      phase,
      groupDirection,
      optionIndex: 0,
      turn: 'center',
      option: options[0],
    };
  }

  const vector = MOBILE_GESTURE_DIRECTION_VECTORS[groupDirection];
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const normalizedCross = (vector.x * dy - vector.y * dx) / dist;
  if (normalizedCross <= -MOBILE_GESTURE_TURN_THRESHOLD) {
    return {
      phase,
      groupDirection,
      optionIndex: 1,
      turn: 'counterClockwise',
      option: options[1],
    };
  }
  if (normalizedCross >= MOBILE_GESTURE_TURN_THRESHOLD) {
    return {
      phase,
      groupDirection,
      optionIndex: 2,
      turn: 'clockwise',
      option: options[2],
    };
  }
  return undefined;
}

export function beginMobileGesture(
  pointerId: number,
  origin: MobileGesturePoint,
  displayOrigin: MobileGesturePoint = origin,
): MobileGestureTrackingState {
  return {
    phase: 'root',
    pointerId,
    origin,
    displayOrigin,
    currentPoint: origin,
  };
}

export function displayOriginAwayFromThumb(
  origin: MobileGesturePoint,
  bounds: MobileGestureBounds,
): MobileGesturePoint {
  const xDirection = origin.x < bounds.width / 2 ? 1 : -1;
  const yDirection = origin.y < bounds.height / 2 ? 1 : -1;
  return {
    x: bounds.width > MOBILE_GESTURE_DISPLAY_MARGIN * 2
      ? clamp(
        origin.x + xDirection * MOBILE_GESTURE_THUMB_OFFSET,
        MOBILE_GESTURE_DISPLAY_MARGIN,
        bounds.width - MOBILE_GESTURE_DISPLAY_MARGIN,
      )
      : bounds.width / 2,
    y: bounds.height > MOBILE_GESTURE_DISPLAY_MARGIN * 2
      ? clamp(
        origin.y + yDirection * MOBILE_GESTURE_THUMB_OFFSET,
        MOBILE_GESTURE_DISPLAY_MARGIN,
        bounds.height - MOBILE_GESTURE_DISPLAY_MARGIN,
      )
      : bounds.height / 2,
  };
}

export function updateMobileGesture(
  state: MobileGestureTrackingState,
  point: MobileGesturePoint,
): MobileGestureTrackingState {
  if (state.phase === 'idle') return state;

  if (state.phase === 'root') {
    const primaryDirection = state.primaryDirection
      ?? (
        distance(state.origin, point) >= MOBILE_GESTURE_BREAKOUT_RADIUS
          ? directionFromVector(point.x - state.origin.x, point.y - state.origin.y) ?? undefined
          : undefined
      );
    const candidate = primaryDirection
      ? candidateForBase('root', primaryDirection, MOBILE_GESTURE_GROUPS[primaryDirection].options, state.origin, point)
      : undefined;
    if (primaryDirection && candidate?.option.action.kind === 'quitMenu') {
      const baseDirection = directionFromVector(point.x - state.origin.x, point.y - state.origin.y) ?? primaryDirection;
      return {
        phase: 'quit',
        pointerId: state.pointerId,
        origin: state.origin,
        displayOrigin: state.displayOrigin,
        currentPoint: point,
        parentDirection: primaryDirection,
        baseDirection,
      };
    }
    return {
      ...state,
      currentPoint: point,
      primaryDirection,
      candidate,
    };
  }

  return {
    ...state,
    currentPoint: point,
    candidate: candidateForBase(
      'quit',
      state.baseDirection,
      MOBILE_GESTURE_QUIT_GROUP.options,
      state.origin,
      point,
    ),
  };
}

export function finishMobileGesture(state: MobileGestureTrackingState): MobileGestureFinishResult {
  const action = state.phase === 'idle' ? undefined : state.candidate?.option.action;
  return {
    state: MOBILE_GESTURE_IDLE_STATE,
    action,
  };
}

export function mobileGestureStateFromPoints(
  points: MobileGesturePoint[],
  origin: MobileGesturePoint = { x: 195, y: 220 },
  displayOrigin: MobileGesturePoint = origin,
): MobileGestureTrackingState {
  let state = beginMobileGesture(1, origin, displayOrigin);
  for (const point of points) {
    state = updateMobileGesture(state, point);
  }
  return state;
}
