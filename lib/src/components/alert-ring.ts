import { useMemo, type CSSProperties } from 'react';
import { cfg } from '../cfg';
import type { AlertEpisode } from '../lib/alert-episode';
import type { AlertRingState, AlertSpeechState, SessionStatus } from '../lib/terminal-registry';

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

export interface AlertRingBurstProps {
  /** A fresh episode is a fresh summons, so remounting on it replays the burst;
   *  a second track latching inside one keeps the key and only enriches. */
  key: string;
  className: string;
  style?: CSSProperties;
}

/** Everything one alarm element needs to move for `row`, bundled so the class,
 *  the remount key, and the clock can never be applied apart. */
export function alertRingBurstProps(row: AlertRingState, episode: AlertEpisode): AlertRingBurstProps {
  const bounded = row === 'ringing';
  const className = row === 'spoken' ? '' : alarmPulseClass(bounded);
  return {
    key: episode.id,
    className,
    // Only a burst has a clock to anchor, and only one the freeze left running.
    style: bounded && className ? animationClockStyle(episode.startedAt) : undefined,
  };
}

/** `alertRingBurstProps` anchored once per episode: recomputing the clock on a
 *  later render would shove a live burst back to its start. */
export function useAlertRingBurst(
  row: AlertRingState | null,
  episode: AlertEpisode | null | undefined,
): AlertRingBurstProps | null {
  const id = episode?.id;
  const startedAt = episode?.startedAt;
  return useMemo(
    () => (row && id !== undefined && startedAt !== undefined
      ? alertRingBurstProps(row, { id, startedAt })
      : null),
    [row, id, startedAt],
  );
}
