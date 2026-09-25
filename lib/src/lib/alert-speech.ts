import { getSessionAlertPolicy, subscribeToAlertDeliveryPolicy } from './alert-delivery-policy';
import { speechQueue } from './alert-speech-queue';
import {
  clearAlertSpeechState,
  clearAllAlertSpeechStates,
  getAlertSpeechSnapshot,
  setAlertSpeechState,
} from './alert-speech-state';
import { getActivity, subscribeToActivity } from './session-activity-store';
import { deriveSessionLabel } from './session-label';
import { redactHighEntropyTokens } from './redact-high-entropy';

// The speech sink and its sanitizer. The host decides when to speak
// (`alert-delivery-scheduler.ts`); this performs it, publishing transient
// renderer-local delivery state from the engine's callbacks.

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

/** This realm's speech performer (`docs/specs/alert.md` -> Spoken alarms). */
export interface AlertSpeaker {
  /** Queue the Session's label for the episode the host scheduled. */
  speak(id: string, episodeId: string): void;
  stop(): void;
}

/** One per renderer; the voice and the enable are the Session's Workspace policy. */
export function startAlertSpeech(): AlertSpeaker {
  clearAllAlertSpeechStates();
  const renderedEpisodes = new Map<string, string>();
  const eligible = (id: string, episodeId: string): boolean =>
    getActivity(id).episode?.id === episodeId && getSessionAlertPolicy(id).speakEnabled;
  // Drop pending work the ring clearing or the policy just resolved, cutting
  // the current utterance off, and un-render speech whose episode ended.
  const refresh = (): void => {
    speechQueue.refresh();
    for (const id of getAlertSpeechSnapshot().keys()) {
      if (getActivity(id).episode?.id !== renderedEpisodes.get(id)) {
        renderedEpisodes.delete(id);
        clearAlertSpeechState(id);
      }
    }
  };
  const stops = [subscribeToActivity(refresh), subscribeToAlertDeliveryPolicy(refresh)];
  return {
    speak(id, episodeId) {
      speechQueue.enqueue({
        key: episodeId,
        text: () => toSpokenText(deriveSessionLabel(id)),
        voice: () => getSessionAlertPolicy(id).speakVoice,
        eligible: () => eligible(id, episodeId),
        onStart: () => { renderedEpisodes.set(id, episodeId); setAlertSpeechState(id, 'speaking'); },
        onFinish: (started) => {
          if (started && eligible(id, episodeId)) { setAlertSpeechState(id, 'spoken'); return; }
          renderedEpisodes.delete(id);
          clearAlertSpeechState(id);
        },
      });
    },
    stop() {
      stops.forEach((stop) => stop());
      speechQueue.clear();
      clearAllAlertSpeechStates();
    },
  };
}
