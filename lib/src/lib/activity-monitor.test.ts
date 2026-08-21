import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityMonitor, type QuiesceStatus } from './activity-monitor';

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
    const changes: QuiesceStatus[] = [];
    const settled = vi.fn();
    const monitor = new ActivityMonitor({
      onChange: (status) => changes.push(status),
      onSettled: settled,
    });
    return { monitor, changes, settled };
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

  it('starts in NOTHING_TO_SHOW', () => {
    const { monitor } = createMonitor();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
  });

  it('keeps the first meaningful output after a reset in NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    monitor.reset();
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
    const { monitor, changes, settled } = createMonitor();
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    expect(monitor.getStatus()).toBe('MIGHT_BE_BUSY');
    vi.advanceTimersByTime(500);
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'NOTHING_TO_SHOW']);
    // Work that never became BUSY never settles.
    expect(settled).not.toHaveBeenCalled();
  });

  it('transitions BUSY to MIGHT_NEED_ATTENTION after silence', () => {
    const { monitor, changes, settled } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'BUSY', 'MIGHT_NEED_ATTENTION']);
    expect(settled).not.toHaveBeenCalled();
  });

  it('settles after sustained silence and returns to NOTHING_TO_SHOW', () => {
    const { monitor, changes, settled } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    vi.advanceTimersByTime(3_000);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'NOTHING_TO_SHOW',
    ]);
  });

  it('reports the settle before announcing the return to NOTHING_TO_SHOW', () => {
    // Order matters: an owner that latches a ring in onSettled must already own
    // the projection by the time subscribers hear about NOTHING_TO_SHOW.
    const order: string[] = [];
    const monitor = new ActivityMonitor({
      onChange: (status) => order.push(`change:${status}`),
      onSettled: () => order.push('settled'),
    });
    driveMonitorToMightNeedAttention(monitor);
    vi.advanceTimersByTime(3_000);
    expect(order).toEqual([
      'change:MIGHT_BE_BUSY',
      'change:BUSY',
      'change:MIGHT_NEED_ATTENTION',
      'settled',
      'change:NOTHING_TO_SHOW',
    ]);
  });

  it('does not double-report NOTHING_TO_SHOW when the settled handler resets it', () => {
    const changes: QuiesceStatus[] = [];
    let monitor: ActivityMonitor | null = null;
    monitor = new ActivityMonitor({
      onChange: (status) => changes.push(status),
      onSettled: () => monitor?.reset(),
    });
    driveMonitorToMightNeedAttention(monitor);
    vi.advanceTimersByTime(3_000);
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'NOTHING_TO_SHOW',
    ]);
  });

  it('settles once per busy cycle, not once per silent interval', () => {
    const { monitor, settled } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    vi.advanceTimersByTime(60_000);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('runs a fresh cycle after settling, and settles again', () => {
    const { monitor, settled } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    vi.advanceTimersByTime(3_000);
    expect(settled).toHaveBeenCalledTimes(1);

    driveMonitorToBusy(monitor);
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(3_000);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
  });

  it('returns from MIGHT_NEED_ATTENTION to BUSY when output resumes, without settling', () => {
    const { monitor, changes, settled } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    monitor.onData();
    expect(monitor.getStatus()).toBe('BUSY');
    vi.advanceTimersByTime(3_000);
    expect(settled).not.toHaveBeenCalled();
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
    ]);
  });

  it('reset() cancels a pending settle', () => {
    const { monitor, settled } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    monitor.reset();
    vi.advanceTimersByTime(60_000);
    expect(settled).not.toHaveBeenCalled();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
  });

  it('reset() returns BUSY work to NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToBusy(monitor);
    monitor.reset();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'BUSY', 'NOTHING_TO_SHOW']);
  });

  it('reset() returns MIGHT_BE_BUSY to NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    monitor.onData();
    vi.advanceTimersByTime(1_500);
    monitor.onData();
    expect(monitor.getStatus()).toBe('MIGHT_BE_BUSY');
    monitor.reset();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'NOTHING_TO_SHOW']);
  });

  it('reset() returns MIGHT_NEED_ATTENTION to NOTHING_TO_SHOW', () => {
    const { monitor, changes } = createMonitor();
    driveMonitorToMightNeedAttention(monitor);
    monitor.reset();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([
      'MIGHT_BE_BUSY',
      'BUSY',
      'MIGHT_NEED_ATTENTION',
      'NOTHING_TO_SHOW',
    ]);
  });

  it('reset() forgets output history, so the next output starts candidate tracking over', () => {
    const { monitor, changes } = createMonitor();
    monitor.onData();
    vi.advanceTimersByTime(1_400);
    monitor.reset();
    // Under the old history this second chunk would be past the candidate gap.
    vi.advanceTimersByTime(200);
    monitor.onData();
    expect(monitor.getStatus()).toBe('NOTHING_TO_SHOW');
    expect(changes).toEqual([]);
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
    const { monitor, changes, settled } = createMonitor();
    driveMonitorToBusy(monitor);
    monitor.dispose();
    vi.advanceTimersByTime(20_000);
    expect(monitor.getStatus()).toBe('BUSY');
    expect(changes).toEqual(['MIGHT_BE_BUSY', 'BUSY']);
    expect(settled).not.toHaveBeenCalled();
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
