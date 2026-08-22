import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager, AWAIT_GRACE_MS, DEFAULT_ALERT_STATE, MAX_AWAIT_TIMEOUT_MS } from './alert-manager';
import type { AwaitHandle, AwaitOutcome, CompletionEvent } from './alert-manager';
import { applyTerminalProtocolEvents } from './terminal-protocol';

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

  /**
   * WATCHING is keyed on the foreground command's name, so the only way to turn
   * it on is to run a watched command (`docs/specs/alert.md`).
   */
  function runWatchedCommand(id: string, commandLine = 'longtask'): void {
    manager.setWatchedCommands(['longtask']);
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
  }

  it('state machine advances through silence to ALERT_RINGING', () => {
    const id = 'test-pty';
    runWatchedCommand(id);
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

    runWatchedCommand(id);
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
    runWatchedCommand(id);
    manager.clearAttention(id);

    driveToBusy(id);
    expect(manager.getState(id).status).toBe('BUSY');

    settle();
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
    runWatchedCommand(id);

    manager.attend(id);
    driveToBusy(id);

    manager.clearAttention(id);
    settle();
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

    runWatchedCommand(id);
    manager.clearAttention(id);

    driveToBusy(id);

    settle();

    expect(states).toContain('BUSY');
    expect(states).toContain('MIGHT_NEED_ATTENTION');
    expect(states).toContain('ALERT_RINGING');
  });

  // --- Boolean TODO tests ---
  // (The previous soft-TODO bucket tests — 4-keypress letter-striking, per-letter
  //  recovery timers — were removed when TODO was simplified to a plain boolean.)

  /** Two output bursts across the busy-candidate gap: NOTHING_TO_SHOW -> BUSY. */
  function driveToBusy(id: string): void {
    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);
  }

  /** Silence through both quiet windows: BUSY -> MIGHT_NEED_ATTENTION -> settled. */
  function settle(): void {
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(3_000);
  }

  /** Register a claimant that records every event it is offered and answers `claims`. */
  function recordingClaimant(id: string, claims: boolean): CompletionEvent[] {
    const seen: CompletionEvent[] = [];
    manager.registerCompletionClaimant(id, (event) => {
      seen.push(event);
      return claims;
    });
    return seen;
  }

  function driveToRinging(id: string): void {
    runWatchedCommand(id);
    manager.clearAttention(id);
    driveToBusy(id);
    settle();
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

  it('protocol notifications ring and create TODO detail even when WATCHING is disabled', () => {
    const id = 'osc-notification';

    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });

    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'OSC 9', title: null, body: 'Build finished' },
    });

    manager.dismissAlert(id);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: true,
      notification: { source: 'OSC 9', title: null, body: 'Build finished' },
    });

    manager.clearTodo(id);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('terminal bell notifications ring and create TODO detail even when WATCHING is disabled', () => {
    const id = 'terminal-bell';

    applyTerminalProtocolEvents(manager, id, [
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);

    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'BEL', title: 'Terminal bell', body: null },
    });
  });

  it('OSC progress cocks the protocol alarm without participating in visual timers', () => {
    const id = 'osc-progress';

    manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
    expect(manager.getState(id)).toMatchObject({
      status: 'OSC_NOTIF_BUSY',
      watchingEnabled: false,
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

  it('dropping the rule only turns WATCHING off, leaving protocol progress armed', () => {
    const id = 'osc-progress-drop-rule';

    runWatchedCommand(id);
    manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
    expect(manager.getState(id)).toMatchObject({
      status: 'OSC_NOTIF_BUSY',
      watchingEnabled: true,
    });

    manager.setWatchedCommands([]);
    expect(manager.getState(id)).toMatchObject({
      status: 'OSC_NOTIF_BUSY',
      watchingEnabled: false,
    });
  });

  it('attending a ring leaves attentionDismissedRing for the bell table to consume', () => {
    const id = 'attention-dismissed-watching-disabled';

    // A protocol ring needs no WATCHING; attending it dismisses the ring and
    // sets attentionDismissedRing while status falls back to WATCHING_DISABLED.
    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });
    expect(manager.getState(id).status).toBe('ALERT_RINGING');
    manager.attend(id);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: true,
      attentionDismissedRing: true,
    });

    // An explicit dismiss is the click that consumes the flag.
    manager.dismissAlert(id);
    expect(manager.getState(id).attentionDismissedRing).toBe(false);
  });

  it('keeps attentionDismissedRing when a watched command starts before bell dismissal', () => {
    const id = 'attention-dismissed-then-watched-command';
    manager.setWatchedCommands(['claude']);
    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });
    manager.attend(id);

    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'claude --resume' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);

    expect(manager.getState(id)).toMatchObject({
      watchingEnabled: true,
      todo: true,
      attentionDismissedRing: true,
    });

    manager.dismissAlert(id);
    expect(manager.getState(id).attentionDismissedRing).toBe(false);
  });

  it('protocol completion is suppressed while the user has attention', () => {
    const id = 'osc-progress-attention';

    manager.attend(id);
    manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
    expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

    manager.updateProtocolProgress(id, { state: 'normal', percent: 100 });
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('direct protocol notifications are suppressed while the user has attention', () => {
    const id = 'osc-notification-attention';

    manager.attend(id);
    manager.notifyFromProtocol(id, { source: 'OSC 777', title: 'done', body: 'Build finished' });

    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('attended direct notifications do not clear active protocol progress', () => {
    const id = 'osc-progress-with-attended-notification';

    manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
    expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

    manager.attend(id);
    manager.notifyFromProtocol(id, { source: 'OSC 777', title: 'done', body: 'Build finished' });

    expect(manager.getState(id)).toMatchObject({
      status: 'OSC_NOTIF_BUSY',
      todo: false,
      notification: null,
    });
  });

  it('terminal bell notifications are suppressed while the user has attention', () => {
    const id = 'terminal-bell-attention';

    manager.attend(id);
    applyTerminalProtocolEvents(manager, id, [
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);

    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('arms and rings when an attended command loses attention before exiting', () => {
    const id = 'command-exit';

    manager.attend(id);
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'pnpm build' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);

    vi.advanceTimersByTime(15_000);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'COMMAND_EXIT', title: 'Command finished', body: 'pnpm build exited 0' },
    });
  });

  it('finishes an armed command-exit watch when the PTY exits without commandFinish', () => {
    const id = 'command-exit-pty-exit';

    manager.attend(id);
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'exec pnpm build' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);

    vi.advanceTimersByTime(15_000);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

    manager.onExit(id, 1);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'COMMAND_EXIT', title: 'Command finished', body: 'exec pnpm build exited 1' },
    });
  });

  it('clears an unarmed command-exit watch when the PTY exits before attention loss', () => {
    const id = 'command-exit-pty-exit-unarmed';

    manager.attend(id);
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'exec true' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);

    manager.onExit(id, 0);
    vi.advanceTimersByTime(15_000);

    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('does not ring command-exit alerts for commands shorter than the attention window', () => {
    const id = 'quick-command-exit';

    manager.attend(id);
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'git status' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    manager.clearAttention(id);

    vi.advanceTimersByTime(1_000);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('disarms command-exit alerts when the user returns before finish', () => {
    const id = 'command-exit-return';

    manager.attend(id);
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'pnpm test' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    vi.advanceTimersByTime(15_000);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

    manager.attend(id);
    expect(manager.getState(id).status).toBe('WATCHING_DISABLED');

    vi.advanceTimersByTime(1_000);
    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  // --- Command-keyed WATCHING ---

  it('turns WATCHING on for a watched command and off again when it finishes', () => {
    const id = 'rule-lifecycle';
    manager.setWatchedCommands(['claude']);
    expect(manager.getState(id).watchingEnabled).toBe(false);

    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'claude --print hello' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    expect(manager.getState(id).watchingEnabled).toBe(true);

    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
    expect(manager.getState(id).watchingEnabled).toBe(false);
  });

  it('notifies subscribers when WATCHING turns off as a watched command finishes', () => {
    const id = 'rule-finish-notify';
    manager.setWatchedCommands(['claude']);

    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'claude' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    expect(manager.getState(id).watchingEnabled).toBe(true);

    // Subscribe after the command has started so we only capture the finish.
    const watching: boolean[] = [];
    manager.onStateChange((_id, state) => {
      if (_id === id) watching.push(state.watchingEnabled);
    });

    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);

    expect(manager.getState(id).watchingEnabled).toBe(false);
    // The off-transition must reach subscribers, not just live getState reads.
    expect(watching).toContain(false);
  });

  it('matches on the bare program name, not the whole command line', () => {
    const id = 'rule-argv0';
    manager.setWatchedCommands(['claude']);

    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'FOO=1 env BAR=2 /usr/local/bin/claude --resume' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    expect(manager.getState(id).watchingEnabled).toBe(true);
  });

  it('leaves an unwatched command alone', () => {
    const id = 'rule-miss';
    manager.setWatchedCommands(['claude']);

    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'git status' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    expect(manager.getState(id).watchingEnabled).toBe(false);
  });

  it('turns WATCHING off at the prompt even without a finish event', () => {
    const id = 'rule-prompt';
    runWatchedCommand(id);
    expect(manager.getState(id).watchingEnabled).toBe(true);

    manager.applyTerminalSemanticEvents(id, [{ type: 'promptStart' }]);
    expect(manager.getState(id).watchingEnabled).toBe(false);
  });

  it('applies a newly added rule to every session already running that command', () => {
    const a = 'rule-live-a';
    const b = 'rule-live-b';
    for (const id of [a, b]) {
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine: 'claude' },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);
    }
    expect(manager.getState(a).watchingEnabled).toBe(false);
    expect(manager.getState(b).watchingEnabled).toBe(false);

    manager.setWatchedCommands(['claude']);
    expect(manager.getState(a).watchingEnabled).toBe(true);
    expect(manager.getState(b).watchingEnabled).toBe(true);

    manager.setWatchedCommands([]);
    expect(manager.getState(a).watchingEnabled).toBe(false);
    expect(manager.getState(b).watchingEnabled).toBe(false);
  });

  it('keeps a WATCHING ring after the watched command exits and takes watching with it', () => {
    const id = 'ring-outlives-command';
    driveToRinging(id);

    // The command exiting turns WATCHING off; the ring it already raised is
    // the whole point of watching, so it has to survive.
    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      watchingEnabled: false,
    });

    manager.dismissAlert(id);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: true,
    });
  });

  it('silences a WATCHING ring when the rule is explicitly removed', () => {
    const id = 'ring-dies-with-rule';
    driveToRinging(id);

    // Unlike the command ending, dropping the rule is the user saying "stop
    // alerting on this" — the ring goes with it.
    manager.setWatchedCommands([]);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      watchingEnabled: false,
      todo: false,
    });
  });

  it('silences a latched WATCHING ring when its rule is removed after command exit', () => {
    const id = 'exited-ring-dies-with-rule';
    driveToRinging(id);
    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);

    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      watchingEnabled: false,
    });

    manager.setWatchedCommands([]);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      watchingEnabled: false,
      todo: false,
    });
  });

  // --- The always-on detector vs. the rule set as pure policy ---

  it('drives the detector on an unwatched Session without showing it or ringing', () => {
    const id = 'unwatched-detector';
    manager.setWatchedCommands(['claude']);
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'git log' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    manager.clearAttention(id);

    driveToBusy(id);
    // The detector is BUSY underneath, but no rule matches, so nothing shows.
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      watchingEnabled: false,
    });

    // ... and a settle on an unwatched Session never rings the human.
    settle();
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('shows the live detector state when a rule is enabled mid-command', () => {
    const id = 'enable-rule-mid-busy';
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'claude' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    manager.clearAttention(id);

    driveToBusy(id);
    expect(manager.getState(id).status).toBe('WATCHING_DISABLED');

    // Turning the rule on mid-run reveals what the detector already knows
    // rather than restarting it from NOTHING_TO_SHOW.
    manager.setWatchedCommands(['claude']);
    expect(manager.getState(id)).toMatchObject({
      status: 'BUSY',
      watchingEnabled: true,
    });
  });

  it('suppresses a WATCHING ring when the user is attending at the settle', () => {
    const id = 'settle-while-attended';
    runWatchedCommand(id);
    manager.attend(id);

    driveToBusy(id);
    expect(manager.getState(id).status).toBe('BUSY');

    settle();
    // Total elapsed is under the 15s attention window, so the user is still
    // looking: no ring, and the detector simply starts over.
    expect(manager.getState(id)).toMatchObject({
      status: 'NOTHING_TO_SHOW',
      watchingEnabled: true,
      todo: false,
      notification: null,
    });
  });

  it('keeps a latched ring through post-exit output and drops it with the rule', () => {
    const id = 'latched-ring-vs-live-detector';
    driveToRinging(id);
    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);

    // The detector keeps running after the command ends, so shell-prompt output
    // can drive a whole extra busy/settle cycle. Neither the output nor the
    // unwatched settle may disturb the ring the watched run already raised.
    driveToBusy(id);
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      watchingEnabled: false,
    });

    manager.setWatchedCommands([]);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      watchingEnabled: false,
      todo: false,
    });
  });

  it('keeps the command-exit arm hidden while WATCHING owns the display', () => {
    const id = 'arm-under-watching';
    runWatchedCommand(id);
    manager.attend(id);
    manager.clearAttention(id);

    // Armed underneath, but the monitor's own state is what the bell shows.
    expect(manager.getState(id).status).toBe('NOTHING_TO_SHOW');

    manager.setWatchedCommands([]);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');
  });

  it('preserves richer protocol detail when protocol and command exit both ring', () => {
    const id = 'command-exit-protocol-wins';

    manager.attend(id);
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine: 'pnpm build' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    vi.advanceTimersByTime(15_000);

    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });
    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);

    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'OSC 9', title: null, body: 'Build finished' },
    });
  });

  // --- Configurable inactivity timeout (`docs/specs/alert.md` -> Alarm settings) ---

  describe('setInactivityTimeoutMs', () => {
    it('expires attention on the configured window instead of the default 15s', () => {
      const id = 'short-window';
      manager.setInactivityTimeoutMs(3_000);

      manager.attend(id);
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine: 'pnpm build' },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);

      vi.advanceTimersByTime(2_999);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');

      vi.advanceTimersByTime(1);
      expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');
    });

    it('gates the command-exit minimum runtime on the same window', () => {
      const id = 'short-runtime-gate';
      manager.setInactivityTimeoutMs(3_000);

      manager.attend(id);
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine: 'git status' },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);
      manager.clearAttention(id);

      // Under the default 15s window this runtime would be too short to ring.
      vi.advanceTimersByTime(4_000);
      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);

      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        notification: { source: 'COMMAND_EXIT', body: 'git status exited 0' },
      });
    });

    it('re-arms a live attention timer so a shortened window applies immediately', () => {
      const id = 're-arm';

      manager.attend(id);
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine: 'pnpm build' },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);

      vi.advanceTimersByTime(10_000);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');

      // Shortening mid-window restarts the countdown from now rather than
      // firing instantly or waiting out the original 15s.
      manager.setInactivityTimeoutMs(3_000);
      vi.advanceTimersByTime(2_999);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');

      vi.advanceTimersByTime(1);
      expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');
    });

    it('ignores a nonsensical value rather than installing a broken timer', () => {
      const id = 'bad-value';
      manager.setInactivityTimeoutMs(Number.NaN);
      manager.setInactivityTimeoutMs(0);
      manager.setInactivityTimeoutMs(-1);

      manager.attend(id);
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine: 'pnpm build' },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);

      vi.advanceTimersByTime(14_999);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');
      vi.advanceTimersByTime(1);
      expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');
    });
  });

  // --- Completion events (`docs/specs/alert.md` -> Completion events) ---

  describe('completion events', () => {
    it('claiming a settle keeps the WATCHING ring from ever latching', () => {
      const id = 'claim-settle';
      const seen = recordingClaimant(id, true);

      runWatchedCommand(id);
      manager.clearAttention(id);
      driveToBusy(id);
      settle();

      expect(seen).toEqual([{ kind: 'settled' }]);
      // The detector reported the settle and started over; nothing latched.
      expect(manager.getState(id)).toMatchObject({
        status: 'NOTHING_TO_SHOW',
        watchingEnabled: true,
        todo: false,
        notification: null,
      });
    });

    it('declining a settle rings exactly as if no claimant existed', () => {
      const id = 'decline-settle';
      const seen = recordingClaimant(id, false);

      runWatchedCommand(id);
      manager.clearAttention(id);
      driveToBusy(id);
      settle();

      expect(seen).toEqual([{ kind: 'settled' }]);
      expect(manager.getState(id).status).toBe('ALERT_RINGING');
    });

    it('reports a short attended command finish that could never ring', () => {
      const id = 'observe-quick-command';
      const seen = recordingClaimant(id, false);

      manager.attend(id);
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine: 'npm test' },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);
      vi.advanceTimersByTime(1_000);
      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);

      expect(seen).toEqual([{
        kind: 'commandFinished',
        displayCommand: 'npm test',
        argv0: 'npm',
        exitCode: 0,
        ranMs: 1_000,
        armed: false,
      }]);
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });
    });

    it('claiming an armed command finish suppresses the COMMAND_EXIT ring', () => {
      const id = 'claim-command-exit';
      const seen = recordingClaimant(id, true);

      manager.attend(id);
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine: 'pnpm build' },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);
      vi.advanceTimersByTime(15_000);
      expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);

      expect(seen).toEqual([{
        kind: 'commandFinished',
        displayCommand: 'pnpm build',
        argv0: 'pnpm',
        exitCode: 0,
        ranMs: 15_000,
        armed: true,
      }]);
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });
    });

    it('claiming a direct notification leaves no ring, TODO, or detail behind', () => {
      const id = 'claim-notification';
      const seen = recordingClaimant(id, true);

      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });

      expect(seen).toEqual([
        { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Build finished' } },
      ]);
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });
    });

    it('claiming a progress completion still clears the cycle', () => {
      const id = 'claim-progress';
      const seen = recordingClaimant(id, true);

      manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
      expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

      manager.updateProtocolProgress(id, { state: 'normal', percent: 100 });

      expect(seen).toEqual([{
        kind: 'notification',
        notification: { source: 'OSC 9;4', title: 'Progress complete', body: 'Progress 100%' },
      }]);
      // The cycle is over whether or not anyone claimed it, so OSC_NOTIF_BUSY
      // must fall back rather than stick.
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });
    });

    it('stops delivering after unregister and never crosses Sessions', () => {
      const a = 'claimant-session-a';
      const b = 'claimant-session-b';
      const seen: CompletionEvent[] = [];
      const unregister = manager.registerCompletionClaimant(a, (event) => {
        seen.push(event);
        return true;
      });

      manager.notifyFromProtocol(b, { source: 'OSC 9', title: null, body: 'not yours' });
      expect(seen).toEqual([]);
      expect(manager.getState(b).status).toBe('ALERT_RINGING');

      manager.notifyFromProtocol(a, { source: 'OSC 9', title: null, body: 'yours' });
      expect(seen).toHaveLength(1);
      expect(manager.getState(a).status).toBe('WATCHING_DISABLED');

      unregister();
      manager.notifyFromProtocol(a, { source: 'OSC 9', title: null, body: 'after unregister' });
      expect(seen).toHaveLength(1);
      expect(manager.getState(a).status).toBe('ALERT_RINGING');
    });

    it('offers claimants in registration order and stops at the first claim', () => {
      const id = 'claimant-order';
      const calls: string[] = [];
      manager.registerCompletionClaimant(id, () => {
        calls.push('first');
        return false;
      });
      manager.registerCompletionClaimant(id, () => {
        calls.push('second');
        return true;
      });
      manager.registerCompletionClaimant(id, () => {
        calls.push('third');
        return true;
      });

      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });

      expect(calls).toEqual(['first', 'second']);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');
    });

    it('dispatches the command finish on PTY exit before any ring rule runs', () => {
      const id = 'pty-exit-dispatch';
      const seen: Array<{ event: CompletionEvent; ringing: boolean; todo: boolean }> = [];
      manager.registerCompletionClaimant(id, (event) => {
        const state = manager.getState(id);
        seen.push({ event, ringing: state.status === 'ALERT_RINGING', todo: state.todo });
        return false;
      });

      manager.attend(id);
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine: 'pnpm build' },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);
      vi.advanceTimersByTime(15_000);
      expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

      manager.onExit(id, 1);

      expect(seen).toEqual([{
        event: {
          kind: 'commandFinished',
          displayCommand: 'pnpm build',
          argv0: 'pnpm',
          exitCode: 1,
          ranMs: 15_000,
          armed: true,
        },
        ringing: false,
        todo: false,
      }]);
      // Declined, so the ring rule still ran afterwards.
      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        todo: true,
        notification: { source: 'COMMAND_EXIT', title: 'Command finished', body: 'pnpm build exited 1' },
      });
    });
  });

  // --- Await (`docs/specs/alert.md` -> Await) ---

  describe('awaitCompletion', () => {
    it('keeps the grace window at the 2s the dor await narrative prints', () => {
      // `dor/src/commands/await.ts` renders GRACE_WINDOW_TEXT = '2s' as a literal
      // because the CLI bundle cannot import lib. Moving cfg.alert.busyCandidateGap
      // or busyConfirmGap must fail here rather than leave that text silently wrong.
      expect(AWAIT_GRACE_MS).toBe(2_000);
    });

    /** Long enough that no test below reaches it by accident. */
    const NEVER = 600_000;

    /**
     * Watch a parked await without blocking on it: the reader flushes
     * microtasks and answers `null` while the await is still waiting.
     */
    function watch(handle: AwaitHandle): () => Promise<AwaitOutcome | null> {
      let seen: AwaitOutcome | null = null;
      void handle.promise.then((outcome) => {
        seen = outcome;
      });
      return async () => {
        await Promise.resolve();
        await Promise.resolve();
        return seen;
      };
    }

    /** A command start with no WATCHING rule behind it, so nothing settles into a ring. */
    function runCommand(id: string, commandLine = 'pnpm build'): void {
      manager.applyTerminalSemanticEvents(id, [
        { type: 'commandLine', commandLine },
        { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
      ]);
    }

    // 1. Already ringing at call time.

    it('resolves on a protocol ring already latched, consuming only that track', async () => {
      const id = 'await-standing-bell';
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });
      expect(manager.getState(id)).toMatchObject({ status: 'ALERT_RINGING', todo: true });

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });

      expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'bell', waitedMs: 0 });
      // The ring is gone; the human's TODO and its detail are not the await's to take.
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: true,
        notification: { source: 'OSC 9', title: null, body: 'Build finished' },
        attentionDismissedRing: false,
        awaited: false,
      });
    });

    it('resolves on a latched WATCHING ring without inventing a TODO', async () => {
      const id = 'await-standing-quiet';
      driveToRinging(id);
      expect(manager.getState(id).todo).toBe(false);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });

      expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'quiet', waitedMs: 0 });
      expect(manager.getState(id)).toMatchObject({
        status: 'NOTHING_TO_SHOW',
        watchingEnabled: true,
        todo: false,
        notification: null,
      });
    });

    it('resolves on a latched command-exit ring under either wake condition', async () => {
      for (const until of ['quiet', 'exit'] as const) {
        const id = `await-standing-exit-${until}`;
        manager.attend(id);
        runCommand(id);
        vi.advanceTimersByTime(15_000);
        manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
        expect(manager.getState(id)).toMatchObject({ status: 'ALERT_RINGING', todo: true });

        const handle = manager.awaitCompletion(id, { until, timeoutMs: NEVER });

        expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'exit', waitedMs: 0 });
        expect(manager.getState(id)).toMatchObject({
          status: 'WATCHING_DISABLED',
          todo: true,
          notification: { source: 'COMMAND_EXIT', title: 'Command finished', body: 'pnpm build exited 0' },
        });
      }
    });

    it('leaves a stale command-exit ring alone while a new command is running', async () => {
      const id = 'await-stale-exit-ring';
      manager.attend(id);
      runCommand(id);
      vi.advanceTimersByTime(15_000);
      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
      expect(manager.getState(id).status).toBe('ALERT_RINGING');

      // A second command starts. The latched ring above belongs to the first —
      // `startCommandExitWatch` preserves `ALERT_RINGING` on purpose — so it
      // cannot be an answer about the one now running.
      runCommand(id, 'npm test');

      const handle = manager.awaitCompletion(id, { until: 'exit', timeoutMs: NEVER });
      const outcome = watch(handle);
      expect(await outcome()).toBeNull();
      // Not consumed either: the ring is still the human's.
      expect(manager.getState(id).status).toBe('ALERT_RINGING');

      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
      expect(await outcome()).toMatchObject({ kind: 'resolved', cause: 'exit' });
    });

    it('leaves a standing bell alone under --until exit and keeps waiting', async () => {
      const id = 'await-exit-ignores-standing-bell';
      runCommand(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'warning' });

      const handle = manager.awaitCompletion(id, { until: 'exit', timeoutMs: NEVER });
      const outcome = watch(handle);

      expect(await outcome()).toBeNull();
      // The bell is the human's; only a command exit wakes this caller.
      expect(manager.getState(id)).toMatchObject({ status: 'ALERT_RINGING', todo: true, awaited: true });
    });

    it('never sets attention, so the next completion still rings the human', async () => {
      const id = 'await-does-not-attend';
      driveToRinging(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      expect(await handle.promise).toMatchObject({ kind: 'resolved', cause: 'quiet' });

      // Attention would suppress this second ring for the whole 15s window.
      driveToBusy(id);
      settle();
      expect(manager.getState(id).status).toBe('ALERT_RINGING');
    });

    // 2. Claiming the first qualifying completion.

    it('resolves quiet on a settle, claiming it before any ring rule runs', async () => {
      const id = 'await-quiet-settle';
      runWatchedCommand(id);
      manager.clearAttention(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      driveToBusy(id);
      settle();

      expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'quiet', waitedMs: 6_600 });
      // The completion went to the program, so it rang nobody and left no marker.
      expect(manager.getState(id)).toMatchObject({
        status: 'NOTHING_TO_SHOW',
        todo: false,
        notification: null,
        awaited: false,
      });
    });

    it.each([
      ['BUSY', 0, 5_000],
      ['MIGHT_NEED_ATTENTION', 2_000, 3_000],
    ] as const)('keeps a parked quiet await armed when attention arrives during %s', async (_status, beforeAttendMs, afterAttendMs) => {
      const id = `await-quiet-attended-${_status}`;
      runWatchedCommand(id);
      manager.clearAttention(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      driveToBusy(id);
      vi.advanceTimersByTime(beforeAttendMs);
      expect(manager.getState(id).status).toBe(_status);

      manager.attend(id);
      vi.advanceTimersByTime(afterAttendMs);

      expect(await handle.promise).toEqual({
        kind: 'resolved',
        cause: 'quiet',
        waitedMs: 6_600,
      });
    });

    it('resolves exit on a command finish under --until quiet', async () => {
      const id = 'await-quiet-finish';
      runCommand(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      vi.advanceTimersByTime(4_000);
      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 2 }]);

      expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'exit', waitedMs: 4_000 });
    });

    it('resolves bell on an OSC 9 notification under --until quiet', async () => {
      const id = 'await-quiet-bell';
      runCommand(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'needs input' });

      expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'bell', waitedMs: 0 });
      expect(manager.getState(id)).toMatchObject({ todo: false, notification: null });
    });

    it('resolves bell on a progress completion and still clears the cycle', async () => {
      const id = 'await-quiet-progress';
      runCommand(id);
      manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
      expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      manager.updateProtocolProgress(id, { state: 'normal', percent: 100 });

      expect(await handle.promise).toMatchObject({ kind: 'resolved', cause: 'bell' });
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });
    });

    it('ignores a bell and a settle under --until exit, then resolves on the finish', async () => {
      const id = 'await-exit-strict';
      runWatchedCommand(id);
      manager.clearAttention(id);

      const handle = manager.awaitCompletion(id, { until: 'exit', timeoutMs: NEVER });
      const outcome = watch(handle);

      // A build tool that BELs on a warning must not wake the strict caller...
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'deprecation warning' });
      expect(await outcome()).toBeNull();

      // ...and neither must falling silent mid-run.
      driveToBusy(id);
      settle();
      expect(await outcome()).toBeNull();

      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
      expect(await outcome()).toMatchObject({ kind: 'resolved', cause: 'exit' });
    });

    // 3. Grace window.

    it('resolves idle when nothing is running and nothing starts', async () => {
      for (const until of ['quiet', 'exit'] as const) {
        const id = `await-idle-${until}`;
        const handle = manager.awaitCompletion(id, { until, timeoutMs: NEVER });
        const outcome = watch(handle);

        vi.advanceTimersByTime(AWAIT_GRACE_MS - 1);
        expect(await outcome()).toBeNull();

        vi.advanceTimersByTime(1);
        expect(await outcome()).toEqual({ kind: 'resolved', cause: 'idle', waitedMs: AWAIT_GRACE_MS });
      }
    });

    it('cancels the grace window on output under --until quiet, but not under --until exit', async () => {
      const quiet = manager.awaitCompletion('await-grace-quiet', { until: 'quiet', timeoutMs: NEVER });
      const strict = manager.awaitCompletion('await-grace-exit', { until: 'exit', timeoutMs: NEVER });
      const quietOutcome = watch(quiet);
      const strictOutcome = watch(strict);

      manager.onData('await-grace-quiet');
      manager.onData('await-grace-exit');
      vi.advanceTimersByTime(AWAIT_GRACE_MS);

      // Output is evidence of work for `quiet`; for `exit` only a command start is.
      expect(await quietOutcome()).toBeNull();
      expect(await strictOutcome()).toEqual({ kind: 'resolved', cause: 'idle', waitedMs: AWAIT_GRACE_MS });
    });

    it('cancels the grace window on a command start under --until exit', async () => {
      const id = 'await-grace-command-start';
      const handle = manager.awaitCompletion(id, { until: 'exit', timeoutMs: NEVER });
      const outcome = watch(handle);

      runCommand(id);
      vi.advanceTimersByTime(AWAIT_GRACE_MS);
      expect(await outcome()).toBeNull();

      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
      expect(await outcome()).toMatchObject({ kind: 'resolved', cause: 'exit' });
    });

    it('cancels the grace window on a command start under --until quiet too', async () => {
      const id = 'await-grace-quiet-command-start';
      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      const outcome = watch(handle);

      // The window's usual test under `quiet` is output, but a command that
      // starts silently is still running — `idle` would report "nothing was
      // running" about a live foreground command.
      runCommand(id);
      vi.advanceTimersByTime(AWAIT_GRACE_MS * 2);
      expect(await outcome()).toBeNull();

      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
      expect(await outcome()).toMatchObject({ kind: 'resolved', cause: 'exit' });
    });

    it('runs no grace window at all while a foreground command is running', async () => {
      const id = 'await-grace-suppressed';
      runCommand(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      const outcome = watch(handle);

      vi.advanceTimersByTime(AWAIT_GRACE_MS * 2);
      expect(await outcome()).toBeNull();
    });

    it('lets a completion arriving during the grace window resolve normally', async () => {
      const id = 'await-grace-bell';
      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });

      vi.advanceTimersByTime(500);
      manager.notifyFromProtocol(id, { source: 'BEL', title: 'Terminal bell', body: null });

      expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'bell', waitedMs: 500 });
    });

    // 4. Timeout.

    it('times out host-side on the caller ceiling', async () => {
      const id = 'await-timeout';
      runCommand(id);

      const handle = manager.awaitCompletion(id, { until: 'exit', timeoutMs: 10_000 });
      const outcome = watch(handle);

      vi.advanceTimersByTime(9_999);
      expect(await outcome()).toBeNull();

      vi.advanceTimersByTime(1);
      expect(await outcome()).toEqual({ kind: 'timeout', waitedMs: 10_000 });
    });

    it('refuses a nonsensical ceiling instead of installing a broken timer', async () => {
      const id = 'await-bad-timeout';
      // Above the cap the delay would overflow `setTimeout`'s signed 32-bit
      // millisecond count and fire on the next tick, so a park that looks like
      // a day would resolve `timeout` instantly.
      for (const timeoutMs of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, MAX_AWAIT_TIMEOUT_MS + 1, 3_000_000_000]) {
        const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs });
        expect(await handle.promise).toEqual({ kind: 'cancelled', waitedMs: 0 });
      }
      expect(manager.getState(id).awaited).toBe(false);
    });

    // 5. Death.

    it('reports the command exit first when the PTY dies mid-run', async () => {
      const id = 'await-pty-exit-running';
      runCommand(id);

      const handle = manager.awaitCompletion(id, { until: 'exit', timeoutMs: NEVER });
      vi.advanceTimersByTime(3_000);
      manager.onExit(id, 1);

      // The peer rang on its way out, so it resolves normally rather than as a death.
      expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'exit', waitedMs: 3_000 });
    });

    it('reports death when the PTY exits with nothing running', async () => {
      const id = 'await-pty-exit-idle';
      // An entry with no command watch: the detector exists, nothing is running.
      manager.onData(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      vi.advanceTimersByTime(200);
      manager.onExit(id, 0);

      expect(await handle.promise).toEqual({ kind: 'died', waitedMs: 200 });
    });

    it('does not rebuild a removed Session from output already in flight', () => {
      const id = 'removed-then-noisy';
      runWatchedCommand(id);
      manager.remove(id);

      // `disposeSession` removes before killing the PTY, so these are the bytes
      // that were already on their way out. Rebuilding here would strand an
      // entry and a detector nothing ever disposes.
      manager.onData(id);
      manager.onResize(id);
      expect(manager.getState(id)).toEqual(DEFAULT_ALERT_STATE);

      // A replacement pane may reuse the id; its first reported command is the
      // evidence that somebody is home, and the rule set applies immediately.
      runWatchedCommand(id);
      expect(manager.getState(id).watchingEnabled).toBe(true);
    });

    it('reports death when the Session is removed', async () => {
      const id = 'await-removed';
      runCommand(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      vi.advanceTimersByTime(1_000);
      manager.remove(id);

      expect(await handle.promise).toEqual({ kind: 'died', waitedMs: 1_000 });
    });

    it('cancels everything still parked when the manager is disposed', async () => {
      const id = 'await-disposed';
      runCommand(id);
      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });

      manager.dispose();

      expect(await handle.promise).toEqual({ kind: 'cancelled', waitedMs: 0 });
      // afterEach disposes again; a second dispose must stay a no-op.
    });

    // 6. Cancellation.

    it('cancels a parked await and ignores a cancel after it settled', async () => {
      const id = 'await-cancel';
      runCommand(id);

      const cancelled = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      vi.advanceTimersByTime(750);
      cancelled.cancel();
      expect(await cancelled.promise).toEqual({ kind: 'cancelled', waitedMs: 750 });

      // Claiming is delivery: once a completion has been handed over there is
      // nothing left to release, so a late cancel changes nothing.
      const delivered = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'done' });
      delivered.cancel();
      expect(await delivered.promise).toMatchObject({ kind: 'resolved', cause: 'bell' });
      expect(manager.getState(id)).toMatchObject({ todo: false, notification: null, awaited: false });
    });

    // 7. Independence.

    it('delivers one completion to every await parked on the Session', async () => {
      const id = 'await-two-waiters';
      runWatchedCommand(id);
      manager.clearAttention(id);

      const first = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      vi.advanceTimersByTime(1_000);
      const second = manager.awaitCompletion(id, { until: 'exit', timeoutMs: NEVER });
      const secondOutcome = watch(second);
      expect(manager.getState(id).awaited).toBe(true);

      driveToBusy(id);
      settle();

      // Each wakes on the first signal that qualifies for *its* condition.
      expect(await first.promise).toEqual({ kind: 'resolved', cause: 'quiet', waitedMs: 7_600 });
      expect(await secondOutcome()).toBeNull();
      expect(manager.getState(id).awaited).toBe(true);

      manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }]);
      expect(await secondOutcome()).toMatchObject({ kind: 'resolved', cause: 'exit' });
      expect(manager.getState(id).awaited).toBe(false);
    });

    it('wakes two identical awaits on the same completion', async () => {
      const id = 'await-two-identical';
      runCommand(id);

      const first = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      const second = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'done' });

      expect(await first.promise).toMatchObject({ kind: 'resolved', cause: 'bell' });
      expect(await second.promise).toMatchObject({ kind: 'resolved', cause: 'bell' });
    });

    // 9. The public flag.

    it('publishes awaited on every register and every settlement path', async () => {
      const id = 'await-flag';
      const flags: boolean[] = [];
      manager.onStateChange((_id, state) => {
        if (_id === id) flags.push(state.awaited);
      });
      runCommand(id);
      expect(flags.at(-1)).toBe(false);

      const timedOut = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: 5_000 });
      expect(flags.at(-1)).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(await timedOut.promise).toMatchObject({ kind: 'timeout' });
      expect(flags.at(-1)).toBe(false);

      const cancelled = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      expect(flags.at(-1)).toBe(true);
      cancelled.cancel();
      expect(await cancelled.promise).toMatchObject({ kind: 'cancelled' });
      expect(flags.at(-1)).toBe(false);

      const resolved = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      expect(flags.at(-1)).toBe(true);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'done' });
      expect(await resolved.promise).toMatchObject({ kind: 'resolved', cause: 'bell' });
      expect(flags.at(-1)).toBe(false);
    });
  });
});
