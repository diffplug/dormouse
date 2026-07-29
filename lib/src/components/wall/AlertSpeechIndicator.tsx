import { useSyncExternalStore } from 'react';
import { SpeakerHighIcon } from '@phosphor-icons/react';
import {
  getAlertSpeechSnapshot,
  subscribeToAlertSpeech,
} from '../../lib/terminal-registry';
import {
  ALERT_SPEAKING_ANIMATION_CLASS,
  ALERT_SPEECH_TRACKING_CLASS,
} from '../design';

/**
 * Very loud, pointer-transparent delivery state over one terminal Pane.
 *
 * The overlay spans the whole Lath leaf (header and body), but stays below
 * sashes and never participates in focus or pointer routing.
 */
export function AlertSpeechIndicator({ sessionId }: { sessionId: string }) {
  const speech = useSyncExternalStore(subscribeToAlertSpeech, getAlertSpeechSnapshot);
  const state = speech.get(sessionId);
  if (!state) return null;

  const speaking = state === 'speaking';
  const label = speaking ? 'SPEAKING' : 'SPOKEN';

  return (
    <div
      data-alert-speech-state={state}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`Terminal ${speaking ? 'is speaking' : 'has spoken'}`}
      className={[
        'pointer-events-none absolute inset-0 z-[25] rounded-lg',
        speaking
          ? `bg-alarm-vs-terminal/20 shadow-[inset_0_0_0_5px_var(--color-alarm-vs-terminal)] ${ALERT_SPEAKING_ANIMATION_CLASS}`
          : 'bg-alarm-vs-terminal/10 shadow-[inset_0_0_0_3px_var(--color-alarm-vs-terminal)]',
      ].join(' ')}
    >
      <div
        className={[
          'absolute left-1/2 top-[34px] flex -translate-x-1/2 items-center gap-1.5 rounded',
          'bg-alarm-vs-terminal px-2.5 py-1 text-sm font-bold text-terminal-bg',
          ALERT_SPEECH_TRACKING_CLASS,
        ].join(' ')}
      >
        <SpeakerHighIcon size={17} weight="fill" />
        <span>{label}</span>
      </div>
    </div>
  );
}
