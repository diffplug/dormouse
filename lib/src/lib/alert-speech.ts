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

// Speech sink and sanitizer; alert-ring-watch owns ring timing/cancellation.
// Engine callbacks publish transient renderer-local delivery state.

/** Longest utterance we will produce. A pane title has no useful upper bound. */
const SPEECH_LIMIT = 120;

/** Bounds callback-less utterances; eviction keeps handlers so late settles work. */
const MAX_TRACKED_UTTERANCES = 8;

/** Sanitize a display label for speech. WebKit wedges on angle brackets; replace
 * punctuation, symbols, and controls with spaces so adjacent words do not join. */
export function toSpokenText(label: string): string {
  const cleaned = label
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

/** Dispatch after tracking is installed; engines may synchronously start and
 * settle inside `synth.speak()`. */
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

/** Play the Settings test without publishing Session delivery state; false means
 * this webview has no speech backend. */
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
    // Do not cancel the shared engine queue: only `interrupt` can re-dispatch
    // queued real alarms whose callbacks cancellation may drop.
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

  /** Stop resolved speech. Web Speech cancels the whole queue, so re-dispatch
   * still-ringing queued Sessions; never restart the utterance already speaking. */
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
    // Evicted utterances keep their handlers (see `track`), so detaching below
    // does not reach them. Dropping the tokens is what makes any late callback
    // from one inert: `settle` early-outs on the generation check.
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
