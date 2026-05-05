import { cfg } from '../cfg';

export type SessionStatus =
  | 'ALERT_DISABLED'
  | 'NOTHING_TO_SHOW'
  | 'MIGHT_BE_BUSY'
  | 'BUSY'
  | 'MIGHT_NEED_ATTENTION'
  | 'ALERT_RINGING';

export interface ActivityMonitorOptions {
  hasAttention?: () => boolean;
  onChange?: (status: SessionStatus, previousStatus: SessionStatus) => void;
}

const T_BUSY_CANDIDATE_GAP = cfg.alert.busyCandidateGap;
const T_BUSY_CONFIRM_GAP = cfg.alert.busyConfirmGap;
const T_MIGHT_NEED_ATTENTION = cfg.alert.mightNeedAttention;
const T_ALERT_RINGING_CONFIRM = cfg.alert.needsAttentionConfirm;
const T_RESIZE_DEBOUNCE = cfg.alert.resizeDebounce;

export class ActivityMonitor {
  private status: SessionStatus = 'NOTHING_TO_SHOW';
  private resizeGrace = false;
  private busyCandidateTimer: ReturnType<typeof setTimeout> | null = null;
  private busyConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private mightNeedAttentionTimer: ReturnType<typeof setTimeout> | null = null;
  private needsAttentionConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private firstOutputAt: number | null = null;
  private lastOutputAt: number | null = null;
  private outputCountSinceAttention = 0;
  private readonly hasAttention: () => boolean;
  private readonly onChange: ((status: SessionStatus, previousStatus: SessionStatus) => void) | null;

  constructor(options?: ActivityMonitorOptions) {
    this.hasAttention = options?.hasAttention ?? (() => false);
    this.onChange = options?.onChange ?? null;
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  attend(): void {
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
      case 'ALERT_RINGING':
        // Latch: don't reset the alert until the user has actually seen it.
        // hasAttention() is true when the user recently interacted with the pane.
        // If they haven't (view hidden, or just not focused), new output from
        // e.g. a shell prompt shouldn't silently dismiss the alert.
        if (!this.hasAttention()) return;
        this.firstOutputAt = now;
        this.outputCountSinceAttention = 1;
        this.enterMightBeBusy();
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
      this.outputCountSinceAttention = 1;
      this.startBusyCandidateTimer();
      return;
    }

    this.outputCountSinceAttention += 1;

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
      if (this.outputCountSinceAttention >= 2) {
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
      this.startNeedsAttentionConfirmTimer();
    }, T_MIGHT_NEED_ATTENTION);
  }

  private startNeedsAttentionConfirmTimer(): void {
    this.needsAttentionConfirmTimer = setTimeout(() => {
      this.needsAttentionConfirmTimer = null;
      if (this.status !== 'MIGHT_NEED_ATTENTION') return;
      if (this.hasAttention()) {
        this.attend();
        return;
      }
      this.resetOutputTracking();
      this.setStatus('ALERT_RINGING');
    }, T_ALERT_RINGING_CONFIRM);
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
    if (this.needsAttentionConfirmTimer !== null) {
      clearTimeout(this.needsAttentionConfirmTimer);
      this.needsAttentionConfirmTimer = null;
    }
  }

  private seedFromLatestOutput(): void {
    if (this.lastOutputAt === null) {
      this.resetOutputTracking();
      return;
    }
    this.firstOutputAt = this.lastOutputAt;
    this.outputCountSinceAttention = 1;
    this.startBusyCandidateTimer();
  }

  private resetOutputTracking(): void {
    this.firstOutputAt = null;
    this.lastOutputAt = null;
    this.outputCountSinceAttention = 0;
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    const previousStatus = this.status;
    this.status = status;
    this.onChange?.(status, previousStatus);
  }
}
