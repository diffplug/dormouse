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

export type MobileGestureConfirmation = 'ctrlC' | 'paste';

export type MobileGestureAction =
  | MobileGestureDirectAction
  | {
      kind: 'confirm';
      confirmation: MobileGestureConfirmation;
      action: MobileGestureConfirmableAction;
    };

export interface MobileGestureOption {
  label: string;
  action: MobileGestureAction;
}

export type MobileGestureOptionTriple = readonly [MobileGestureOption, MobileGestureOption, MobileGestureOption];
export type MobileGestureOptions = readonly [MobileGestureOption] | MobileGestureOptionTriple;

export interface MobileGestureGroup {
  direction: MobileGestureDirection;
  options: MobileGestureOptions;
}

export interface MobileGestureCandidate {
  phase: 'root' | 'options' | 'quit';
  groupDirection: MobileGestureDirection;
  direction: MobileGestureDirection;
  optionIndex: MobileGestureOptionIndex;
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
      highlightedDirection?: MobileGestureDirection;
      candidate?: MobileGestureCandidate;
    }
  | {
      phase: 'options';
      pointerId: number;
      origin: MobileGesturePoint;
      displayOrigin: MobileGesturePoint;
      currentPoint: MobileGesturePoint;
      selectedDirection: MobileGestureDirection;
      optionOrigin: MobileGesturePoint;
      displayOptionOrigin: MobileGesturePoint;
      // Latches true once the drag stops pushing further in the opening direction, so
      // the compass can expand and stay expanded until the final selection.
      expanded: boolean;
      highlightedOptionIndex?: MobileGestureOptionIndex;
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
      optionOrigin: MobileGesturePoint;
      displayOptionOrigin: MobileGesturePoint;
      expanded: boolean;
      highlightedOptionIndex?: MobileGestureOptionIndex;
      candidate?: MobileGestureCandidate;
    }
  | {
      phase: 'complete';
      pointerId: number;
      origin: MobileGesturePoint;
      displayOrigin: MobileGesturePoint;
      currentPoint: MobileGesturePoint;
      selectedDirection: MobileGestureDirection;
      optionOrigin: MobileGesturePoint;
      displayOptionOrigin: MobileGesturePoint;
      candidate: MobileGestureCandidate;
    };

export interface MobileGestureFinishResult {
  state: MobileGestureTrackingState;
  action?: MobileGestureAction;
}

interface MobileGestureOptionState {
  highlightedOptionIndex?: MobileGestureOptionIndex;
  candidate?: MobileGestureCandidate;
}

const DIAGONAL = Math.SQRT1_2;

export const MOBILE_GESTURE_IDLE_STATE: MobileGestureTrackingState = { phase: 'idle' };
export const RADIUS_LAYOUT = 92;
export const RADIUS_SELECT = RADIUS_LAYOUT * 0.75;
export const RADIUS_FADE_START = RADIUS_SELECT * 0.25;
export const RADIUS_HIGHLIGHT = RADIUS_SELECT * 0.5;
export const MOBILE_GESTURE_COMPLETE_MS = 220;
export const MOBILE_GESTURE_DISPLAY_MARGIN = 168;
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
const MOBILE_GESTURE_DIRECT_DIRECTIONS = new Set<MobileGestureDirection>(['n', 'e', 's', 'w']);

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
    ],
  },
  e: {
    direction: 'e',
    options: [
      { label: '▶', action: { kind: 'input', input: 'right' } },
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

export const MOBILE_GESTURE_OPTION_DIRECTIONS: Record<
  MobileGestureDirection,
  [MobileGestureDirection, MobileGestureDirection, MobileGestureDirection]
> = {
  n: ['s', 'sw', 'se'],
  ne: ['sw', 'w', 's'],
  e: ['w', 'nw', 'sw'],
  se: ['nw', 'n', 'w'],
  s: ['n', 'nw', 'ne'],
  sw: ['ne', 'n', 'e'],
  w: ['e', 'ne', 'se'],
  nw: ['se', 'e', 's'],
};

export const MOBILE_GESTURE_QUIT_GROUP: { direction: MobileGestureDirection; options: MobileGestureOptionTriple } = {
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
  if (dx === 0 && dy === 0) return null;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const index = ((Math.round(angle / 45) % 8) + 8) % 8;
  return ANGLE_DIRECTIONS[index];
}

function pointOnRadius(
  origin: MobileGesturePoint,
  point: MobileGesturePoint,
  radius: number,
): MobileGesturePoint {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return origin;
  const scale = radius / dist;
  return {
    x: origin.x + dx * scale,
    y: origin.y + dy * scale,
  };
}

export function translatedPoint(
  displayOrigin: MobileGesturePoint,
  origin: MobileGesturePoint,
  point: MobileGesturePoint,
): MobileGesturePoint {
  return {
    x: displayOrigin.x + point.x - origin.x,
    y: displayOrigin.y + point.y - origin.y,
  };
}

// As the user keeps dragging past a selection in the direction that opened the
// submenu, slide the reference origin out to track that overshoot. Otherwise the
// user would have to drag all the way back through the overshoot before a move in
// any other direction could register. Only advances outward (a ratchet), so as soon
// as the drag reverses the pulled-back distance counts toward the intended option.
function advanceOptionOrigin(
  selectionDirection: MobileGestureDirection,
  optionOrigin: MobileGesturePoint,
  displayOptionOrigin: MobileGesturePoint,
  point: MobileGesturePoint,
): { optionOrigin: MobileGesturePoint; displayOptionOrigin: MobileGesturePoint; advancing: boolean } {
  const direction = MOBILE_GESTURE_DIRECTION_VECTORS[selectionDirection];
  const overshoot = (point.x - optionOrigin.x) * direction.x + (point.y - optionOrigin.y) * direction.y;
  if (overshoot <= 0) return { optionOrigin, displayOptionOrigin, advancing: false };
  return {
    optionOrigin: {
      x: optionOrigin.x + direction.x * overshoot,
      y: optionOrigin.y + direction.y * overshoot,
    },
    displayOptionOrigin: {
      x: displayOptionOrigin.x + direction.x * overshoot,
      y: displayOptionOrigin.y + direction.y * overshoot,
    },
    advancing: true,
  };
}

function optionIndexForDirection(
  groupDirection: MobileGestureDirection,
  direction: MobileGestureDirection | null,
): MobileGestureOptionIndex | undefined {
  if (!direction) return undefined;
  const index = MOBILE_GESTURE_OPTION_DIRECTIONS[groupDirection].indexOf(direction);
  return index === -1 ? undefined : index as MobileGestureOptionIndex;
}

function candidateForOptions(
  phase: 'options' | 'quit',
  groupDirection: MobileGestureDirection,
  options: MobileGestureOptionTriple,
  origin: MobileGesturePoint,
  point: MobileGesturePoint,
): MobileGestureOptionState {
  const dist = distance(origin, point);
  const direction = dist >= RADIUS_HIGHLIGHT
    ? directionFromVector(point.x - origin.x, point.y - origin.y)
    : null;
  const highlightedOptionIndex = optionIndexForDirection(groupDirection, direction);
  if (highlightedOptionIndex === undefined) return {};
  const option = options[highlightedOptionIndex];
  const result: MobileGestureOptionState = { highlightedOptionIndex };
  if (dist >= RADIUS_SELECT && direction) {
    result.candidate = {
      phase,
      groupDirection,
      direction,
      optionIndex: highlightedOptionIndex,
      option,
    };
  }
  return result;
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
  if (state.phase === 'idle' || state.phase === 'complete') return state;

  if (state.phase === 'root') {
    const movementDistance = distance(state.origin, point);
    const closestDirection = movementDistance >= RADIUS_HIGHLIGHT
      ? directionFromVector(point.x - state.origin.x, point.y - state.origin.y) ?? undefined
      : undefined;
    if (movementDistance >= RADIUS_SELECT && closestDirection) {
      if (MOBILE_GESTURE_DIRECT_DIRECTIONS.has(closestDirection)) {
        const option = MOBILE_GESTURE_GROUPS[closestDirection].options[0];
        return {
          ...state,
          currentPoint: point,
          highlightedDirection: closestDirection,
          candidate: {
            phase: 'root',
            groupDirection: closestDirection,
            direction: closestDirection,
            optionIndex: 0,
            option,
          },
        };
      }
      const optionOrigin = pointOnRadius(state.origin, point, RADIUS_SELECT);
      return {
        phase: 'options',
        pointerId: state.pointerId,
        origin: state.origin,
        displayOrigin: state.displayOrigin,
        currentPoint: point,
        selectedDirection: closestDirection,
        optionOrigin,
        displayOptionOrigin: translatedPoint(state.displayOrigin, state.origin, optionOrigin),
        expanded: false,
      };
    }
    return {
      ...state,
      currentPoint: point,
      highlightedDirection: closestDirection,
      candidate: undefined,
    };
  }

  if (state.phase === 'options') {
    const group = MOBILE_GESTURE_GROUPS[state.selectedDirection];
    if (group.options.length !== 3) return state;
    const { optionOrigin, displayOptionOrigin, advancing } = advanceOptionOrigin(
      state.selectedDirection,
      state.optionOrigin,
      state.displayOptionOrigin,
      point,
    );
    const optionState = candidateForOptions(
      'options',
      state.selectedDirection,
      group.options,
      optionOrigin,
      point,
    );
    if (optionState.candidate?.option.action.kind === 'quitMenu') {
      const quitOrigin = pointOnRadius(optionOrigin, point, RADIUS_SELECT);
      return {
        phase: 'quit',
        pointerId: state.pointerId,
        origin: state.origin,
        displayOrigin: state.displayOrigin,
        currentPoint: point,
        parentDirection: state.selectedDirection,
        baseDirection: optionState.candidate.direction,
        optionOrigin: quitOrigin,
        displayOptionOrigin: translatedPoint(displayOptionOrigin, optionOrigin, quitOrigin),
        expanded: false,
      };
    }
    return {
      ...state,
      currentPoint: point,
      optionOrigin,
      displayOptionOrigin,
      expanded: state.expanded || !advancing,
      highlightedOptionIndex: optionState.highlightedOptionIndex,
      candidate: optionState.candidate,
    };
  }

  const { optionOrigin, displayOptionOrigin, advancing } = advanceOptionOrigin(
    state.baseDirection,
    state.optionOrigin,
    state.displayOptionOrigin,
    point,
  );
  const optionState = candidateForOptions(
    'quit',
    state.baseDirection,
    MOBILE_GESTURE_QUIT_GROUP.options,
    optionOrigin,
    point,
  );
  return {
    ...state,
    currentPoint: point,
    optionOrigin,
    displayOptionOrigin,
    expanded: state.expanded || !advancing,
    highlightedOptionIndex: optionState.highlightedOptionIndex,
    candidate: optionState.candidate,
  };
}

export function finishMobileGesture(state: MobileGestureTrackingState): MobileGestureFinishResult {
  const action = state.phase === 'root' || state.phase === 'options' || state.phase === 'quit'
    ? state.candidate?.option.action
    : undefined;
  return {
    state: MOBILE_GESTURE_IDLE_STATE,
    action,
  };
}

export function completeMobileGesture(state: MobileGestureTrackingState): MobileGestureTrackingState | undefined {
  if (state.phase !== 'root' && state.phase !== 'options' && state.phase !== 'quit') return undefined;
  if (!state.candidate) return undefined;
  return {
    phase: 'complete',
    pointerId: state.pointerId,
    origin: state.origin,
    displayOrigin: state.displayOrigin,
    currentPoint: state.currentPoint,
    selectedDirection: state.phase === 'root'
      ? state.candidate.groupDirection
      : state.phase === 'options'
        ? state.selectedDirection
        : state.parentDirection,
    optionOrigin: state.phase === 'root' ? state.origin : state.optionOrigin,
    displayOptionOrigin: state.phase === 'root' ? state.displayOrigin : state.displayOptionOrigin,
    candidate: state.candidate,
  };
}

export function mobileGestureStateFromPoints(
  points: MobileGesturePoint[],
  origin: MobileGesturePoint,
  displayOrigin: MobileGesturePoint = origin,
): MobileGestureTrackingState {
  let state = beginMobileGesture(1, origin, displayOrigin);
  for (const point of points) {
    state = updateMobileGesture(state, point);
  }
  return state;
}
