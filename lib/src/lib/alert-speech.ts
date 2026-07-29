import { getAlertSettings } from './alert-settings';
import { getActivity, getActivitySnapshot, subscribeToActivity } from './session-activity-store';
import { deriveSessionLabel } from './session-label';

/**
 * Spoken alarms (`docs/specs/alert.md` -> Alarm settings). When a Session rings
 * and stays unattended for `speakDelayMs`, say its pane name out loud.
 *
 * Speech uses the same derived pane label as the visible UI, passed through
 * `toSpokenText`. That intentionally includes terminal-supplied OSC 0/2/9 titles
 * when they win label derivation; `ActivityNotification` fields are not chosen
 * as a separate speech payload.
 *
 * Renderer-side by design: the ring already arrives here as an activity-store
 * transition, and the delay timer needs no host round-trip. `speak()` is the
 * single seam a future native `PlatformAdapter.speak?()` would slot into for
 * hosts whose webview has no speech backend (Tauri on Linux/WebKitGTK).
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
  return cleaned.slice(0, SPEECH_LIMIT).trim() || 'terminal';
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
  // Last seen status per Session. A Session missing from this map has never been
  // observed, so its first sighting can never count as a transition — that is
  // what keeps a restore or reconnect that arrives already ringing silent
  // (`docs/specs/alert.md` -> WATCHING Track).
  const lastStatus = new Map<string, string>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const cancel = (id: string): void => {
    const timer = pending.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    pending.delete(id);
  };

  const onActivityChange = (): void => {
    const snapshot = getActivitySnapshot();

    for (const [id, state] of snapshot) {
      const previous = lastStatus.get(id);
      lastStatus.set(id, state.status);

      if (state.status !== 'ALERT_RINGING') {
        // Attended, dismissed, or never ringing — either way nothing to say.
        cancel(id);
        continue;
      }
      // Already ringing, or seen for the first time already ringing.
      if (previous === 'ALERT_RINGING' || previous === undefined) continue;

      const { speakEnabled, speakDelayMs } = getAlertSettings();
      if (!speakEnabled) continue;

      pending.set(id, setTimeout(() => {
        pending.delete(id);
        // Re-read rather than trusting the closure: the user may have attended
        // or dismissed during the delay, and the setting may have been toggled.
        if (getActivity(id).status !== 'ALERT_RINGING') return;
        if (!getAlertSettings().speakEnabled) return;
        speak(deriveSessionLabel(id));
      }, speakDelayMs));
    }

    // A Session that left the store entirely (pane killed) must not speak.
    for (const id of [...lastStatus.keys()]) {
      if (snapshot.has(id)) continue;
      lastStatus.delete(id);
      cancel(id);
    }
  };

  // Seed from the current snapshot so nothing already on screen counts as fresh.
  onActivityChange();
  const unsubscribe = subscribeToActivity(onActivityChange);

  return () => {
    unsubscribe();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    lastStatus.clear();
  };
}
