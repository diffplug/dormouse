import { useMemo, type CSSProperties } from 'react';
import { clsx } from 'clsx';
import { cfg } from '../cfg';
import type { AlertEpisode } from '../lib/alert-episode';
import type { AlertRingState, AlertSpeechState, SessionStatus } from '../lib/terminal-registry';
import { ALERT_RING_INSET_BY_GROUND, ALERT_RING_INSET_CLASS, type AlertRingGround } from './design';

/**
 * Which row of the alarm treatment a Session wears, or `null` for none.
 *
 * The latched ring is the gate and the speech sink only picks the row, so every
 * alarm surface — the Pane overlay, the Door — derives it here rather than
 * pairing `status` with `speechState` on its own
 * (`docs/specs/alert.md` -> Pane Header).
 */
export function alertRingRow(
  status: SessionStatus | undefined,
  speechState: AlertSpeechState | null | undefined,
): AlertRingState | null {
  if (status !== 'ALERT_RINGING') return null;
  return speechState ?? 'ringing';
}

/** The accessible name each row carries: the Pane overlay's whole live-region
 *  label, and the phrase a Door appends to its own name. */
export const ALERT_RING_LABEL: Record<AlertRingState, { pane: string; door: string }> = {
  ringing: { pane: 'Terminal needs attention', door: 'needs attention' },
  speaking: { pane: 'Terminal is speaking', door: 'speaking' },
  spoken: { pane: 'Terminal has spoken', door: 'spoken' },
};

/**
 * The alarm's motion — one bounded arrival burst, or the pulse that runs for a
 * live utterance.
 *
 * `cfg.alert.ringingPaused` is the Chromatic freeze: an animation otherwise
 * snapshots at whatever phase the runner lands on, so every build diffs against
 * itself. `motion-safe:` alone covers reduced motion; a `motion-reduce:`
 * counterpart would be dead, since the animation is never emitted there to
 * override.
 */
export function alarmPulseClass(bounded: boolean): string {
  if (cfg.alert.ringingPaused) return '';
  return bounded ? 'motion-safe:animate-alarm-pulse-burst' : 'motion-safe:animate-alarm-pulse';
}

/** Starts a CSS animation on a clock that began at `startedAt`, so an element
 *  mounted later lands where that animation already is — past its end when it
 *  has already finished. */
export function animationClockStyle(startedAt: number): CSSProperties {
  return { animationDelay: `${-Math.max(0, Date.now() - startedAt)}ms` };
}

interface AlertRingBurstProps {
  /** A fresh episode is a fresh summons, so remounting on it replays the burst;
   *  a second source joining the ring inside one keeps the key and only enriches. */
  key: string;
  className: string;
  style?: CSSProperties;
}

/**
 * What one burst is anchored to: an identity that changes exactly when a new
 * summons begins, and the instant it began.
 *
 * A Session's `AlertEpisode` is one. A derived summons — a Workspace union's —
 * has no id of its own and supplies the instant alone, which serves as both.
 */
export type AlertRingBurstSource = AlertEpisode | { startedAt: number };

const burstKey = (source: AlertRingBurstSource): string =>
  'id' in source ? source.id : String(source.startedAt);

/** Everything one alarm element needs to move for `row`, bundled so the class,
 *  the remount key, and the clock can never be applied apart. */
function alertRingBurstProps(row: AlertRingState, source: AlertRingBurstSource): AlertRingBurstProps {
  const bounded = row === 'ringing';
  const className = row === 'spoken' ? '' : alarmPulseClass(bounded);
  return {
    key: burstKey(source),
    className,
    // Only a burst has a clock to anchor, and only one the freeze left running.
    style: bounded && className ? animationClockStyle(source.startedAt) : undefined,
  };
}

/** `alertRingBurstProps` anchored once per summons: recomputing the clock on a
 *  later render would shove a live burst back to its start. */
export function useAlertRingBurst(
  row: AlertRingState | null,
  source: AlertRingBurstSource | null | undefined,
): AlertRingBurstProps | null {
  const key = source == null ? undefined : burstKey(source);
  const startedAt = source?.startedAt;
  return useMemo(
    () => (row && key !== undefined && startedAt !== undefined
      ? alertRingBurstProps(row, { id: key, startedAt })
      : null),
    [row, key, startedAt],
  );
}

/**
 * The alarm's edge, as one overlay child of a `relative` box that clips.
 *
 * Every alarm surface draws the same 2px inset and differs only in `ground` —
 * the background its token was contrast-picked against — so the shadow literals
 * stay in one table and no call site restates them. `className` carries the
 * host's own geometry (its corner radius), because the overlay has to repeat it
 * or the parent's clip notches a square ring's corners away.
 */
export function AlertRingInset({ ground, burst, className }: {
  ground: AlertRingGround;
  /** `useAlertRingBurst`'s result; `null` leaves a static edge with no motion. */
  burst: AlertRingBurstProps | null;
  className?: string;
}) {
  return (
    <span
      key={burst?.key}
      data-alert-ring-inset={ground}
      aria-hidden
      style={burst?.style}
      className={clsx(ALERT_RING_INSET_CLASS, ALERT_RING_INSET_BY_GROUND[ground], burst?.className, className)}
    />
  );
}
