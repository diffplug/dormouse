import { getAlertSettings } from './alert-settings';
import { watchUnattendedRings } from './alert-ring-watch';
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
 * Markup metacharacters become spaces rather than being deleted, so `a<b` reads
 * as two words instead of being run together.
 */
export function toSpokenText(label: string): string {
  const cleaned = label
    // Control characters are meaningless aloud and arrive with untrusted
    // terminal titles.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[<>&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Capped in code points, matching `boundedPushText`: a cut mid-surrogate
  // would hand the engine a lone half.
  return Array.from(cleaned).slice(0, SPEECH_LIMIT).join('').trim() || 'terminal';
}

function speak(text: string): void {
  const synth = globalThis.speechSynthesis;
  // Absent in jsdom and in webviews with no speech backend — staying silent is
  // the correct degradation, not an error.
  if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') return;
  try {
    synth.speak(new globalThis.SpeechSynthesisUtterance(toSpokenText(text)));
  } catch {
    // A speech engine that refuses the utterance must never break the alert path.
  }
}

/**
 * Watch the activity store for fresh rings and speak the unattended ones.
 * Returns a disposer that cancels every pending utterance.
 */
export function startAlertSpeech(): () => void {
  return watchUnattendedRings({
    enabled: () => getAlertSettings().speakEnabled,
    delayMs: () => getAlertSettings().speakDelayMs,
    fire: (id) => speak(deriveSessionLabel(id)),
  });
}
