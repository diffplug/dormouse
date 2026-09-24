import { cfg } from '../cfg';

/**
 * The output/silence detector's own states. It knows nothing about attention,
 * rules, or ringing — it only reports how the Session's output looks right now.
 */
export type QuiesceStatus =
  | 'NOTHING_TO_SHOW'
  | 'MIGHT_BE_BUSY'
  | 'BUSY'
  | 'MIGHT_NEED_ATTENTION';

export interface QuiesceDetectorOptions {
  onChange?: (status: QuiesceStatus) => void;
  /**
   * A busy Session stayed quiet long enough to look finished. Fired once per
   * settle, immediately before the detector returns to `NOTHING_TO_SHOW`, so an
   * owner that latches a ring has already done so by the time the reset is
   * announced. Whether a settle rings a human is the owner's policy call.
   */
  onSettled?: () => void;
}

const T_BUSY_CANDIDATE_GAP = cfg.alert.busyCandidateGap;
const T_BUSY_CONFIRM_GAP = cfg.alert.busyConfirmGap;
const T_MIGHT_NEED_ATTENTION = cfg.alert.mightNeedAttention;
const T_SETTLED_CONFIRM = cfg.alert.needsAttentionConfirm;
const T_RESIZE_DEBOUNCE = cfg.alert.resizeDebounce;

/** Silence from the last accepted output through a confirmed settle. */
const QUIESCE_AFTER_OUTPUT_MS = T_MIGHT_NEED_ATTENTION + T_SETTLED_CONFIRM;

/** Longest silence unconfirmed candidate history can span and still count. */
const CANDIDATE_HISTORY_TTL_MS = T_BUSY_CANDIDATE_GAP + T_BUSY_CONFIRM_GAP;

type DetectorTimer = 'busyCandidate' | 'busyConfirm' | 'mightNeedAttention' | 'settledConfirm' | 'resize';

/**
 * Watches one Session's PTY output and reports busy/quiet transitions.
 *
 * One of these runs for every Session for its whole lifetime — it is a plain
 * observer, not an alarm. It never latches: a settle is announced through
 * `onSettled` and the detector immediately starts over.
 */
export class QuiesceDetector {
  private status: QuiesceStatus = 'NOTHING_TO_SHOW';
  private resizeGrace = false;
  private disposed = false;
  private timers = new Map<DetectorTimer, ReturnType<typeof setTimeout>>();
  private firstOutputAt: number | null = null;
  private lastOutputAt: number | null = null;
  /**
   * Last output that got past the resize grace window. Deliberately outlives
   * `reset()`: "how long since this pane last printed" is a fact about the PTY,
   * not state-machine history, and an owner timing quiet across a command
   * boundary still needs it after the boundary has reset the machine.
   */
  private lastAcceptedOutputAt: number | null = null;
  private outputCountSinceReset = 0;
  private readonly onChange: ((status: QuiesceStatus) => void) | null;
  private readonly onSettled: (() => void) | null;

  constructor(options?: QuiesceDetectorOptions) {
    this.onChange = options?.onChange ?? null;
    this.onSettled = options?.onSettled ?? null;
  }

  getStatus(): QuiesceStatus {
    return this.status;
  }

  /** The detector has confirmed ongoing output and is now waiting for quiet. */
  isConfirmedBusy(): boolean {
    return this.status === 'BUSY' || this.status === 'MIGHT_NEED_ATTENTION';
  }

  /**
   * When the pane counts as quiet if nothing more arrives — the instant a
   * settle would confirm. The one place that composition is written down, so an
   * owner scheduling against quiet never restates the settle path's stages.
   */
  quietAt(): number {
    return (this.lastAcceptedOutputAt ?? Date.now()) + QUIESCE_AFTER_OUTPUT_MS;
  }

  /** Start over from `NOTHING_TO_SHOW`, forgetting the state machine's output
   * history. The `quietAt` clock is not history and survives (see above). */
  reset(): void {
    if (this.disposed) return;
    this.clearActivityTimers();
    this.resetOutputTracking();
    this.setStatus('NOTHING_TO_SHOW');
  }

  onData(): void {
    if (this.disposed || this.resizeGrace) return;

    const now = Date.now();
    // Candidate history only describes one run of output. A timer callback can
    // run late — a busy event loop, a suspended process — so expire it against
    // the clock on arrival.
    if (
      !this.isConfirmedBusy() && this.lastOutputAt !== null
      && now - this.lastOutputAt > CANDIDATE_HISTORY_TTL_MS
    ) {
      this.reset();
    }

    this.lastOutputAt = now;
    this.lastAcceptedOutputAt = now;

    switch (this.status) {
      case 'NOTHING_TO_SHOW':
        this.handleNothingToShowOutput(now);
        break;
      case 'MIGHT_BE_BUSY':
        this.enterBusy();
        break;
      case 'BUSY':
        this.startMightNeedAttentionTimer();
        break;
      case 'MIGHT_NEED_ATTENTION':
        this.enterBusy();
        break;
    }
  }

  onResize(): void {
    if (this.disposed) return;
    this.resizeGrace = true;
    this.schedule('resize', T_RESIZE_DEBOUNCE);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private handleNothingToShowOutput(now: number): void {
    if (this.firstOutputAt === null) {
      this.firstOutputAt = now;
      this.outputCountSinceReset = 1;
      this.startBusyCandidateTimer();
      return;
    }

    this.outputCountSinceReset += 1;

    if (now - this.firstOutputAt >= T_BUSY_CANDIDATE_GAP) {
      this.enterMightBeBusy();
    }
  }

  private enterMightBeBusy(): void {
    this.clearActivityTimers();
    this.setStatus('MIGHT_BE_BUSY');
    this.schedule('busyConfirm', T_BUSY_CONFIRM_GAP);
  }

  private enterBusy(): void {
    this.clearActivityTimers();
    this.resetOutputTracking();
    this.setStatus('BUSY');
    this.startMightNeedAttentionTimer();
  }

  private startBusyCandidateTimer(): void {
    if (!this.timers.has('busyCandidate')) this.schedule('busyCandidate', T_BUSY_CANDIDATE_GAP);
  }

  private startMightNeedAttentionTimer(): void {
    this.schedule('mightNeedAttention', T_MIGHT_NEED_ATTENTION);
  }

  private schedule(kind: DetectorTimer, delay: number): void {
    clearTimeout(this.timers.get(kind));
    const dueAt = Date.now() + delay;
    const timer = setTimeout(() => {
      this.timers.delete(kind);
      if (this.disposed) return;
      switch (kind) {
        case 'resize': this.resizeGrace = false; break;
        case 'busyCandidate':
          if (this.status === 'NOTHING_TO_SHOW' && this.outputCountSinceReset >= 2) this.enterMightBeBusy();
          break;
        case 'busyConfirm':
          if (this.status !== 'MIGHT_BE_BUSY') break;
          this.seedFromLatestOutput();
          this.setStatus('NOTHING_TO_SHOW');
          break;
        case 'mightNeedAttention':
          if (this.status !== 'BUSY') break;
          this.setStatus('MIGHT_NEED_ATTENTION');
          // Carry the original deadline through a callback that ran late.
          this.schedule('settledConfirm', Math.max(0, dueAt + T_SETTLED_CONFIRM - Date.now()));
          break;
        case 'settledConfirm':
          if (this.status !== 'MIGHT_NEED_ATTENTION') break;
          this.resetOutputTracking();
          this.onSettled?.();
          this.setStatus('NOTHING_TO_SHOW');
          break;
      }
    }, delay);
    this.timers.set(kind, timer);
  }

  private clearActivityTimers(): void {
    for (const [kind, timer] of this.timers) {
      if (kind === 'resize') continue;
      clearTimeout(timer);
      this.timers.delete(kind);
    }
  }

  private seedFromLatestOutput(): void {
    if (this.lastOutputAt === null) {
      this.resetOutputTracking();
      return;
    }
    this.firstOutputAt = this.lastOutputAt;
    this.outputCountSinceReset = 1;
    this.startBusyCandidateTimer();
  }

  private resetOutputTracking(): void {
    this.firstOutputAt = null;
    this.lastOutputAt = null;
    this.outputCountSinceReset = 0;
  }

  private setStatus(status: QuiesceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onChange?.(status);
  }
}
