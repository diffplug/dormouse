import { useCallback, useEffect, useRef, useState } from 'react';
import { modalActionButton } from './design';
import { speakTestUtterance } from '../lib/alert-speech';
import { getPlatform } from '../lib/platform';
import { sendTestPush } from '../remote/host/host-status-store';

/**
 * "Try it now" controls for the two alarm sinks
 * (`docs/specs/alert.md` -> Alarm settings).
 *
 * Both answer the same question — will this actually reach me? — which is
 * otherwise unanswerable until an alarm fires at 3am. Each reports its own
 * outcome inline rather than relying on the effect being observable: a silent
 * webview and a working one look identical, and a push that reached nobody
 * looks exactly like one that did.
 *
 * The result line clears itself, so the dialog does not accumulate stale
 * verdicts from earlier presses.
 */

/** How long a result line stays before the button returns to its resting state. */
const RESULT_LINGER_MS = 6000;

function useTransientResult() {
  const [result, setResult] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((text: string, tone: 'ok' | 'bad') => {
    if (timer.current) clearTimeout(timer.current);
    setResult({ text, tone });
    timer.current = setTimeout(() => setResult(null), RESULT_LINGER_MS);
  }, []);

  // A dialog closed while a result is showing must not leave a timer holding a
  // setState on an unmounted tree.
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return [result, show] as const;
}

function ResultLine({ result }: { result: { text: string; tone: 'ok' | 'bad' } | null }) {
  if (!result) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-1 text-sm leading-relaxed ${result.tone === 'bad' ? 'text-error' : 'text-muted'}`}
    >
      {result.text}
    </div>
  );
}

/**
 * Speak a fixed phrase now. Synchronous and local — there is no server in this
 * path — so the only failure worth reporting is a webview with no speech
 * backend at all, which would otherwise be indistinguishable from a working one
 * with the volume down.
 */
export function SpeakTestButton() {
  const [result, show] = useTransientResult();

  return (
    <div>
      <button
        type="button"
        className={modalActionButton()}
        onClick={() => {
          if (speakTestUtterance()) show('Speaking now.', 'ok');
          else show('This app has no speech engine available.', 'bad');
        }}
      >
        Play test sound
      </button>
      <ResultLine result={result} />
    </div>
  );
}

/**
 * Send a real push through the real path — same Host, same ACL, same server —
 * so what it proves is what the alarm will do.
 *
 * Hidden entirely where no Host service exists, matching the Remote control
 * section: there is nothing to test and nothing the user could do about it.
 */
export function PushTestButton() {
  const [result, show] = useTransientResult();
  const [busy, setBusy] = useState(false);

  let hasService = false;
  try {
    hasService = !!getPlatform().remoteHost;
  } catch {
    hasService = false;
  }
  if (!hasService) return null;

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        className={modalActionButton()}
        onClick={() => {
          setBusy(true);
          void sendTestPush()
            .then((outcome) => {
              if (outcome.targeted === 0) {
                // Not a failure: the Host is fine, nothing has opted in yet.
                show('No paired phone has enabled alerts yet, so there was nowhere to send it.', 'bad');
              } else if (outcome.delivered === 0) {
                show(`No device accepted the push (${outcome.failed} failed).`, 'bad');
              } else if (outcome.failed > 0) {
                show(`Sent to ${outcome.delivered}; ${outcome.failed} failed.`, 'bad');
              } else {
                show(
                  `Sent to ${outcome.delivered} ${outcome.delivered === 1 ? 'device' : 'devices'}.`,
                  'ok',
                );
              }
            })
            .catch((error: unknown) => {
              show(error instanceof Error ? error.message : String(error), 'bad');
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Sending…' : 'Send test push'}
      </button>
      <ResultLine result={result} />
    </div>
  );
}
