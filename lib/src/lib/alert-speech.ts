import { getAlertSettings } from './alert-settings';
import { watchUnattendedRings } from './alert-ring-watch';
import {
  clearAlertSpeechState,
  clearAllAlertSpeechStates,
  getAlertSpeechSnapshot,
  setAlertSpeechState,
} from './alert-speech-state';
import { getActivity, getActivitySnapshot, subscribeToActivity } from './session-activity-store';
import { deriveSessionLabel } from './session-label';

/**
 * Spoken alarms (`docs/specs/alert.md` -> Alarm settings). When a Session rings
 * and stays unattended for `speakDelayMs`, say its pane name out loud.
 *
 * The ring detection, delay, and cancellation rules live in
 * `alert-ring-watch.ts`, shared with push notifications; this module is only
 * the speech sink and its sanitizer.
 *
 * Speech uses the same derived pane label as the visible UI, passed through
 * `toSpokenText`. That intentionally includes terminal-supplied OSC 0/2/9 titles
 * when they win label derivation; `ActivityNotification` fields are not chosen
 * as a separate speech payload.
 *
 * Actual utterance callbacks publish the transient per-Session `speaking` /
 * `spoken` state rendered by Panes and Doors. It is intentionally separate from
 * persisted Activity: resolving the ring clears it, and a restore never recreates
 * evidence that this renderer spoke.
 *
 * `speak()` is the single seam a future native `PlatformAdapter.speak?()` would
 * slot into for hosts whose webview has no speech backend (Tauri on
 * Linux/WebKitGTK).
 */

/** Longest utterance we will produce. A pane title has no useful upper bound. */
const SPEECH_LIMIT = 120;

/**
 * Reduce a display label to something safe to hand a speech engine.
 *
 * WebKit (standalone on macOS) silently drops an utterance containing angle
 * brackets **and leaves the synthesizer wedged**, so every later utterance is
 * dropped too until the page reloads. Pane labels carry chrome like `<idle>`,
 * and terminal-supplied OSC 0/2/9 titles reach speech as well — so without this
 * any program could permanently disable spoken alarms for the session by
 * putting a `<` in its title (`docs/specs/alert.md` -> Text And Security).
 *
 * Markup metacharacters and asterisks become spaces rather than being deleted,
 * so `a<b` reads as two words instead of being run together.
 */
export function toSpokenText(label: string): string {
  const cleaned = label
    // Control characters are meaningless aloud and arrive with untrusted
    // terminal titles.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[<>&*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Capped in code points, matching `boundedPushText`: a cut mid-surrogate
  // would hand the engine a lone half.
  return Array.from(cleaned).slice(0, SPEECH_LIMIT).join('').trim() || 'terminal';
}

interface SpeechLifecycle {
  readonly onStart: () => void;
  readonly onEnd: () => void;
  readonly onError: () => void;
}

function speak(text: string, lifecycle: SpeechLifecycle): SpeechSynthesisUtterance | null {
  const synth = globalThis.speechSynthesis;
  // Absent in jsdom and in webviews with no speech backend — staying silent is
  // the correct degradation, not an error.
  if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') return null;

  let utterance: SpeechSynthesisUtterance;
  try {
    utterance = new globalThis.SpeechSynthesisUtterance(toSpokenText(text));
    utterance.onstart = lifecycle.onStart;
    utterance.onend = lifecycle.onEnd;
    utterance.onerror = lifecycle.onError;
    synth.speak(utterance);
    return utterance;
  } catch {
    // A speech engine that refuses the utterance must never break the alert path.
    return null;
  }
}

/**
 * Watch the activity store for fresh rings and speak the unattended ones.
 * Returns a disposer that cancels pending ring timers and detaches delivery
 * callbacks from utterances already handed to the engine.
 */
export function startAlertSpeech(): () => void {
  // A callback from an old or already-attended utterance must not overwrite the
  // state of a newer ring for the same Session. The opaque token makes every
  // utterance generation distinct without exposing engine objects to the store.
  const currentToken = new Map<string, object>();
  const utterances = new Set<SpeechSynthesisUtterance>();
  clearAllAlertSpeechStates();

  const settle = (sessionId: string, token: object, utterance: SpeechSynthesisUtterance): void => {
    utterances.delete(utterance);
    utterance.onstart = null;
    utterance.onend = null;
    utterance.onerror = null;
    if (currentToken.get(sessionId) !== token) return;
    currentToken.delete(sessionId);
    // An utterance that really started counts as spoken even if the engine later
    // reports an error: the user may already have heard part of it.
    if (getActivity(sessionId).status === 'ALERT_RINGING') {
      setAlertSpeechState(sessionId, 'spoken');
    } else {
      clearAlertSpeechState(sessionId);
    }
  };

  const stopRingWatch = watchUnattendedRings({
    enabled: () => getAlertSettings().speakEnabled,
    delayMs: () => getAlertSettings().speakDelayMs,
    fire: (sessionId) => {
      const token = {};
      let utterance: SpeechSynthesisUtterance | null = null;
      const lifecycle: SpeechLifecycle = {
        onStart: () => {
          // The engine can queue several Sessions. Re-check at the actual start,
          // not merely when `speak()` accepted the queued utterance.
          if (getActivity(sessionId).status !== 'ALERT_RINGING') return;
          currentToken.set(sessionId, token);
          setAlertSpeechState(sessionId, 'speaking');
        },
        onEnd: () => {
          if (utterance) settle(sessionId, token, utterance);
        },
        onError: () => {
          if (utterance) settle(sessionId, token, utterance);
        },
      };
      utterance = speak(deriveSessionLabel(sessionId), lifecycle);
      if (utterance) utterances.add(utterance);
    },
  });

  const clearResolvedSpeech = (): void => {
    const activity = getActivitySnapshot();
    for (const sessionId of getAlertSpeechSnapshot().keys()) {
      if (activity.get(sessionId)?.status === 'ALERT_RINGING') continue;
      currentToken.delete(sessionId);
      clearAlertSpeechState(sessionId);
    }
  };
  clearResolvedSpeech();
  const unsubscribeActivity = subscribeToActivity(clearResolvedSpeech);

  return () => {
    stopRingWatch();
    unsubscribeActivity();
    currentToken.clear();
    for (const utterance of utterances) {
      utterance.onstart = null;
      utterance.onend = null;
      utterance.onerror = null;
    }
    utterances.clear();
    clearAllAlertSpeechStates();
  };
}
