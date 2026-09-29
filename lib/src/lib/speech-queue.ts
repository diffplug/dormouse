/** The browser owns only our current utterance. Pending jobs remain cancellable here. */
export interface SpeechJob {
  key: string;
  text: () => string;
  voice?: () => string | null;
  eligible: () => boolean;
  onStart?: () => void;
  onFinish?: (started: boolean) => void;
}

/** Pending jobs are refused past this, never evicted: the refusal is an answer. */
const MAX_PENDING = 64;
/** A missing engine callback must not retain every later alert indefinitely. */
export const SPEECH_ENGINE_TIMEOUT_MS = 60_000;
interface Attempt {
  job: SpeechJob;
  utterance: SpeechSynthesisUtterance;
  synth: SpeechSynthesis;
  started: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The one seam between Dormouse's pending spoken alarms and the browser's Web
 * Speech engine (`docs/specs/alert.md` -> "Spoken alarms" owns the behavior;
 * the bounds and the timeout are here). **Only one utterance at a time is
 * admitted per renderer** — Settings test sounds included, since they share
 * {@link speechQueue} — so the engine never interleaves two panes and an
 * ineligible job can still be dropped while it is only pending here.
 *
 * Bounded in both directions, because a wedged or callback-less engine must not
 * retain later alerts: at most {@link MAX_PENDING} pending jobs, and at most
 * {@link SPEECH_ENGINE_TIMEOUT_MS} per engine attempt, after which the attempt
 * is cancelled and the queue advances. Callback identity is revoked before any
 * cancel, so a detached late callback cannot settle the attempt that replaced
 * it. Nothing is retried: an alarm that failed, expired, or never fit has
 * missed the moment it was about.
 */
export class SpeechQueue {
  private pending: SpeechJob[] = [];
  private active: Attempt | null = null;
  private pumping = false;

  /** False when no engine exists or the queue is full; a job that fails later reports through `onFinish(false)`. */
  enqueue(job: SpeechJob): boolean {
    if (!globalThis.speechSynthesis || typeof globalThis.SpeechSynthesisUtterance !== 'function') return false;
    if (this.active?.job.key === job.key || this.pending.some(pending => pending.key === job.key)) return true;
    if (this.pending.length >= MAX_PENDING) return false;
    this.pending.push(job);
    this.pump();
    return true;
  }

  /** Recheck both waiting and browser-owned work after activity/policy changes. */
  refresh(): void {
    // Runs on every activity notification; almost always there is nothing queued.
    if (!this.active && this.pending.length === 0) return;
    if (this.pending.length) this.pending = this.pending.filter(job => job.eligible());
    if (this.active && !this.active.job.eligible()) this.finish(this.active, true);
    this.pump();
  }

  clear(): void {
    this.pending = [];
    if (this.active) this.finish(this.active, true);
  }

  private finish(attempt: Attempt, cancel = false): void {
    if (this.active !== attempt) return;
    this.active = null;
    clearTimeout(attempt.timer);
    attempt.utterance.onstart = attempt.utterance.onend = attempt.utterance.onerror = null;
    // Revoke callback identity before cancel(), which may synchronously callback.
    // Teardown (`clear`) comes through here too, cancelling the engine.
    if (cancel) { try { attempt.synth.cancel(); } catch { /* unavailable engine */ } }
    attempt.job.onFinish?.(attempt.started);
    this.pump();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.active && this.pending.length) {
        const job = this.pending.shift()!;
        if (!job.eligible()) continue;
        const synth = globalThis.speechSynthesis;
        let utterance: SpeechSynthesisUtterance;
        try {
          utterance = new globalThis.SpeechSynthesisUtterance(job.text());
          const voice = job.voice?.();
          if (voice) utterance.voice = synth.getVoices?.().find(candidate => candidate.voiceURI === voice) ?? null;
        } catch { job.onFinish?.(false); continue; }
        const attempt: Attempt = {
          job, utterance, synth, started: false,
          timer: setTimeout(() => this.finish(attempt, true), SPEECH_ENGINE_TIMEOUT_MS),
        };
        this.active = attempt;
        utterance.onstart = () => {
          if (this.active !== attempt) return;
          if (!job.eligible()) { this.finish(attempt, true); return; }
          attempt.started = true;
          job.onStart?.();
        };
        utterance.onend = utterance.onerror = () => this.finish(attempt);
        try { synth.speak(utterance); }
        catch { this.finish(attempt); }
        // Synchronous completion clears active; loop advances without recursion.
      }
    } finally { this.pumping = false; }
  }
}

/** Settings previews and real alerts share the same native engine admission. */
export const speechQueue = new SpeechQueue();
