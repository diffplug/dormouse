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
  type MobileGestureTrackingState,
} from '../lib/mobile-gesture-menu';

const QUIT_RADIUS = 78;

function translatedStyle(x: number, y: number): CSSProperties {
  return {
    left: x,
    top: y,
    transform: 'translate(-50%, -50%)',
  };
}

function directionPoint(
  direction: MobileGestureDirection,
  center: { x: number; y: number },
  radius: number,
): { x: number; y: number } {
  const vector = MOBILE_GESTURE_DIRECTION_VECTORS[direction];
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

function OptionPill({
  labels,
  active,
}: {
  labels: [string, string, string];
  active: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex items-center overflow-hidden rounded font-mono text-[10px] leading-none transition-colors',
        active
          ? 'bg-header-active-bg text-header-active-fg shadow-[inset_0_0_0_1px_var(--color-focus-ring),0_8px_28px_rgba(0,0,0,0.35)]'
          : 'bg-header-inactive-bg text-header-inactive-fg shadow-[0_8px_28px_rgba(0,0,0,0.35)]',
      )}
    >
      {labels.map((label, index) => (
        <span
          key={`${label}-${index}`}
          className="min-w-0 px-1.5 py-1"
        >
          {label}
        </span>
      ))}
    </div>
  );
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
          : 'bg-header-inactive-bg text-header-inactive-fg shadow-[0_8px_28px_rgba(0,0,0,0.35)]',
      )}
    >
      {label}
    </div>
  );
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
      : state.parentDirection;
  const explodedOptions = (() => {
    if (state.phase === 'root') return null;
    const group = state.phase === 'options'
      ? MOBILE_GESTURE_GROUPS[state.selectedDirection]
      : MOBILE_GESTURE_QUIT_GROUP;
    const directions = state.phase === 'options'
      ? MOBILE_GESTURE_OPTION_DIRECTIONS[state.selectedDirection]
      : MOBILE_GESTURE_OPTION_DIRECTIONS[state.baseDirection];
    const radius = state.phase === 'quit' ? QUIT_RADIUS : RADIUS_LAYOUT;
    const highlightedOptionIndex = state.highlightedOptionIndex;
    const candidateOptionIndex = state.candidate?.optionIndex;

    return group.options.map((option, index) => {
      const direction = directions[index];
      const point = directionPoint(direction, phaseDisplayOrigin, radius);
      return (
        <div
          key={`${direction}-${option.label}`}
          className="absolute transition-[opacity,transform] duration-150"
          style={translatedStyle(point.x, point.y)}
        >
          <OptionChip
            label={option.label}
            active={highlightedOptionIndex === index || candidateOptionIndex === index}
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
          strokeOpacity="0.28"
          strokeWidth="1.5"
        />
      </svg>

      {MOBILE_GESTURE_GROUP_ORDER.map((direction) => {
        const group = MOBILE_GESTURE_GROUPS[direction];
        const point = directionPoint(direction, state.displayOrigin, RADIUS_LAYOUT);
        const active = activeRootDirection === direction;
        const faded = state.phase !== 'root' && !active;
        return (
          <div
            key={direction}
            className={clsx(
              'absolute transition-opacity duration-150',
              faded ? 'opacity-0' : state.phase === 'root' ? 'opacity-100' : 'opacity-45',
            )}
            style={translatedStyle(point.x, point.y)}
          >
            <OptionPill
              labels={group.options.map((option) => option.label) as [string, string, string]}
              active={active}
            />
          </div>
        );
      })}

      {explodedOptions}
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
