import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';

describe('AlertManager in isolation', () => {
  let manager: AlertManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new AlertManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  // Timing from cfg.alert:
  // busyCandidateGap=1500, busyConfirmGap=500, mightNeedAttention=2000, needsAttentionConfirm=3000

  it('state machine advances through silence to ALERT_RINGING', () => {
    const id = 'test-pty';
    manager.toggleAlert(id);
    expect(manager.getState(id).status).toBe('NOTHING_TO_SHOW');

    // Simulate sustained output over 2 seconds
    manager.onData(id);
    vi.advanceTimersByTime(500);
    manager.onData(id);
    vi.advanceTimersByTime(500);
    manager.onData(id);
    vi.advanceTimersByTime(600); // 1600ms total — past busyCandidateGap
    manager.onData(id);
    manager.onData(id);
    expect(manager.getState(id).status).toBe('BUSY');

    // Clear attention so alert can ring
    manager.clearAttention(id);

    // Now silence — task finished. Advance past mightNeedAttention (2000ms)
    vi.advanceTimersByTime(2_000);
    expect(manager.getState(id).status).toBe('MIGHT_NEED_ATTENTION');

    // Advance past needsAttentionConfirm (3000ms)
    vi.advanceTimersByTime(3_000);
    expect(manager.getState(id).status).toBe('ALERT_RINGING');
  });

  it('reproduces the exact user scenario: alert set, 5s task, collapse after 2s, wait 60s', () => {
    const id = 'user-scenario';

    manager.toggleAlert(id);
    manager.clearAttention(id);

    for (let t = 0; t < 5_000; t += 200) {
      manager.onData(id);
      vi.advanceTimersByTime(200);
    }
    expect(manager.getState(id).status).toBe('BUSY');

    vi.advanceTimersByTime(60_000);

    expect(manager.getState(id).status).toBe('ALERT_RINGING');
  });

  it('ALERT_RINGING latches when user has no attention (view hidden)', () => {
    const id = 'latch-test';
    manager.toggleAlert(id);
    manager.clearAttention(id);

    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);
    expect(manager.getState(id).status).toBe('BUSY');

    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(3_000);
    expect(manager.getState(id).status).toBe('ALERT_RINGING');

    manager.onData(id);
    expect(manager.getState(id).status).toBe('ALERT_RINGING');

    for (let i = 0; i < 10; i++) {
      manager.onData(id);
      vi.advanceTimersByTime(200);
    }
    expect(manager.getState(id).status).toBe('ALERT_RINGING');

    manager.attend(id);
    manager.onData(id);
    expect(manager.getState(id).status).not.toBe('ALERT_RINGING');
  });

  it('ALERT_RINGING resets on data when user has attention', () => {
    const id = 'reset-test';
    manager.toggleAlert(id);

    manager.attend(id);
    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);

    manager.clearAttention(id);
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(3_000);
    expect(manager.getState(id).status).toBe('ALERT_RINGING');

    manager.attend(id);
    manager.onData(id);
    expect(manager.getState(id).status).not.toBe('ALERT_RINGING');
  });

  it('onStateChange fires when state transitions', () => {
    const id = 'test-notify';
    const states: string[] = [];
    manager.onStateChange((_id, state) => {
      if (_id === id) states.push(state.status);
    });

    manager.toggleAlert(id);
    manager.clearAttention(id);

    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);

    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(3_000);

    expect(states).toContain('BUSY');
    expect(states).toContain('MIGHT_NEED_ATTENTION');
    expect(states).toContain('ALERT_RINGING');
  });

  // --- Boolean TODO tests ---
  // (The previous soft-TODO bucket tests — 4-keypress letter-striking, per-letter
  //  recovery timers — were removed when TODO was simplified to a plain boolean.)

  function driveToRinging(id: string): void {
    manager.toggleAlert(id);
    manager.clearAttention(id);
    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(3_000);
    expect(manager.getState(id).status).toBe('ALERT_RINGING');
  }

  it('attending a ringing alert turns TODO on', () => {
    const id = 'attend-turns-todo-on';
    driveToRinging(id);
    manager.attend(id);
    expect(manager.getState(id).todo).toBe(true);
  });

  it('dismissing a ringing alert turns TODO on', () => {
    const id = 'dismiss-turns-todo-on';
    driveToRinging(id);
    manager.dismissAlert(id);
    expect(manager.getState(id).todo).toBe(true);
  });

  it('toggleTodo flips on and off', () => {
    const id = 'toggle-todo';
    expect(manager.getState(id).todo).toBe(false);
    manager.toggleTodo(id);
    expect(manager.getState(id).todo).toBe(true);
    manager.toggleTodo(id);
    expect(manager.getState(id).todo).toBe(false);
  });

  it('markTodo sets true; clearTodo sets false', () => {
    const id = 'mark-clear-todo';
    manager.markTodo(id);
    expect(manager.getState(id).todo).toBe(true);
    manager.clearTodo(id);
    expect(manager.getState(id).todo).toBe(false);
  });

  it('protocol notifications ring and create TODO detail even when visual alerts are disabled', () => {
    const id = 'osc-notification';

    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });

    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'OSC 9', title: null, body: 'Build finished' },
    });

    manager.dismissAlert(id);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_DISABLED',
      todo: true,
      notification: { source: 'OSC 9', title: null, body: 'Build finished' },
    });

    manager.clearTodo(id);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('OSC progress cocks the protocol alarm without participating in visual timers', () => {
    const id = 'osc-progress';

    manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
    expect(manager.getState(id)).toMatchObject({
      status: 'OSC_NOTIF_BUSY',
      todo: false,
      notification: null,
    });

    vi.advanceTimersByTime(60_000);
    expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

    manager.updateProtocolProgress(id, { state: 'clear', percent: null });
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'OSC 9;4', title: 'Progress complete', body: 'Progress 25%' },
    });
  });

  it('protocol completion is suppressed while the user has attention', () => {
    const id = 'osc-progress-attention';

    manager.attend(id);
    manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
    expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

    manager.updateProtocolProgress(id, { state: 'normal', percent: 100 });
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('direct protocol notifications are suppressed while the user has attention', () => {
    const id = 'osc-notification-attention';

    manager.attend(id);
    manager.notifyFromProtocol(id, { source: 'OSC 777', title: 'done', body: 'Build finished' });

    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_DISABLED',
      todo: false,
      notification: null,
    });
  });
});
