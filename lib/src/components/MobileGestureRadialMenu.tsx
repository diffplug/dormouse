import type { CSSProperties } from 'react';
import { clsx } from 'clsx';
import {
  MOBILE_GESTURE_DIRECTION_VECTORS,
  MOBILE_GESTURE_GROUP_ORDER,
  MOBILE_GESTURE_GROUPS,
  MOBILE_GESTURE_QUIT_GROUP,
  RADIUS_LAYOUT,
  RADIUS_SELECT,
  type MobileGestureCandidate,
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

function translatedCurrentPoint(state: Exclude<MobileGestureTrackingState, { phase: 'idle' }>) {
  return {
    x: state.displayOrigin.x + state.currentPoint.x - state.origin.x,
    y: state.displayOrigin.y + state.currentPoint.y - state.origin.y,
  };
}

function OptionPill({
  labels,
  candidate,
  active,
}: {
  labels: [string, string, string];
  candidate?: MobileGestureCandidate;
  active: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex items-center overflow-hidden rounded border bg-surface-raised font-mono text-[10px] leading-none shadow-[0_8px_28px_rgba(0,0,0,0.35)]',
        active ? 'border-focus-ring text-foreground' : 'border-border text-muted',
      )}
    >
      {labels.map((label, index) => (
        <span
          key={`${label}-${index}`}
          className={clsx(
            'min-w-0 px-1.5 py-1',
            index > 0 && 'border-l border-border',
            candidate?.optionIndex === index
              ? 'bg-header-active-bg text-header-active-fg'
              : active && 'text-foreground',
          )}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export function MobileGestureRadialMenu({ state }: { state: MobileGestureTrackingState }) {
  if (state.phase === 'idle') return null;

  const translatedPoint = translatedCurrentPoint(state);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      <svg className="absolute inset-0 h-full w-full">
        <line
          x1={state.origin.x}
          y1={state.origin.y}
          x2={state.currentPoint.x}
          y2={state.currentPoint.y}
          stroke="var(--color-focus-ring)"
          strokeOpacity="0.9"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <line
          x1={state.displayOrigin.x}
          y1={state.displayOrigin.y}
          x2={translatedPoint.x}
          y2={translatedPoint.y}
          stroke="var(--color-focus-ring)"
          strokeOpacity="0.35"
          strokeWidth="2"
          strokeDasharray="4 4"
          strokeLinecap="round"
        />
        <circle
          cx={state.displayOrigin.x}
          cy={state.displayOrigin.y}
          r={RADIUS_SELECT}
          fill="none"
          stroke="var(--color-focus-ring)"
          strokeOpacity="0.28"
          strokeWidth="1.5"
        />
        <circle
          cx={state.origin.x}
          cy={state.origin.y}
          r="4"
          fill="var(--color-focus-ring)"
          fillOpacity="0.9"
        />
        <circle
          cx={state.currentPoint.x}
          cy={state.currentPoint.y}
          r="5"
          fill="var(--color-header-active-bg)"
          stroke="var(--color-focus-ring)"
          strokeWidth="1"
        />
        <circle
          cx={state.displayOrigin.x}
          cy={state.displayOrigin.y}
          r="7"
          fill="var(--color-header-active-bg)"
          stroke="var(--color-focus-ring)"
          strokeWidth="1"
        />
      </svg>

      {MOBILE_GESTURE_GROUP_ORDER.map((direction) => {
        if (state.phase === 'quit' && direction === state.baseDirection) return null;
        const group = MOBILE_GESTURE_GROUPS[direction];
        const point = directionPoint(direction, state.displayOrigin, RADIUS_LAYOUT);
        const candidate = state.phase === 'root' && state.candidate?.groupDirection === direction
          ? state.candidate
          : undefined;
        const active = state.phase === 'root'
          ? (state.primaryDirection ?? state.highlightedDirection) === direction
          : state.parentDirection === direction;
        return (
          <div key={direction} className="absolute" style={translatedStyle(point.x, point.y)}>
            <OptionPill
              labels={group.options.map((option) => option.label) as [string, string, string]}
              candidate={candidate}
              active={active}
            />
          </div>
        );
      })}

      <div
        className="absolute grid h-8 w-8 place-items-center rounded-full border border-border bg-surface-raised font-mono text-xs text-muted shadow-[0_8px_28px_rgba(0,0,0,0.35)]"
        style={translatedStyle(state.displayOrigin.x, state.displayOrigin.y)}
      >
        o
      </div>

      {state.phase === 'quit' ? (
        <div
          className="absolute"
          style={translatedStyle(
            directionPoint(state.baseDirection, state.displayOrigin, QUIT_RADIUS).x,
            directionPoint(state.baseDirection, state.displayOrigin, QUIT_RADIUS).y,
          )}
        >
          <div className="mb-1 text-center font-mono text-[10px] leading-none text-muted">Quit</div>
          <OptionPill
            labels={MOBILE_GESTURE_QUIT_GROUP.options.map((option) => option.label) as [string, string, string]}
            candidate={state.candidate}
            active
          />
        </div>
      ) : null}
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
