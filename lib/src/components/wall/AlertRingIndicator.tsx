import { useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { SpeakerHighIcon } from '@phosphor-icons/react';
import {
  getActivitySnapshot,
  getAlertSpeechSnapshot,
  subscribeToActivity,
  subscribeToAlertSpeech,
} from '../../lib/terminal-registry';
import {
  ALERT_SPEECH_TRACKING_CLASS,
  alertRingBurstClass,
  alertRingBurstStyle,
  alertSpeakingAnimationClass,
  PANE_HEADER_HEIGHT_PX,
  TERMINAL_BOTTOM_RADIUS_CLASS,
  TERMINAL_TOP_RADIUS_CLASS,
} from '../design';

/** The row of the treatment one ringing Session wears. */
type AlertRingState = 'ringing' | 'speaking' | 'spoken';

const RING_LABEL: Record<AlertRingState, string> = {
  ringing: 'Terminal needs attention',
  speaking: 'Terminal is speaking',
  spoken: 'Terminal has spoken',
};

/**
 * Very loud, pointer-transparent alarm state over one terminal Pane.
 *
 * Two layers straddling `.lath-leaf-header` (`z-index: 20` in `index.css`): the
 * wash and label below it at `z-[19]`, the perimeter ring above at `z-[25]`.
 * Keeping the wash under the header is what stops it tinting the header band,
 * where `--color-alarm-vs-terminal` — picked against the terminal body — carries
 * no contrast guarantee, and what keeps it off the `z-20` mouse-override banner.
 * The ring still outlines the whole Pane. See `docs/specs/layout.md` →
 * Alarm overlay.
 */
export function AlertRingIndicator({ sessionId }: { sessionId: string }) {
  const activity = useSyncExternalStore(subscribeToActivity, getActivitySnapshot).get(sessionId);
  const speech = useSyncExternalStore(subscribeToAlertSpeech, getAlertSpeechSnapshot).get(sessionId);
  // The latched ring is the gate; speech only picks which row shows.
  if (activity?.status !== 'ALERT_RINGING') return null;

  const state: AlertRingState = speech ?? 'ringing';
  const speaking = state === 'speaking';
  const burst = state === 'ringing';
  const { episode } = activity;
  // A fresh episode is a fresh summons, so remounting here replays the burst; a
  // second track latching inside one keeps the key and only enriches the label.
  const episodeKey = episode?.id ?? 'no-episode';
  const burstStyle = burst ? alertRingBurstStyle(episode) : undefined;

  // The header owns the leaf's top corners, the terminal body its bottom ones,
  // so an overlay spanning both wears each half's radius.
  const layer = clsx(
    'pointer-events-none absolute inset-0',
    TERMINAL_TOP_RADIUS_CLASS,
    TERMINAL_BOTTOM_RADIUS_CLASS,
    speaking && alertSpeakingAnimationClass(),
    burst && alertRingBurstClass(),
  );

  return (
    <>
      <div
        key={`wash-${episodeKey}`}
        data-alert-ring-state={state}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={RING_LABEL[state]}
        style={burstStyle}
        // Stacking context and geometry only; the wash strengths live on the
        // child below — see `docs/specs/layout.md` -> Alarm overlay.
        className={clsx(layer, 'z-[19]')}
      >
        <div
          data-alert-ring-wash
          aria-hidden
          className={clsx(
            'absolute inset-0 bg-alarm-vs-terminal',
            TERMINAL_TOP_RADIUS_CLASS,
            TERMINAL_BOTTOM_RADIUS_CLASS,
            speaking ? 'opacity-20' : 'opacity-10',
          )}
        />
        {speech && (
          <div
            className={clsx(
              'absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded',
              'bg-alarm-vs-terminal px-2.5 py-1 text-sm font-bold text-terminal-bg',
              ALERT_SPEECH_TRACKING_CLASS,
            )}
            style={{ top: PANE_HEADER_HEIGHT_PX + 4 }}
          >
            <SpeakerHighIcon size={17} weight="fill" />
            <span>{speaking ? 'SPEAKING' : 'SPOKEN'}</span>
          </div>
        )}
      </div>
      <div
        key={`ring-${episodeKey}`}
        aria-hidden
        style={burstStyle}
        className={clsx(
          layer,
          'z-[25]',
          speaking
            ? 'shadow-[inset_0_0_0_5px_var(--color-alarm-vs-terminal)]'
            : 'shadow-[inset_0_0_0_3px_var(--color-alarm-vs-terminal)]',
        )}
      />
    </>
  );
}
