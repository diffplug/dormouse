/** The browser owns only our current utterance. Pending jobs remain cancellable here. */
export interface SpeechJob {
  key: string;
  text: () => string;
  voice?: () => string | null;
  eligible: () => boolean;
  onAdmit?: () => void;
  onStart?: () => void;
  onFinish?: (started: boolean) => void;
}

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
        try { job.onAdmit?.(); synth.speak(utterance); }
        catch { this.finish(attempt); }
        // Synchronous completion clears active; loop advances without recursion.
      }
    } finally { this.pumping = false; }
  }
}

/** Settings previews and real alerts share the same native engine admission. */
export const speechQueue = new SpeechQueue();
