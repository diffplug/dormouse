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
 * `speak()` and `cancelSpeech()` are the only two places this module touches the
 * engine — the seam a future native `PlatformAdapter.speak?()` would slot into
 * for hosts whose webview has no speech backend (Tauri on Linux/WebKitGTK).
 */

/** Longest utterance we will produce. A pane title has no useful upper bound. */
const SPEECH_LIMIT = 120;

/**
 * Cap on tracked in-flight utterances. A dropped utterance (see `toSpokenText`)
 * never fires a callback to retire itself, so a wedged synthesizer would grow the
 * Set forever. Evicting the oldest bounds it *without* detaching, so an evicted
 * utterance that does still fire settles normally.
 */
const MAX_TRACKED_UTTERANCES = 8;

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
  /** The utterance exists and is about to be handed to the engine. Fires *before*
   *  dispatch so tracking is already in place for an engine that settles inside
   *  `speak()`. */
  readonly onQueued: (utterance: SpeechSynthesisUtterance) => void;
  readonly onStart: (utterance: SpeechSynthesisUtterance) => void;
  /** `end`, `error`, or a refused dispatch — the engine is done with this
   *  utterance either way, and this Session's delivery state resolves. */
  readonly onSettle: (utterance: SpeechSynthesisUtterance) => void;
}

/**
 * Hand one utterance to the engine.
 *
 * Nothing here may depend on `speak()` having returned. An engine is free to
 * dispatch `start` and then `end`/`error` **synchronously** inside
 * `synth.speak()` — Chrome reports `error: not-allowed` that way when speech is
 * invoked without a user gesture, which is exactly this code path. So the
 * handlers close over the utterance itself rather than reading a variable the
 * caller assigns afterward, and `onQueued` runs before dispatch. Reading a
 * caller-assigned variable instead would silently drop the settle and leave the
 * Session pinned at `speaking`.
 */
function speak(text: string, lifecycle: SpeechLifecycle): void {
  const synth = globalThis.speechSynthesis;
  // Absent in jsdom and in webviews with no speech backend — staying silent is
  // the correct degradation, not an error.
  if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') return;

  let utterance: SpeechSynthesisUtterance;
  try {
    utterance = new globalThis.SpeechSynthesisUtterance(toSpokenText(text));
  } catch {
    // A speech engine that refuses the utterance must never break the alert path.
    return;
  }
  utterance.onstart = () => lifecycle.onStart(utterance);
  utterance.onend = () => lifecycle.onSettle(utterance);
  utterance.onerror = () => lifecycle.onSettle(utterance);
  lifecycle.onQueued(utterance);
  try {
    synth.speak(utterance);
  } catch {
    // Settle a refused dispatch rather than leaving the Session pinned at
    // `speaking` behind an utterance no callback will ever retire.
    lifecycle.onSettle(utterance);
  }
}

/** Silence the engine, dropping everything it is holding. */
function cancelSpeech(): void {
  globalThis.speechSynthesis?.cancel();
}

/** What the Settings dialog's test button says. Not a pane label — nothing rang. */
const TEST_UTTERANCE = 'Dormouse alarm test';

/**
 * Say a fixed phrase so the Settings dialog can prove the alarm is audible now,
 * rather than at 3am when a build finally finishes.
 *
 * Deliberately *not* routed through `speak()`: that publishes the transient
 * per-Session `speaking` / `spoken` state that Panes and Doors render, and no
 * Session rang here. A test that made a pane light up would be lying about
 * which terminal wants attention.
 *
 * Returns `false` when this webview has no speech backend — the same
 * degradation `speak()` makes silently (jsdom, Tauri on WebKitGTK). The button
 * needs to tell those apart from a working engine, because "nothing happened"
 * is the identical observation for both.
 */
export function speakTestUtterance(): boolean {
  const synth = globalThis.speechSynthesis;
  if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') return false;

  let utterance: SpeechSynthesisUtterance;
  try {
    utterance = new globalThis.SpeechSynthesisUtterance(toSpokenText(TEST_UTTERANCE));
  } catch {
    return false;
  }
  try {
    // No `cancel()` first, tempting as it is for a double-press: the engine
    // queue is shared with real alarms, `cancel()` empties all of it, and the
    // engine fires no callback for an utterance dropped before it started — so
    // another Session's queued announcement would be lost with `startAlertSpeech`
    // never learning it needs a re-dispatch (that is `interrupt()`'s job, and
    // only it has the queue index to do it). A short fixed phrase stacking on a
    // double-press is the smaller problem than a real alarm going out silently.
    synth.speak(utterance);
  } catch {
    return false;
  }
  return true;
}

/**
 * Watch the activity store for fresh rings and speak the unattended ones.
 * Returns a disposer that cancels pending ring timers, silences the engine, and
 * detaches delivery callbacks from utterances already handed to it.
 */
export function startAlertSpeech(): () => void {
  // A callback from an old or already-attended utterance must not overwrite the
  // state of a newer ring for the same Session. The opaque token makes every
  // utterance generation distinct without exposing engine objects to the store.
  const currentToken = new Map<string, object>();
  const utterances = new Set<SpeechSynthesisUtterance>();
  // Utterances the engine has accepted but not begun, at most one per Session —
  // exactly what `interrupt` has to put back. This index is capped together with
  // `utterances`: a silent backend cannot pin one entry per Session forever.
  const queued = new Map<string, SpeechSynthesisUtterance>();
  clearAllAlertSpeechStates();

  const detach = (utterance: SpeechSynthesisUtterance): void => {
    utterance.onstart = null;
    utterance.onend = null;
    utterance.onerror = null;
  };

  const forgetQueued = (utterance: SpeechSynthesisUtterance): void => {
    for (const [sessionId, candidate] of queued) {
      if (candidate !== utterance) continue;
      queued.delete(sessionId);
      return;
    }
  };

  // Only insertion point, one entry per call — so both retention containers can
  // never exceed the cap and a single oldest-first eviction is enough. Do not
  // detach an evicted utterance: if the engine eventually starts or settles it,
  // its callback still applies the normal generation-token checks.
  const track = (utterance: SpeechSynthesisUtterance): void => {
    if (utterances.size >= MAX_TRACKED_UTTERANCES) {
      const oldest = utterances.values().next().value;
      if (oldest) {
        utterances.delete(oldest);
        forgetQueued(oldest);
      }
    }
    utterances.add(utterance);
  };

  const retire = (utterance: SpeechSynthesisUtterance): void => {
    utterances.delete(utterance);
    detach(utterance);
  };

  const settle = (sessionId: string, token: object, utterance: SpeechSynthesisUtterance): void => {
    retire(utterance);
    if (queued.get(sessionId) === utterance) queued.delete(sessionId);
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

  const fireSpeech = (sessionId: string): void => {
    const token = {};
    speak(deriveSessionLabel(sessionId), {
      onQueued: (utterance) => {
        track(utterance);
        // Refresh insertion order if a newer ring replaces the same Session.
        queued.delete(sessionId);
        queued.set(sessionId, utterance);
      },
      onStart: (utterance) => {
        // A late callback from an evicted/older generation must not delete a
        // newer queued utterance for the same Session.
        if (queued.get(sessionId) === utterance) queued.delete(sessionId);
        // The engine can queue several Sessions. Re-check at the actual start,
        // not merely when `speak()` accepted the queued utterance.
        if (getActivity(sessionId).status !== 'ALERT_RINGING') return;
        currentToken.set(sessionId, token);
        setAlertSpeechState(sessionId, 'speaking');
      },
      onSettle: (utterance) => settle(sessionId, token, utterance),
    });
  };

  /**
   * Cut off the utterance the engine is reading aloud, because the ring that
   * produced it was just resolved. The announcement exists to summon the user,
   * and the user is here — finishing the sentence is noise.
   *
   * Web Speech has no per-utterance stop, so this empties the whole queue. Every
   * Session that was still waiting is re-dispatched: attending one Pane must not
   * silence another Pane's alarm. Nothing already started comes back — only the
   * cut Session had started, and restarting an announcement is worse than losing
   * it. Mirroring the engine's queue rather than owning one and feeding it a
   * single utterance at a time is deliberate: an utterance the engine drops
   * without a callback (see `MAX_TRACKED_UTTERANCES`) would block a self-owned
   * queue forever.
   */
  const interrupt = (): void => {
    // Same gates as the ring machine's own `fire`: a re-dispatch is a fresh
    // decision to speak, so a Session attended meanwhile — or the setting being
    // switched off mid-utterance — drops out here rather than being replayed.
    const speakable = getAlertSettings().speakEnabled;
    const activity = getActivitySnapshot();
    const requeue: string[] = [];
    // `cancel()` is not obliged to fire a callback per dropped utterance, so the
    // ones it drops are retired here rather than left in the tracking set.
    for (const [sessionId, utterance] of queued) {
      retire(utterance);
      if (speakable && activity.get(sessionId)?.status === 'ALERT_RINGING') requeue.push(sessionId);
    }
    queued.clear();
    cancelSpeech();
    for (const sessionId of requeue) fireSpeech(sessionId);
  };

  const stopRingWatch = watchUnattendedRings({
    enabled: () => getAlertSettings().speakEnabled,
    delayMs: () => getAlertSettings().speakDelayMs,
    fire: fireSpeech,
  });

  const clearResolvedSpeech = (): void => {
    // Runs on every activity notification — i.e. constantly during terminal
    // output — and has nothing to do in the overwhelming majority of them.
    // (`getActivitySnapshot()` memoizes, so this is an early-out, not a saving:
    // Baseboard's own subscriber rebuilds that Map in the same notification.)
    const speech = getAlertSpeechSnapshot();
    if (speech.size === 0 && queued.size === 0) return;
    const activity = getActivitySnapshot();
    // A queued-only Session has no rendered delivery state, so it is absent from
    // `speech`. Prune its old ring here anyway: if the Session rings again before
    // an unrelated interrupt, that stale entry must not bypass the new ring's
    // delay by being re-dispatched. The engine may still own the utterance, so
    // leave it tracked and its guarded callbacks attached.
    for (const sessionId of queued.keys()) {
      if (activity.get(sessionId)?.status === 'ALERT_RINGING') continue;
      queued.delete(sessionId);
    }
    if (speech.size === 0) return;
    let interrupted = false;
    for (const sessionId of speech.keys()) {
      if (activity.get(sessionId)?.status === 'ALERT_RINGING') continue;
      // A live token means the engine is mid-utterance for this Session — the
      // engine's own record, not the rendered state, decides what to silence.
      if (currentToken.delete(sessionId)) interrupted = true;
      clearAlertSpeechState(sessionId);
    }
    // After the state is cleared, so the `cancel()` callback lands on a Session
    // whose generation token is already gone and cannot revive `spoken`.
    if (interrupted) interrupt();
  };
  // No seed call: `clearAllAlertSpeechStates()` above already leaves the map
  // empty, and `watchUnattendedRings` cannot fire before this returns.
  const unsubscribeActivity = subscribeToActivity(clearResolvedSpeech);

  return () => {
    stopRingWatch();
    unsubscribeActivity();
    currentToken.clear();
    for (const utterance of utterances) detach(utterance);
    utterances.clear();
    queued.clear();
    // Detaching handlers only stops *our* state from being touched after
    // teardown; the engine still owns its queue. Without this, a webview that
    // unmounts mid-alarm keeps reading Pane names aloud with no visible source
    // and no UI left to stop it.
    cancelSpeech();
    clearAllAlertSpeechStates();
  };
}
