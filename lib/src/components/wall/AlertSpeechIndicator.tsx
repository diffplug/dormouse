import { useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { SpeakerHighIcon } from '@phosphor-icons/react';
import {
  getAlertSpeechSnapshot,
  subscribeToAlertSpeech,
} from '../../lib/terminal-registry';
import { alertSpeakingAnimationClass } from '../bell-icon-class';
import {
  ALERT_SPEECH_TRACKING_CLASS,
  PANE_HEADER_HEIGHT_PX,
  TERMINAL_BOTTOM_RADIUS_CLASS,
  TERMINAL_TOP_RADIUS_CLASS,
} from '../design';

/**
 * Very loud, pointer-transparent delivery state over one terminal Pane.
 *
 * Two layers straddling `.lath-leaf-header` (`z-index: 20` in `index.css`): the
 * wash and label below it at `z-[19]`, the perimeter ring above at `z-[25]`.
 * Keeping the wash under the header is what stops it tinting the header band,
 * where `--color-alarm-vs-terminal` — picked against the terminal body — carries
 * no contrast guarantee, and what keeps it off the `z-20` pane-corner banners.
 * The ring still outlines the whole Pane. See `docs/specs/layout.md` →
 * Spoken-alarm overlay.
 */
export function AlertSpeechIndicator({ sessionId }: { sessionId: string }) {
  const speech = useSyncExternalStore(subscribeToAlertSpeech, getAlertSpeechSnapshot);
  const state = speech.get(sessionId);
  if (!state) return null;

  const speaking = state === 'speaking';
  // The header owns the leaf's top corners, the terminal body its bottom ones,
  // so an overlay spanning both wears each half's radius.
  const layer = clsx(
    'pointer-events-none absolute inset-0',
    TERMINAL_TOP_RADIUS_CLASS,
    TERMINAL_BOTTOM_RADIUS_CLASS,
    speaking && alertSpeakingAnimationClass(),
  );

  return (
    <>
      <div
        data-alert-speech-state={state}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`Terminal ${speaking ? 'is speaking' : 'has spoken'}`}
        // No wash for `spoken`: it persists until the ring is attended, which is
        // unbounded, and a tint degrading terminal-text contrast indefinitely is
        // the same mistake the Door's badge cluster avoids. The ring carries it.
        className={clsx(layer, 'z-[19]', speaking && 'bg-alarm-vs-terminal/20')}
      >
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
      </div>
      <div
        aria-hidden
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
