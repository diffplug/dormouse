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
  private busyCandidateTimer: ReturnType<typeof setTimeout> | null = null;
  private busyConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private mightNeedAttentionTimer: ReturnType<typeof setTimeout> | null = null;
  private settledConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private firstOutputAt: number | null = null;
  private lastOutputAt: number | null = null;
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

  /** Start over from `NOTHING_TO_SHOW`, forgetting all output history. */
  reset(): void {
    if (this.disposed) return;
    this.clearActivityTimers();
    this.resetOutputTracking();
    this.setStatus('NOTHING_TO_SHOW');
  }

  onData(): void {
    if (this.disposed || this.resizeGrace) return;

    const now = Date.now();
    this.lastOutputAt = now;

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
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeGrace = false;
      this.resizeTimer = null;
    }, T_RESIZE_DEBOUNCE);
  }

  dispose(): void {
    this.disposed = true;
    this.clearActivityTimers();
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
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
    this.busyConfirmTimer = setTimeout(() => {
      this.busyConfirmTimer = null;
      if (this.status !== 'MIGHT_BE_BUSY') return;
      this.seedFromLatestOutput();
      this.setStatus('NOTHING_TO_SHOW');
    }, T_BUSY_CONFIRM_GAP);
  }

  private enterBusy(): void {
    this.clearActivityTimers();
    this.resetOutputTracking();
    this.setStatus('BUSY');
    this.startMightNeedAttentionTimer();
  }

  private startBusyCandidateTimer(): void {
    if (this.busyCandidateTimer !== null) return;
    this.busyCandidateTimer = setTimeout(() => {
      this.busyCandidateTimer = null;
      if (this.status !== 'NOTHING_TO_SHOW') return;
      if (this.outputCountSinceReset >= 2) {
        this.enterMightBeBusy();
      }
    }, T_BUSY_CANDIDATE_GAP);
  }

  private startMightNeedAttentionTimer(): void {
    if (this.mightNeedAttentionTimer !== null) {
      clearTimeout(this.mightNeedAttentionTimer);
    }
    this.mightNeedAttentionTimer = setTimeout(() => {
      this.mightNeedAttentionTimer = null;
      if (this.status !== 'BUSY') return;
      this.setStatus('MIGHT_NEED_ATTENTION');
      this.startSettledConfirmTimer();
    }, T_MIGHT_NEED_ATTENTION);
  }

  private startSettledConfirmTimer(): void {
    this.settledConfirmTimer = setTimeout(() => {
      this.settledConfirmTimer = null;
      if (this.status !== 'MIGHT_NEED_ATTENTION') return;
      this.resetOutputTracking();
      // Announce the settle before the status change: an owner that latches a
      // ring in the handler already owns the projection when `NOTHING_TO_SHOW`
      // is notified, so subscribers never see a non-ringing blip in between. If
      // the handler reset us, the transition below is a no-op.
      this.onSettled?.();
      this.setStatus('NOTHING_TO_SHOW');
    }, T_SETTLED_CONFIRM);
  }

  private clearActivityTimers(): void {
    if (this.busyCandidateTimer !== null) {
      clearTimeout(this.busyCandidateTimer);
      this.busyCandidateTimer = null;
    }
    if (this.busyConfirmTimer !== null) {
      clearTimeout(this.busyConfirmTimer);
      this.busyConfirmTimer = null;
    }
    if (this.mightNeedAttentionTimer !== null) {
      clearTimeout(this.mightNeedAttentionTimer);
      this.mightNeedAttentionTimer = null;
    }
    if (this.settledConfirmTimer !== null) {
      clearTimeout(this.settledConfirmTimer);
      this.settledConfirmTimer = null;
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
