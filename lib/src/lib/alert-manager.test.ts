import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';
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
    runWatchedCommand(id);

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

    runWatchedCommand(id);
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
    runWatchedCommand(id);
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

    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);
    // The detector is BUSY underneath, but no rule matches, so nothing shows.
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      watchingEnabled: false,
    });

    // ... and a settle on an unwatched Session never rings the human.
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(3_000);
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

    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);
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

    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);
    expect(manager.getState(id).status).toBe('BUSY');

    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(3_000);
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
    manager.onData(id);
    vi.advanceTimersByTime(1_600);
    manager.onData(id);
    manager.onData(id);
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
});
