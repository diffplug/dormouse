import { Fragment, useCallback, useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { SpeakerHighIcon } from '@phosphor-icons/react';
import {
  getActivity,
  getAlertSpeechState,
  subscribeToActivity,
  subscribeToAlertSpeech,
} from '../../lib/terminal-registry';
import { ALERT_RING_LABEL, alertRingRow, useAlertRingBurst } from '../alert-ring';
import {
  ALERT_SPEECH_TRACKING_CLASS,
  PANE_HEADER_HEIGHT_PX,
  TERMINAL_BOTTOM_RADIUS_CLASS,
  TERMINAL_TOP_RADIUS_CLASS,
} from '../design';

/**
 * Very loud, pointer-transparent alarm state over one terminal Pane.
 *
 * Two layers straddling `.lath-leaf-header` (`z-index: 20` in `index.css`): the
 * wash and label below it at `z-[19]`, the perimeter ring above at `z-[25]`.
 * Keeping the wash under the header is what stops it tinting the header band,
 * where `--color-alarm-vs-terminal` — picked against the terminal body — carries
 * no contrast guarantee, and what keeps it off the `z-20` mouse-override banner.
 * The ring still outlines the whole Pane, and carries the motion alone so an
 * animating alarm composites one layer rather than two. See
 * `docs/specs/layout.md` → Alarm overlay.
 */
export function AlertRingIndicator({ sessionId }: { sessionId: string }) {
  // Per-Session selectors: both stores hand back a stable value per id, so a
  // ring on another Pane bails out here instead of re-rendering every overlay.
  const activity = useSyncExternalStore(
    subscribeToActivity,
    useCallback(() => getActivity(sessionId), [sessionId]),
  );
  const speech = useSyncExternalStore(
    subscribeToAlertSpeech,
    useCallback(() => getAlertSpeechState(sessionId), [sessionId]),
  );
  const row = alertRingRow(activity.status, speech);
  const burst = useAlertRingBurst(row, activity.episode);
  // `setTerminalActivity` opens an episode on every ringing transition, so a row
  // always arrives with one; the pair is what the treatment renders from.
  if (!row || !burst) return null;

  const speaking = row === 'speaking';
  // The header owns the leaf's top corners, the terminal body its bottom ones,
  // so an overlay spanning both wears each half's radius.
  const layer = clsx(
    'pointer-events-none absolute inset-0',
    TERMINAL_TOP_RADIUS_CLASS,
    TERMINAL_BOTTOM_RADIUS_CLASS,
  );

  return (
    <Fragment key={burst.key}>
      <div
        data-alert-ring-state={row}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={ALERT_RING_LABEL[row].pane}
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
        {row !== 'ringing' && (
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
        data-alert-ring-perimeter
        aria-hidden
        style={burst.style}
        className={clsx(
          layer,
          'z-[25]',
          burst.className,
          speaking
            ? 'shadow-[inset_0_0_0_5px_var(--color-alarm-vs-terminal)]'
            : 'shadow-[inset_0_0_0_3px_var(--color-alarm-vs-terminal)]',
        )}
      />
    </Fragment>
  );
}
