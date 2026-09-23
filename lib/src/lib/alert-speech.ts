import { isAlertDeliveryPaused, markAlertConsumed } from './alert-delivery-state';
import { getSessionAlertPolicy, subscribeToAlertDeliveryPolicy } from './alert-delivery-policy';
import { speechQueue } from './alert-speech-queue';
import { watchUnattendedRings } from './alert-ring-watch';
import {
  clearAlertSpeechState,
  clearAllAlertSpeechStates,
  getAlertSpeechSnapshot,
  setAlertSpeechState,
} from './alert-speech-state';
import { getActivity } from './session-activity-store';
import { deriveSessionLabel } from './session-label';
import { redactHighEntropyTokens } from './redact-high-entropy';

// Speech sink and sanitizer; alert-ring-watch owns ring timing/cancellation.
// Engine callbacks publish transient renderer-local delivery state.

/** Longest utterance we will produce. A pane title has no useful upper bound. */
const SPEECH_LIMIT = 120;

/** Sanitize a display label for speech. WebKit wedges on angle brackets; replace
 * punctuation, symbols, and controls with spaces so adjacent words do not join. */
export function toSpokenText(label: string): string {
  // Detect whole tokens before punctuation splitting or the speech length cap
  // can leave a secret's otherwise unrecognizable fragments in the utterance.
  const cleaned = redactHighEntropyTokens(label)
    // Elide apostrophes so contractions stay intact: spacing `didn't` would
    // leave a lone `t` for the engine to announce.
    .replace(/['’]/gu, '')
    // Unicode properties preserve letters, numbers, and combining marks from
    // every script while dropping characters a speech engine may announce.
    .replace(/[\p{P}\p{S}\p{C}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Capped in code points, matching `boundedPushText`: a cut mid-surrogate
  // would hand the engine a lone half.
  return Array.from(cleaned).slice(0, SPEECH_LIMIT).join('').trim() || 'terminal';
}

let testUtterances = 0;
/** Play the Settings test through the same queue as alarms, without Session state.
 *  Each press is its own job, so a second button's voice is heard after the first. */
export function speakTestUtterance(voice?: string | null): boolean {
  return speechQueue.enqueue({
    key: `settings-test-${++testUtterances}`, text: () => toSpokenText('Dormouse alarm test'),
    voice: () => voice ?? null, eligible: () => true,
  });
}

/** One coordinator per renderer; Workspace policy is resolved per originating Session. */
export function startAlertSpeech(): () => void {
  clearAllAlertSpeechStates();
  const renderedEpisodes = new Map<string, string>();
  const eligible = (id: string, episodeId: string): boolean =>
    !isAlertDeliveryPaused(id) && getActivity(id).episode?.id === episodeId && getSessionAlertPolicy(id).speakEnabled;
  const stopRingWatch = watchUnattendedRings({
    sink: 'speech',
    enabled: (id) => getSessionAlertPolicy(id).speakEnabled,
    delayMs: (id) => getSessionAlertPolicy(id).speakDelayMs,
    subscribe: subscribeToAlertDeliveryPolicy,
    fire: (id, episode) => {
      const queued = speechQueue.enqueue({
        key: episode.id,
        text: () => toSpokenText(deriveSessionLabel(id)),
        voice: () => getSessionAlertPolicy(id).speakVoice,
        eligible: () => eligible(id, episode.id),
        // Consumed at admission: no acknowledgement ties audible sound to ownership (rationale).
        onAdmit: () => markAlertConsumed('speech', id, episode.id),
        onStart: () => { renderedEpisodes.set(id, episode.id); setAlertSpeechState(id, 'speaking'); },
        onFinish: (started) => {
          if (!started) markAlertConsumed('speech', id, episode.id);
          if (started && eligible(id, episode.id)) { setAlertSpeechState(id, 'spoken'); return; }
          renderedEpisodes.delete(id);
          clearAlertSpeechState(id);
        },
      });
      if (!queued) markAlertConsumed('speech', id, episode.id);
    },
    // Same notifications as the scan: drop pending work the scan just resolved,
    // and un-render speech whose episode ended.
    afterScan: () => {
      speechQueue.refresh();
      for (const id of getAlertSpeechSnapshot().keys()) {
        if (getActivity(id).episode?.id !== renderedEpisodes.get(id)) {
          renderedEpisodes.delete(id);
          clearAlertSpeechState(id);
        }
      }
    },
  });
  return () => {
    stopRingWatch();
    speechQueue.clear();
    clearAllAlertSpeechStates();
  };
}
