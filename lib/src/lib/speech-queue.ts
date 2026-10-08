import type { SpeechAttemptHandle, SpeechEngine } from './speech-engine';

/** The engine owns only our current utterance. Pending jobs remain cancellable here. */
export interface SpeechJob {
  key: string;
  text: () => string;
  voice?: () => string | null;
  eligible: () => boolean;
  /** A still-owed job waits without blocking other Sessions. */
  deferred?: () => boolean;
  onStart?: () => void;
  onFinish?: (started: boolean) => void;
}

/** Pending jobs are refused past this, never evicted: the refusal is an answer. */
const MAX_PENDING = 64;
/** A missing engine callback must not retain every later alert indefinitely. */
export const SPEECH_ENGINE_TIMEOUT_MS = 60_000;
interface Attempt {
  job: SpeechJob;
  handle: SpeechAttemptHandle | null;
  started: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The one seam between Dormouse's pending spoken alarms and a speech engine
 * (`docs/specs/alert.md` -> "Spoken alarms" owns the behavior; the bounds and
 * the timeout are here). **Only one utterance at a time is admitted per
 * renderer** — Settings test sounds included, since they share `speechQueue`
 * (`alert-speech.ts`) — so the engine never interleaves two panes and an
 * ineligible job can still be dropped while it is only pending here.
 *
 * Bounded in both directions, because a wedged or callback-less engine must not
 * retain later alerts: at most {@link MAX_PENDING} pending jobs admitted (one
 * more while a deferred, unstarted attempt returns to the queue), and at most
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

  constructor(private readonly engine: SpeechEngine) {}

  /** False when no engine exists or the queue is full; a job that fails later reports through `onFinish(false)`. */
  enqueue(job: SpeechJob): boolean {
    if (!this.engine.available()) return false;
    if (this.active?.job.key === job.key || this.pending.some(pending => pending.key === job.key)) return true;
    if (this.pending.length >= MAX_PENDING) return false;
    this.pending.push(job);
    this.pump();
    return true;
  }

  /** Recheck both waiting and engine-owned work after activity/policy changes. */
  refresh(): void {
    // Runs on every activity notification; almost always there is nothing queued.
    if (!this.active && this.pending.length === 0) return;
    if (this.pending.length) this.pending = this.pending.filter(job => job.eligible());
    if (this.active && !this.active.job.eligible()) this.finish(this.active, true);
    if (this.active?.job.deferred?.()) this.requeue(this.active);
    this.pump();
  }

  clear(): void {
    this.pending = [];
    if (this.active) this.finish(this.active, true);
  }

  private finish(attempt: Attempt, cancel = false): void {
    if (this.active !== attempt) return;
    // Revoke callback identity before the engine is told anything: disposing
    // may synchronously call back. Teardown (`clear`) comes through here too.
    this.active = null;
    clearTimeout(attempt.timer);
    try { attempt.handle?.dispose(cancel); } catch { /* unavailable engine */ }
    attempt.job.onFinish?.(attempt.started);
    this.pump();
  }

  private requeue(attempt: Attempt): void {
    // Preparation is not delivery. Retain a job that never actually started,
    // past the bound if the queue filled meanwhile, and revoke the old engine
    // attempt before cancellation can call back.
    if (!attempt.started) this.pending.unshift(attempt.job);
    this.finish(attempt, true);
  }

  /** Drop resolved jobs on the way to the first that is not deferred. */
  private takeNext(): SpeechJob | undefined {
    for (let i = 0; i < this.pending.length;) {
      const job = this.pending[i];
      if (!job.eligible()) { this.pending.splice(i, 1); continue; }
      if (job.deferred?.()) { i++; continue; }
      this.pending.splice(i, 1);
      return job;
    }
    return undefined;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.active) {
        const job = this.takeNext();
        if (!job) break;
        const attempt: Attempt = {
          job, handle: null, started: false,
          timer: setTimeout(() => this.finish(attempt, true), SPEECH_ENGINE_TIMEOUT_MS),
        };
        this.active = attempt;
        try {
          attempt.handle = this.engine.prepare({ text: job.text(), voice: job.voice?.() ?? null }, {
            onStart: () => {
              if (this.active !== attempt || attempt.started) return;
              if (!job.eligible()) { this.finish(attempt, true); return; }
              if (job.deferred?.()) { this.requeue(attempt); return; }
              attempt.started = true;
              job.onStart?.();
            },
            onEnd: () => this.finish(attempt),
            onFail: () => this.finish(attempt),
          });
          attempt.handle.start();
        } catch { this.finish(attempt); }
        // Synchronous completion clears active; loop advances without recursion.
      }
    } finally { this.pumping = false; }
  }
}
