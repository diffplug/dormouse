import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityMonitor, type SessionStatus } from './activity-monitor';

// Timing constants from cfg.alert:
// busyCandidateGap=1500, busyConfirmGap=500, mightNeedAttention=2000, needsAttentionConfirm=3000, resizeDebounce=500

describe('ActivityMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createMonitor() {
    const attention = { current: false };
    const changes: SessionStatus[] = [];
    const monitor = new ActivityMonitor({
      hasAttention: () => attention.current,
      onChange: (status) => changes.push(status),
    });
    return { monitor, changes, attention };
  }

  function driveMonitorToBusy(monitor: ActivityMonitor) {
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    monitor.onData();
    expect(monitor.getStatus()).toBe('BUSY');
  }

  function driveMonitorToMightNeedAttention(monitor: ActivityMonitor) {
    driveMonitorToBusy(monitor);
    vi.advanceTimersByTime(2_000);
    expect(monitor.getStatus()).toBe('MIGHT_NEED_ATTENTION');
  }

  function driveMonitorToNeedsAttention(monitor: ActivityMonitor) {
    driveMonitorToMightNeedAttention(monitor);
    vi.advanceTimersByTime(3_000);
    expect(monitor.getStatus()).toBe('ALERT_RINGING');
  }

  it('starts in NOTHING_TO_SHOW', () => {
    const { monitor } = createMonitor();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
  });

  it('keeps the first meaningful output after attention in NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    monitor.attend();
    monitor.onData();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([]);
  });

  it('enters MIGHT_BE_BUSY when a later output arrives after the candidate gap', () => {
    const { monitor, changes } = createMonitor();
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    expect(monitor.getStatus()).toBe('MIGHT_BE_BUSY');
    expect(changes).toEqual(['MIGHT_BE_BUSY']);
  });

  it('can also enter MIGHT_BE_BUSY from dense output once the candidate timer matures', () => {
    const { monitor, changes } = createMonitor();
    monitor.onData();
    vi.advanceTimersByTime(750);
    monitor.onData();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    vi.advanceTimersByTime(750);
    expect(monitor.getStatus()).toBe('MIGHT_BE_BUSY');
    expect(changes).toEqual(['MIGHT_BE_BUSY']);
  });

  it('confirms MIGHT_BE_BUSY into BUSY on further output', () => {
    const { monitor, changes } = createMonitor();
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    monitor.onData();
    expect(monitor.getStatus()).toBe('BUSY');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'BUSY']);
  });

  it('falls back from MIGHT_BE_BUSY to NOTHING_TO_SHOW if work is not confirmed', () => {
    const { monitor, changes } = createMonitor();
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    expect(monitor.getStatus()).toBe('MIGHT_BE_BUSY');
    vi.advanceTimersByTime(500);
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'NOTHING_TO_SHOW']);
  });

  it('transitions BUSY to MIGHT_NEED_ATTENTION after silence', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'BUSY', 'MIGHT_NEED_ATTENTION']);
  });

  it('transitions MIGHT_NEED_ATTENTION to ALERT_RINGING after sustained silence', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToNeedsAttention(monitor);
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'ALERT_RINGING',
    ]);
  });

  it('returns to NOTHING_TO_SHOW instead of ALERT_RINGING if attention is still present', () => {
    const { monitor, changes, attention } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    attention.current = true;
    vi.advanceTimersByTime(3_000);
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'NOTHING_TO_SHOW',
    ]);
  });

  it('returns from MIGHT_NEED_ATTENTION to BUSY when output resumes', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    monitor.onData();
    expect(monitor.getStatus()).toBe('BUSY');
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'BUSY',
    ]);
  });

  it('treats new output from ALERT_RINGING as a new MIGHT_BE_BUSY cycle (when attended)', () => {
    const { monitor, changes, attention } = createMonitor();
    driveMonitorToNeedsAttention(monitor);
    // User sees the alert (sets attention), then new output resets
    attention.current = true;
    monitor.onData();
    expect(monitor.getStatus()).toBe('MIGHT_BE_BUSY');
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'ALERT_RINGING',
      'MIGHT_BE_BUSY',
    ]);
  });

  it('latches in ALERT_RINGING when new output arrives without attention', () => {
    const { monitor } = createMonitor();
    driveMonitorToNeedsAttention(monitor);
    expect(monitor.getStatus()).toBe('ALERT_RINGING');
    // No attention — alert should latch
    monitor.onData();
    expect(monitor.getStatus()).toBe('ALERT_RINGING');
  });

  it('attend() resets BUSY work back to NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToBusy(monitor);
    monitor.attend();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'BUSY', 'NOTHING_TO_SHOW']);
  });

  it('attend() resets ALERT_RINGING back to NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToNeedsAttention(monitor);
    monitor.attend();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'ALERT_RINGING',
      'NOTHING_TO_SHOW',
    ]);
  });

  it('attend() resets MIGHT_BE_BUSY back to NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    expect(monitor.getStatus()).toBe('MIGHT_BE_BUSY');
    monitor.attend();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'NOTHING_TO_SHOW']);
  });

  it('attend() resets MIGHT_NEED_ATTENTION back to NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    monitor.attend();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'NOTHING_TO_SHOW',
    ]);
  });

  it('onResize suppresses output detection for 500ms', () => {
    const { monitor, changes } = createMonitor();
    monitor.onResize();
    monitor.onData();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([]);
  });

  it('output after the resize debounce participates in busy detection normally', () => {
    const { monitor, changes } = createMonitor();
    monitor.onResize();
    vi.advanceTimersByTime(500);
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    expect(monitor.getStatus()).toBe('MIGHT_BE_BUSY');
    expect(changes).toEqual(['MIGHT_BE_BUSY']);
  });

  it('resets the BUSY silence timer when more output arrives', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToBusy(monitor);
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'BUSY']);
    vi.advanceTimersByTime(1_500);
    expect(monitor.getStatus()).toBe('BUSY');
    vi.advanceTimersByTime(500);
    expect(monitor.getStatus()).toBe('MIGHT_NEED_ATTENTION');
  });

  it('dispose() clears outstanding timers', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToBusy(monitor);
    monitor.dispose();
    vi.advanceTimersByTime(20_000);
    expect(monitor.getStatus()).toBe('BUSY');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'BUSY']);
  });

  it('does not emit changes after dispose', () => {
    const onChange = vi.fn();
    const monitor = new ActivityMonitor({ onChange });
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    monitor.dispose();
    vi.advanceTimersByTime(20_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('MIGHT_BE_BUSY', 'NOTHING_TO_SHOW');
  });
});
