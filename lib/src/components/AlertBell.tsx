import { useMemo } from 'react';
import { BellIcon } from '@phosphor-icons/react';
import { clsx } from 'clsx';
import type { SessionStatus } from '../lib/terminal-registry';
import { bellIconClass } from './bell-icon-class';
import { animationClockStyle } from './alert-ring';

/**
 * The status bell for one Session — the only place a `BellIcon` is drawn.
 *
 * Every ring must replay the finite ringing burst, and only a remount can start
 * one, because the className is identical across two rings
 * (`docs/specs/alert.md` -> Pane Header). Keying here rather than at each call
 * site is what keeps that from being a rule call sites have to remember.
 *
 * One element, not a branch per status: two `BellIcon`s in the same position
 * would remount on every crossing into `WATCHING_DISABLED` — i.e. every command
 * boundary — which is churn with no burst to show for it.
 */
export function AlertBell({ status, ringSeq, ringStartedAt, size, className }: {
  status: SessionStatus;
  /** `ActivityState.ringSeq` — read only for change, never magnitude. */
  ringSeq: number;
  /** Workspace cues retain their start across presentation changes; null is a cold snapshot. */
  ringStartedAt?: number | null;
  size: number;
  className?: string;
}) {
  const watching = status !== 'WATCHING_DISABLED';
  const animation = useMemo(() => ringStartedAt === undefined ? undefined
    : ringStartedAt === null ? { animation: 'none' }
    : animationClockStyle(ringStartedAt), [ringStartedAt]);
  return (
    <BellIcon
      key={ringSeq}
      style={animation}
      size={size}
      weight={watching ? 'fill' : 'regular'}
      className={watching ? clsx(bellIconClass(status), className) : className}
    />
  );
}
