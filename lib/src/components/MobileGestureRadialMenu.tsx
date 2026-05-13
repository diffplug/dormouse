import type { CSSProperties } from 'react';
import { clsx } from 'clsx';
import {
  MOBILE_GESTURE_DIRECTION_VECTORS,
  MOBILE_GESTURE_GROUP_ORDER,
  MOBILE_GESTURE_GROUPS,
  MOBILE_GESTURE_OPTION_DIRECTIONS,
  MOBILE_GESTURE_QUIT_GROUP,
  RADIUS_LAYOUT,
  RADIUS_SELECT,
  type MobileGestureDirection,
  type MobileGestureOptionIndex,
  type MobileGesturePoint,
  type MobileGestureTrackingState,
} from '../lib/mobile-gesture-menu';

const QUIT_RADIUS = 78;
const GAP_CLUSTER = 2;
const ROOT_CHIP_HALF_HEIGHT = 9;
const ROOT_LABEL_CENTER_X = 18;
const ROOT_LABEL_LEFT_X = -96;
const ROOT_LABEL_RIGHT_X = 116;
const ROOT_LABEL_TOP_Y = -86;
const ROOT_LABEL_BOTTOM_Y = 86;
const ROOT_LABEL_SIDE_CENTER_Y = 22;
const COMPLETE_SCALE = 2.4;
const SELECT_TICK_INSET = 5;
const SELECT_TICK_OUTSET = 6;

const SQUARE_DIRECTION_VECTORS: Record<MobileGestureDirection, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
  nw: { x: -1, y: -1 },
};

const ROOT_GROUP_ANCHORS: Record<MobileGestureDirection, MobileGesturePoint> = {
  n: { x: ROOT_LABEL_CENTER_X, y: ROOT_LABEL_TOP_Y },
  ne: { x: ROOT_LABEL_RIGHT_X, y: ROOT_LABEL_TOP_Y },
  e: { x: ROOT_LABEL_RIGHT_X, y: ROOT_LABEL_SIDE_CENTER_Y },
  se: { x: ROOT_LABEL_RIGHT_X, y: ROOT_LABEL_BOTTOM_Y },
  s: { x: ROOT_LABEL_CENTER_X, y: ROOT_LABEL_BOTTOM_Y },
  sw: { x: ROOT_LABEL_LEFT_X, y: ROOT_LABEL_BOTTOM_Y },
  w: { x: ROOT_LABEL_LEFT_X, y: ROOT_LABEL_SIDE_CENTER_Y },
  nw: { x: ROOT_LABEL_LEFT_X, y: ROOT_LABEL_TOP_Y },
};

const ROOT_CENTER_HALF_WIDTHS: Record<MobileGestureDirection, number> = {
  n: 11,
  ne: 35,
  e: 11,
  se: 23,
  s: 11,
  sw: 17,
  w: 11,
  nw: 17,
};

type ChipPlacement = 'center' | 'left' | 'right' | 'above' | 'below';

const ROOT_OPTION_PLACEMENTS: Record<
  MobileGestureDirection,
  [ChipPlacement, ChipPlacement, ChipPlacement]
> = {
  n: ['center', 'left', 'right'],
  ne: ['center', 'below', 'left'],
  e: ['center', 'above', 'below'],
  se: ['center', 'above', 'left'],
  s: ['center', 'left', 'right'],
  sw: ['center', 'above', 'right'],
  w: ['center', 'above', 'below'],
  nw: ['center', 'right', 'below'],
};

const SELECT_TICK_DIRECTIONS: MobileGestureDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

function translateForPlacement(placement: ChipPlacement): string {
  switch (placement) {
    case 'left':
      return 'translate(-100%, -50%)';
    case 'right':
      return 'translate(0, -50%)';
    case 'above':
      return 'translate(-50%, -100%)';
    case 'below':
      return 'translate(-50%, 0)';
    case 'center':
      return 'translate(-50%, -50%)';
  }
}

function translatedStyle(x: number, y: number, scale = 1, placement: ChipPlacement = 'center'): CSSProperties {
  return {
    left: x,
    top: y,
    transform: `${translateForPlacement(placement)} scale(${scale})`,
  };
}

function directionPoint(
  direction: MobileGestureDirection,
  center: { x: number; y: number },
  radius: number,
): { x: number; y: number } {
  const vector = SQUARE_DIRECTION_VECTORS[direction];
  return {
    x: center.x + vector.x * radius,
    y: center.y + vector.y * radius,
  };
}

function translatedCurrentPoint(
  state: Exclude<MobileGestureTrackingState, { phase: 'idle' }>,
  origin: { x: number; y: number },
  displayOrigin: { x: number; y: number },
) {
  return {
    x: displayOrigin.x + state.currentPoint.x - origin.x,
    y: displayOrigin.y + state.currentPoint.y - origin.y,
  };
}

function OptionChip({
  label,
  active,
}: {
  label: string;
  active: boolean;
}) {
  return (
    <div
      className={clsx(
        'rounded px-2 py-1 font-mono text-[10px] leading-none transition-colors',
        active
          ? 'bg-header-active-bg text-header-active-fg shadow-[inset_0_0_0_1px_var(--color-focus-ring),0_8px_28px_rgba(0,0,0,0.35)]'
          : 'bg-header-inactive-bg text-header-inactive-fg shadow-[0_3px_12px_rgba(0,0,0,0.12)]',
      )}
    >
      {label}
    </div>
  );
}

function rootOptionLayout(
  direction: MobileGestureDirection,
  index: number,
  center: { x: number; y: number },
): { point: MobileGesturePoint; placement: ChipPlacement } {
  const optionIndex = index as MobileGestureOptionIndex;
  const anchor = ROOT_GROUP_ANCHORS[direction];
  const placement = ROOT_OPTION_PLACEMENTS[direction][optionIndex];
  const point = {
    x: center.x + anchor.x,
    y: center.y + anchor.y,
  };
  if (placement === 'left') point.x -= ROOT_CENTER_HALF_WIDTHS[direction] + GAP_CLUSTER;
  if (placement === 'right') point.x += ROOT_CENTER_HALF_WIDTHS[direction] + GAP_CLUSTER;
  if (placement === 'above') point.y -= ROOT_CHIP_HALF_HEIGHT + GAP_CLUSTER;
  if (placement === 'below') point.y += ROOT_CHIP_HALF_HEIGHT + GAP_CLUSTER;
  return { point, placement };
}

export function MobileGestureRadialMenu({ state }: { state: MobileGestureTrackingState }) {
  if (state.phase === 'idle') return null;

  const phaseOrigin = state.phase === 'root' ? state.origin : state.optionOrigin;
  const phaseDisplayOrigin = state.phase === 'root' ? state.displayOrigin : state.displayOptionOrigin;
  const translatedPoint = translatedCurrentPoint(state, phaseOrigin, phaseDisplayOrigin);
  const activeRootDirection = state.phase === 'root'
    ? state.highlightedDirection
    : state.phase === 'options'
      ? state.selectedDirection
      : state.phase === 'complete'
        ? state.selectedDirection
        : state.parentDirection;
  const activeTickDirection = (() => {
    if (state.phase === 'root') return state.highlightedDirection;
    if (state.phase === 'options') {
      return state.candidate?.direction
        ?? (
          state.highlightedOptionIndex === undefined
            ? undefined
            : MOBILE_GESTURE_OPTION_DIRECTIONS[state.selectedDirection][state.highlightedOptionIndex]
        );
    }
    if (state.phase === 'quit') {
      return state.candidate?.direction
        ?? (
          state.highlightedOptionIndex === undefined
            ? undefined
            : MOBILE_GESTURE_OPTION_DIRECTIONS[state.baseDirection][state.highlightedOptionIndex]
        );
    }
    return state.candidate.direction;
  })();
  const selectTicks = SELECT_TICK_DIRECTIONS.map((direction) => {
    const vector = MOBILE_GESTURE_DIRECTION_VECTORS[direction];
    const active = activeTickDirection === direction;
    return (
      <line
        key={direction}
        x1={phaseDisplayOrigin.x + vector.x * (RADIUS_SELECT - SELECT_TICK_INSET)}
        y1={phaseDisplayOrigin.y + vector.y * (RADIUS_SELECT - SELECT_TICK_INSET)}
        x2={phaseDisplayOrigin.x + vector.x * (RADIUS_SELECT + SELECT_TICK_OUTSET)}
        y2={phaseDisplayOrigin.y + vector.y * (RADIUS_SELECT + SELECT_TICK_OUTSET)}
        stroke="var(--color-focus-ring)"
        strokeOpacity={active ? '0.65' : '0.28'}
        strokeWidth={active ? '2' : '1.25'}
        strokeLinecap="round"
      />
    );
  });
  const rootOptions = MOBILE_GESTURE_GROUP_ORDER.flatMap((direction) => {
    const group = MOBILE_GESTURE_GROUPS[direction];
    return group.options.map((option, index) => {
      const optionIndex = index as MobileGestureOptionIndex;
      const isCompletingRootOption = state.phase === 'complete'
        && state.candidate.phase === 'options'
        && state.selectedDirection === direction
        && state.candidate.optionIndex === optionIndex;
      const isSelectedGroup = (
        state.phase === 'options'
        || (state.phase === 'complete' && state.candidate.phase === 'options')
      ) && state.selectedDirection === direction;
      const layout = isSelectedGroup
        ? {
            point: directionPoint(
              MOBILE_GESTURE_OPTION_DIRECTIONS[direction][optionIndex],
              phaseDisplayOrigin,
              RADIUS_LAYOUT,
            ),
            placement: 'center' as ChipPlacement,
          }
        : rootOptionLayout(direction, index, state.displayOrigin);
      const active = state.phase === 'root'
        ? activeRootDirection === direction
        : isCompletingRootOption || (isSelectedGroup && state.phase === 'options' && (
          state.highlightedOptionIndex === optionIndex
          || state.candidate?.optionIndex === optionIndex
        ));
      const faded = state.phase === 'quit'
        || (state.phase === 'options' && !isSelectedGroup)
        || state.phase === 'complete';
      return (
        <div
          key={`${direction}-${index}`}
          className={clsx(
            'absolute transition-[left,top,opacity,transform] ease-out',
            state.phase === 'complete' ? 'duration-200' : 'duration-150',
            faded ? 'opacity-0' : 'opacity-100',
          )}
          style={translatedStyle(
            layout.point.x,
            layout.point.y,
            isCompletingRootOption ? COMPLETE_SCALE : 1,
            layout.placement,
          )}
        >
          <OptionChip label={option.label} active={active} />
        </div>
      );
    });
  });
  const quitOptions = (() => {
    if (state.phase !== 'quit' && !(state.phase === 'complete' && state.candidate.phase === 'quit')) return null;
    const directions = MOBILE_GESTURE_OPTION_DIRECTIONS[
      state.phase === 'quit' ? state.baseDirection : state.candidate.groupDirection
    ];
    const highlightedOptionIndex = state.phase === 'quit' ? state.highlightedOptionIndex : undefined;
    const candidateOptionIndex = state.phase === 'quit' ? state.candidate?.optionIndex : state.candidate.optionIndex;

    return MOBILE_GESTURE_QUIT_GROUP.options.map((option, index) => {
      const optionIndex = index as MobileGestureOptionIndex;
      const direction = directions[optionIndex];
      const point = directionPoint(direction, phaseDisplayOrigin, QUIT_RADIUS);
      const isCompletingQuitOption = state.phase === 'complete'
        && state.candidate.phase === 'quit'
        && candidateOptionIndex === optionIndex;
      return (
        <div
          key={`${direction}-${option.label}`}
          className={clsx(
            'absolute transition-[left,top,opacity,transform] ease-out',
            state.phase === 'complete' ? 'duration-200' : 'duration-150',
            state.phase === 'complete' ? 'opacity-0' : 'opacity-100',
          )}
          style={translatedStyle(point.x, point.y, isCompletingQuitOption ? COMPLETE_SCALE : 1)}
        >
          <OptionChip
            label={option.label}
            active={highlightedOptionIndex === optionIndex || candidateOptionIndex === optionIndex}
          />
        </div>
      );
    });
  })();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      <svg className="absolute inset-0 h-full w-full">
        <line
          x1={phaseDisplayOrigin.x}
          y1={phaseDisplayOrigin.y}
          x2={translatedPoint.x}
          y2={translatedPoint.y}
          stroke="var(--color-focus-ring)"
          strokeOpacity="0.35"
          strokeWidth="2"
          strokeDasharray="4 4"
          strokeLinecap="round"
        />
        <circle
          cx={phaseDisplayOrigin.x}
          cy={phaseDisplayOrigin.y}
          r={RADIUS_SELECT}
          fill="none"
          stroke="var(--color-focus-ring)"
          strokeOpacity="0.22"
          strokeWidth="1.5"
        />
        {selectTicks}
      </svg>

      {rootOptions}
      {quitOptions}
    </div>
  );
}

export function MobileGestureConfirmDialog({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: 'ctrlC' | 'paste';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = confirmation === 'ctrlC'
    ? {
        title: 'Send ⌃C?',
        body: 'Interrupt the running terminal app.',
        action: 'Send ⌃C',
      }
    : {
        title: 'Paste?',
        body: 'Read the clipboard and paste into this pane.',
        action: 'Paste',
      };

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-app-bg/55 px-6">
      <div
        data-mobile-gesture-dialog
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        className="pointer-events-auto w-full max-w-64 rounded border border-border bg-surface-raised p-3 font-mono text-foreground shadow-[0_16px_48px_rgba(0,0,0,0.45)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold">{copy.title}</div>
        <div className="mt-1 text-xs leading-snug text-muted">{copy.body}</div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-2 py-1.5 text-muted transition-colors hover:bg-header-inactive-bg hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-header-active-bg px-2 py-1.5 text-header-active-fg transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring"
          >
            {copy.action}
          </button>
        </div>
      </div>
    </div>
  );
}
