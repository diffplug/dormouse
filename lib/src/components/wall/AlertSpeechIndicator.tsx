import { useSyncExternalStore } from 'react';
import { SpeakerHighIcon } from '@phosphor-icons/react';
import {
  getAlertSpeechSnapshot,
  subscribeToAlertSpeech,
} from '../../lib/terminal-registry';
import {
  ALERT_SPEECH_TRACKING_CLASS,
  PANE_HEADER_HEIGHT_PX,
  TERMINAL_BOTTOM_RADIUS_CLASS,
  TERMINAL_TOP_RADIUS_CLASS,
  alertSpeakingAnimationClass,
} from '../design';

/** Gap between the header's bottom edge and the label chip. */
const CHIP_HEADER_GAP_PX = 4;

/**
 * Very loud, pointer-transparent delivery state over one terminal Pane.
 *
 * Rendered as two layers straddling the header's stacking context
 * (`.lath-leaf-header` is `position: relative; z-index: 20` in `index.css`,
 * which traps everything inside it — including the `z-[1000]` popover surface —
 * at z=20 among the leaf's children):
 *
 * - The **wash and label** sit *below* that at `z-[19]`, so a header popover
 *   (context menu, title candidates, TODO preview, rename warning) opens over
 *   them rather than being covered by the opaque chip and tinted by the wash.
 *   That also leaves the header band itself unwashed, where
 *   `--color-alarm-vs-terminal` — picked against the terminal body — carries no
 *   contrast guarantee. Still above the terminal content, and below the
 *   `z-20` pane-corner banners (resume offer, mouse override).
 * - The **perimeter ring** sits *above* at `z-[25]`, so the treatment still
 *   reads as one rounded rectangle around the whole Pane. An inset border at the
 *   leaf's edge neither covers nor tints popover content. Below the `z-30`
 *   sashes.
 *
 * Neither layer participates in focus or pointer routing.
 */
export function AlertSpeechIndicator({ sessionId }: { sessionId: string }) {
  const speech = useSyncExternalStore(subscribeToAlertSpeech, getAlertSpeechSnapshot);
  const state = speech.get(sessionId);
  if (!state) return null;

  const speaking = state === 'speaking';
  const label = speaking ? 'SPEAKING' : 'SPOKEN';
  const pulse = speaking ? alertSpeakingAnimationClass() : '';
  // The leaf's own rounding: the header owns the top corners, the body the
  // bottom, so an overlay spanning both wears each half's radius.
  const leafRadius = `${TERMINAL_TOP_RADIUS_CLASS} ${TERMINAL_BOTTOM_RADIUS_CLASS}`;

  return (
    <>
      <div
        data-alert-speech-state={state}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`Terminal ${speaking ? 'is speaking' : 'has spoken'}`}
        className={[
          'pointer-events-none absolute inset-0 z-[19]',
          leafRadius,
          speaking ? 'bg-alarm-vs-terminal/20' : 'bg-alarm-vs-terminal/10',
          pulse,
        ].join(' ')}
      >
        <div
          className={[
            'absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded',
            'bg-alarm-vs-terminal px-2.5 py-1 text-sm font-bold text-terminal-bg',
            ALERT_SPEECH_TRACKING_CLASS,
          ].join(' ')}
          style={{ top: PANE_HEADER_HEIGHT_PX + CHIP_HEADER_GAP_PX }}
        >
          <SpeakerHighIcon size={17} weight="fill" />
          <span>{label}</span>
        </div>
      </div>
      <div
        aria-hidden
        className={[
          'pointer-events-none absolute inset-0 z-[25]',
          leafRadius,
          speaking
            ? 'shadow-[inset_0_0_0_5px_var(--color-alarm-vs-terminal)]'
            : 'shadow-[inset_0_0_0_3px_var(--color-alarm-vs-terminal)]',
          pulse,
        ].join(' ')}
      />
    </>
  );
}
