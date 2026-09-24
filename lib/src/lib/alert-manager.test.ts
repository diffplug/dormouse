import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager, AWAIT_GRACE_MS, DEFAULT_ALERT_STATE, MAX_AWAIT_TIMEOUT_MS } from './alert-manager';
import type { ActivityNotification, AwaitHandle, AwaitOutcome, CompletionEvent } from './alert-manager';
import {
  applyTerminalEvents,
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  TerminalProtocolParser,
} from './terminal-protocol';
import { cfg } from '../cfg';
import { toPersistedAlertState } from './session-types';

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

  /** Start `commandLine` the way shell integration reports it: the line, then its start. */
  function runCommand(id: string, commandLine = 'pnpm build'): void {
    manager.applyTerminalSemanticEvents(id, [
      { type: 'commandLine', commandLine },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
  }

  /** The one viewer these tests report for: a single renderer realm. */
  const VIEWER = 'viewer';

  /** The user is present, pointing at `id` (`docs/specs/alert.md` -> Engagement). */
  function engage(id: string): void {
    manager.setViewer(VIEWER, { present: true, focusId: id });
  }

  /** An explicit disengage: focus moved off, or the window left. */
  function disengage(): void {
    manager.setViewer(VIEWER, { present: false, focusId: null }, 'leave');
  }

  /** Presence lapses from inactivity while `id` keeps the focus. */
  function goIdle(id: string): void {
    manager.setViewer(VIEWER, { present: false, focusId: id }, 'idle');
  }

  /** Run `commandLine` seen and then left: armed, so its exit rings once it
   *  has outlasted `cfg.alert.commandExitMinRuntime`. */
  function armCommandExit(id: string, commandLine = 'pnpm build'): void {
    engage(id);
    runCommand(id, commandLine);
    disengage();
  }

  function finishCommand(id: string, exitCode = 0): void {
    manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode }]);
  }

  /**
   * WATCHING is keyed on the foreground command's watch key, so the only way to
   * turn it on is to run a watched command (`docs/specs/alert.md`).
   */
  function runWatchedCommand(id: string, commandLine = 'longtask'): void {
    manager.setWatchedCommands(['longtask']);
    runCommand(id, commandLine);
  }

  describe('helper Sessions', () => {
    const HELPER = 'helper';

    it('alerts no one, publishes nothing, and accepts no report or control until promoted', () => {
      const states: string[] = [];
      manager.onStateChange((id) => states.push(id));
      const seen = recordingClaimant(HELPER, true);
      manager.setHelper(HELPER, true);
      runWatchedCommand(HELPER);
      driveToBusy(HELPER);
      settle();
      applyTerminalProtocolEvents(manager, HELPER, [{ kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'done' } }]);
      applyTerminalProtocolEvents(manager, HELPER, [{ kind: 'progress', progress: { state: 'normal', percent: 40 } }]);
      engage(HELPER);
      manager.acknowledge(HELPER, { input: true });
      disengage();
      manager.toggleTodo(HELPER);
      manager.clearTodo(HELPER);
      manager.seed(HELPER, { todo: true });
      manager.onResize(HELPER);
      finishCommand(HELPER, 1);
      manager.onExit(HELPER, 0);
      vi.advanceTimersByTime(10_000);

      expect(states).toEqual([]);
      expect(seen).toEqual([]);
      expect(manager.getState(HELPER)).toEqual(DEFAULT_ALERT_STATE);
      expect(manager.getAllStates().has(HELPER)).toBe(false);
      // Removing a helper that never published tells subscribers nothing either.
      manager.remove(HELPER);
      expect(states).toEqual([]);
    });

    it('cancels an await on a helper', async () => {
      manager.setHelper(HELPER, true);
      await expect(manager.awaitCompletion(HELPER, { until: 'quiet', timeoutMs: 10_000 }).promise)
        .resolves.toEqual({ kind: 'cancelled', waitedMs: 0 });
    });

    it('keeps the command a helper was running when it is promoted mid-command', () => {
      manager.setWatchedCommands(['claude']);
      manager.setHelper(HELPER, true);
      runCommand(HELPER, 'claude');
      driveToBusy(HELPER);

      const states: boolean[] = [];
      manager.onStateChange((id, state) => { if (id === HELPER) states.push(state.watchingEnabled); });
      manager.setHelper(HELPER, false);
      // Promotion publishes what the helper built up: WATCHING on `claude`, now.
      expect(states).toEqual([true]);
      expect(manager.getState(HELPER)).toMatchObject({ watchingEnabled: true, status: 'BUSY' });

      // Its next unattended settle rings like any watched Session's.
      settle();
      expect(manager.getState(HELPER).status).toBe('ALERT_RINGING');
    });

    it('never replays a completion suppressed before promotion', () => {
      manager.setWatchedCommands(['claude']);
      manager.setHelper(HELPER, true);
      runCommand(HELPER, 'claude');
      driveToBusy(HELPER);
      settle();
      applyTerminalProtocolEvents(manager, HELPER, [{ kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'done' } }]);

      manager.setHelper(HELPER, false);
      vi.advanceTimersByTime(10_000);
      expect(manager.getState(HELPER)).toMatchObject({ status: 'NOTHING_TO_SHOW', todo: false, notification: null });
    });

    it('does not ring the exit of a command it never saw engaged', () => {
      manager.setHelper(HELPER, true);
      runCommand(HELPER, 'npm run build');
      manager.setHelper(HELPER, false);
      vi.advanceTimersByTime(30_000);
      finishCommand(HELPER);
      expect(manager.getState(HELPER).status).toBe('WATCHING_DISABLED');

      // The ordinary seen rule applies from promotion on.
      runCommand(HELPER, 'npm run build');
      engage(HELPER);
      disengage();
      vi.advanceTimersByTime(30_000);
      finishCommand(HELPER);
      expect(manager.getState(HELPER).status).toBe('ALERT_RINGING');
    });

    it('takes back what a Session published when a failed placement demotes it', () => {
      manager.setHelper(HELPER, true);
      manager.setHelper(HELPER, false);
      manager.toggleTodo(HELPER);
      const states: boolean[] = [];
      manager.onStateChange((id, state) => { if (id === HELPER) states.push(state.todo); });
      manager.setHelper(HELPER, true);
      expect(states).toEqual([false]);
      expect(manager.getState(HELPER)).toEqual(DEFAULT_ALERT_STATE);
    });
  });

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

    for (let t = 0; t < 5_000; t += 200) {
      manager.onData(id);
      vi.advanceTimersByTime(200);
    }
    expect(manager.getState(id).status).toBe('BUSY');

    vi.advanceTimersByTime(60_000);

    expect(manager.getState(id).status).toBe('ALERT_RINGING');
  });

  it('ALERT_RINGING latches through output until acknowledged', () => {
    const id = 'latch-test';
    // Deferral ships on and withdraws a WATCHING ring once output resumes
    // confirmed BUSY; latching through output is the switched-off timing.
    manager.setDeferAlertsUntilQuiet(false);
    runWatchedCommand(id);

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

    manager.acknowledge(id, { input: false });
    manager.onData(id);
    expect(manager.getState(id).status).not.toBe('ALERT_RINGING');
  });

  it('rings a watched settle once the user has left, and acknowledging puts it out', () => {
    const id = 'reset-test';
    runWatchedCommand(id);

    engage(id);
    driveToBusy(id);

    disengage();
    settle();
    expect(manager.getState(id).status).toBe('ALERT_RINGING');

    engage(id);
    manager.acknowledge(id, { input: false });
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

  /** One output chunk a second for `ms`, which never lets the Session go quiet. */
  function heartbeat(id: string, ms: number): void {
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      vi.advanceTimersByTime(1_000);
      manager.onData(id);
    }
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
    driveToBusy(id);
    settle();
    expect(manager.getState(id).status).toBe('ALERT_RINGING');
  }

  // --- One ring latch (`docs/specs/alert.md` -> Clearing And TODO) ---

  /** Raise a ring from `source` on a fresh Session, unattended. */
  function ringFrom(id: string, source: 'watching' | 'report' | 'exit'): void {
    if (source === 'watching') {
      driveToRinging(id);
    } else if (source === 'report') {
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'needs input' });
    } else {
      armCommandExit(id);
      vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
      finishCommand(id);
    }
    expect(manager.getState(id).status).toBe('ALERT_RINGING');
  }

  it('a WATCHING ring sets TODO the moment it opens, with its own detail', () => {
    const id = 'watching-sets-todo';
    driveToRinging(id);
    expect(manager.getState(id)).toMatchObject({
      todo: true,
      notification: { source: 'WATCHING', title: 'longtask went quiet', body: null },
    });
  });

  /** The verbs that clear a ring and leave its TODO. */
  const leaveTodoVerbs = {
    acknowledge: (id: string) => manager.acknowledge(id, { input: false }),
    dismissAlert: (id: string) => manager.dismissAlert(id),
  };

  it.each(['watching', 'report', 'exit'] as const)('acknowledging without input or dismissing a %s ring leaves its TODO', (source) => {
    for (const verb of ['acknowledge', 'dismissAlert'] as const) {
      const id = `ring-leaves-todo-${source}-${verb}`;
      ringFrom(id, source);
      leaveTodoVerbs[verb](id);
      expect(manager.getState(id)).toMatchObject({ episode: null, todo: true });
      expect(manager.getState(id).status).not.toBe('ALERT_RINGING');
      expect(manager.getState(id).notification).not.toBeNull();
    }
  });

  it.each(['watching', 'report', 'exit'] as const)('typing, toggling, or clearing TODO on a %s ring turns it off with its detail', (source) => {
    const verbs = {
      acknowledgeInput: (id: string) => manager.acknowledge(id, { input: true }),
      toggleTodo: (id: string) => manager.toggleTodo(id),
      clearTodo: (id: string) => manager.clearTodo(id),
    };
    for (const verb of ['acknowledgeInput', 'toggleTodo', 'clearTodo'] as const) {
      const id = `todo-off-ringing-${source}-${verb}`;
      ringFrom(id, source);
      verbs[verb](id);
      expect(manager.getState(id)).toMatchObject({ episode: null, todo: false, notification: null });
      expect(manager.getState(id).status).not.toBe('ALERT_RINGING');
    }
  });

  it('an unattended WATCHING ring leaves its TODO across a restart, without its live-only detail', () => {
    const id = 'watching-restart';
    driveToRinging(id);
    const persisted = JSON.parse(JSON.stringify(toPersistedAlertState(manager.getState(id))));
    expect(persisted).toEqual({ status: 'ALERT_RINGING', todo: true, notification: null });

    const restarted = new AlertManager();
    try {
      restarted.seed(id, persisted);
      expect(restarted.getState(id)).toMatchObject({ episode: null, todo: true });
    } finally {
      restarted.dispose();
    }
  });

  describe('detail joining a ring', () => {
    const text: ActivityNotification = { source: 'OSC 9', title: null, body: 'Build finished: 3 warnings' };
    const otherText: ActivityNotification = { source: 'OSC 777', title: 'Second', body: null };
    const bell: ActivityNotification = { source: 'BEL', title: 'Terminal bell', body: null };
    const exit: ActivityNotification = { source: 'COMMAND_EXIT', title: 'Command finished', body: 'make exited 2' };

    it.each([
      ['a bell never replaces text', text, bell, text],
      ['an exit code replaces a bell', bell, exit, exit],
      ['an exit code never replaces text', text, exit, text],
      ['equally rich text replaces the older', text, otherText, otherText],
    ] as const)('%s', (_label, first, joining, shown) => {
      const id = `detail-rank-${_label}`;
      armCommandExit(id, 'make');
      vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
      for (const detail of [first, joining]) {
        if (detail.source === 'COMMAND_EXIT') finishCommand(id, 2);
        else manager.notifyFromProtocol(id, detail);
      }
      expect(manager.getState(id)).toMatchObject({ status: 'ALERT_RINGING', notification: shown });
    });
  });

  it.each(['acknowledge', 'dismissAlert'] as const)(
    'a report about a state acknowledged by %s updates the TODO without summoning again',
    (verb) => {
      // Claude Code: the turn settles and WATCHING rings; the user acknowledges
      // it without typing; a minute later Claude sends its idle notification.
      const id = `acknowledged-${verb}`;
      const episodes = new Set<string>();
      manager.onStateChange((changed, state) => {
        if (changed === id && state.episode) episodes.add(state.episode.id);
      });
      driveToRinging(id);
      leaveTodoVerbs[verb](id);
      vi.advanceTimersByTime(60_000);

      manager.notifyFromProtocol(id, { source: 'OSC 99', title: 'Claude Code', body: 'Claude is waiting for your input' });

      expect(episodes.size).toBe(1);
      expect(manager.getState(id)).toMatchObject({
        episode: null,
        todo: true,
        notification: { source: 'OSC 99', title: 'Claude Code', body: 'Claude is waiting for your input' },
      });
    },
  );

  it('rings a report again once output follows the acknowledgement', () => {
    const id = 'acknowledged-then-output';
    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'first' });
    manager.dismissAlert(id);
    manager.onData(id);
    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'second' });
    expect(manager.getState(id).status).toBe('ALERT_RINGING');
  });

  it('toggleTodo flips on and off', () => {
    const id = 'toggle-todo';
    expect(manager.getState(id).todo).toBe(false);
    manager.toggleTodo(id);
    expect(manager.getState(id).todo).toBe(true);
    manager.toggleTodo(id);
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

  it('an OSC progress cycle shows busy without visual timers and rings when it ends', () => {
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

  it('dropping the rule only turns WATCHING off, leaving the progress cycle running', () => {
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

  // --- Progress: an independent sub-state (`docs/specs/alert.md` -> Terminal reports) ---

  it('a progress update never takes a ring away', () => {
    const id = 'progress-keeps-ring';
    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'needs permission' });
    const ringing = manager.getState(id);

    manager.updateProtocolProgress(id, { state: 'indeterminate', percent: null });

    expect(manager.getState(id)).toMatchObject({ status: 'ALERT_RINGING', episode: ringing.episode });
  });

  it('a ring leaves the progress cycle running, so its end still rings', () => {
    const id = 'ring-keeps-progress';
    manager.updateProtocolProgress(id, { state: 'indeterminate', percent: null });
    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'needs permission' });
    manager.acknowledge(id, { input: false });
    expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

    // The run goes on after the answer, then its cycle ends.
    manager.onData(id);
    manager.updateProtocolProgress(id, { state: 'clear', percent: null });

    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      notification: { source: 'OSC 9;4', title: 'Progress complete' },
    });
  });

  it.each([
    ['commandStart', (id: string) => runCommand(id, 'other-tool')],
    ['commandFinish', (id: string) => finishCommand(id, 130)],
    ['promptStart', (id: string) => manager.applyTerminalSemanticEvents(id, [{ type: 'promptStart' }])],
    ['PTY exit', (id: string) => manager.onExit(id, 137)],
  ] as const)('%s silently ends a progress cycle the program abandoned', (boundary, cross) => {
    const id = `abandoned-progress-${boundary}`;
    runCommand(id, 'cargo build');
    manager.updateProtocolProgress(id, { state: 'normal', percent: 40 });
    expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

    cross(id);
    expect(manager.getState(id).status).not.toBe('OSC_NOTIF_BUSY');

    // A later defensive clear finds no cycle to complete.
    manager.updateProtocolProgress(id, { state: 'clear', percent: null });
    expect(manager.getState(id)).toMatchObject({ episode: null, todo: false, notification: null });
  });

  it.each([
    ['complete', [{ state: 'normal', percent: 40 }, { state: 'clear', percent: null }], 'cargo build finished'],
    ['warning', [{ state: 'warning', percent: 40 }, { state: 'normal', percent: 100 }], 'cargo build finished with a warning'],
    ['error', [{ state: 'normal', percent: 40 }, { state: 'error', percent: null }], 'cargo build reported an error'],
  ] as const)('names the running command in a progress %s title', (_outcome, updates, title) => {
    const id = `progress-title-${_outcome}`;
    runCommand(id, 'cargo build --release');
    for (const update of updates) manager.updateProtocolProgress(id, update);
    expect(manager.getState(id).notification).toMatchObject({ source: 'OSC 9;4', title });
  });

  it('dismissing a Session with nothing ringing changes nothing and notifies no one', () => {
    const id = 'dismiss-without-ring';
    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });
    manager.dismissAlert(id);
    const quiet = manager.getState(id);

    const states: string[] = [];
    manager.onStateChange((changed) => states.push(changed));
    manager.dismissAlert(id);

    expect(states).toEqual([]);
    expect(manager.getState(id)).toEqual(quiet);
  });

  it('leaves a notification still deferred behind animation pending when dismissed', () => {
    const id = 'dismiss-keeps-deferral';
    driveToBusy(id);
    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished' });
    expect(manager.getState(id)).toMatchObject({ status: 'WATCHING_DISABLED', todo: false, notification: null });

    manager.dismissAlert(id);

    vi.advanceTimersByTime(5_000);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'OSC 9', title: null, body: 'Build finished' },
    });
  });

  it('protocol completion is held while the Session is engaged', () => {
    const id = 'osc-progress-attention';

    engage(id);
    manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
    expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

    manager.updateProtocolProgress(id, { state: 'normal', percent: 100 });
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('direct protocol notifications are held while the Session is engaged', () => {
    const id = 'osc-notification-attention';

    engage(id);
    manager.notifyFromProtocol(id, { source: 'OSC 777', title: 'done', body: 'Build finished' });

    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('engaged direct notifications do not clear active protocol progress', () => {
    const id = 'osc-progress-with-attended-notification';

    manager.updateProtocolProgress(id, { state: 'normal', percent: 25 });
    expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');

    engage(id);
    manager.notifyFromProtocol(id, { source: 'OSC 777', title: 'done', body: 'Build finished' });

    expect(manager.getState(id)).toMatchObject({
      status: 'OSC_NOTIF_BUSY',
      todo: false,
      notification: null,
    });
  });

  it('terminal bell notifications are held while the Session is engaged', () => {
    const id = 'terminal-bell-attention';

    engage(id);
    applyTerminalProtocolEvents(manager, id, [
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);

    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('arms and rings when an engaged command is left before exiting', () => {
    const id = 'command-exit';

    armCommandExit(id);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
    finishCommand(id);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'COMMAND_EXIT', title: 'Command finished', body: 'pnpm build exited 0' },
    });
  });

  // `docs/specs/alert.md` -> Public State.
  it('a second source joining mid-episode keeps the episode id', () => {
    const id = 'episode-cross-track';
    const seen: string[] = [];
    manager.onStateChange((_id, state) => {
      if (_id === id && state.episode) seen.push(state.episode.id);
    });

    armCommandExit(id);
    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);

    applyTerminalProtocolEvents(manager, id, [
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);
    const rung = manager.getState(id);
    expect(rung.status).toBe('ALERT_RINGING');
    expect(rung.episode?.id).toBeTruthy();

    // The exit joins the ring the bell opened: one enriched summons, so no
    // consumer keyed on the episode may deliver a second time.
    finishCommand(id);
    const again = manager.getState(id);
    expect(again.status).toBe(rung.status);
    expect(again.episode?.id).toBe(rung.episode?.id);
    expect(new Set(seen)).toEqual(new Set([rung.episode!.id]));
  });

  it('re-latching after the ring clears starts a new episode', () => {
    const id = 'episode-restart';
    const bell = { source: 'BEL', title: 'Terminal bell', body: null } as const;

    applyTerminalProtocolEvents(manager, id, [{ kind: 'notification', notification: bell }]);
    const first = manager.getState(id).episode;
    expect(first?.id).toBeTruthy();

    // Bell spam on a ring that is already active enriches the standing
    // summons; it cannot raise a new episode, so nothing keyed on one replays.
    applyTerminalProtocolEvents(manager, id, [{ kind: 'notification', notification: bell }]);
    expect(manager.getState(id).episode?.id).toBe(first!.id);

    manager.clearTodo(id);
    expect(manager.getState(id).episode).toBeNull();

    // Output since the clear: the next bell is news, not the acknowledged state.
    manager.onData(id);
    applyTerminalProtocolEvents(manager, id, [{ kind: 'notification', notification: bell }]);
    const second = manager.getState(id).episode;
    expect(second?.id).toBeTruthy();
    expect(second?.id).not.toBe(first!.id);
  });

  it('finishes an armed command-exit watch when the PTY exits without commandFinish', () => {
    const id = 'command-exit-pty-exit';

    armCommandExit(id, 'exec pnpm build');
    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

    manager.onExit(id, 1);
    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { source: 'COMMAND_EXIT', title: 'Command finished', body: 'exec pnpm build exited 1' },
    });
  });

  it('clears a command-exit watch whose quick PTY exit was engaged', () => {
    const id = 'command-exit-pty-exit-unarmed';

    engage(id);
    runCommand(id, 'exec true');

    manager.onExit(id, 0);
    goIdle(id);

    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('does not ring the exit of a command shorter than the minimum runtime', () => {
    const id = 'quick-command-exit';

    armCommandExit(id, 'git status');
    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime - 1);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

    finishCommand(id);
    expect(manager.getState(id)).toMatchObject({
      status: 'WATCHING_DISABLED',
      todo: false,
      notification: null,
    });
  });

  it('disarms command-exit alerts while the user is back, holding the finish', () => {
    const id = 'command-exit-return';

    armCommandExit(id, 'pnpm test');
    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

    engage(id);
    expect(manager.getState(id).status).toBe('WATCHING_DISABLED');

    vi.advanceTimersByTime(1_000);
    finishCommand(id);
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

    runCommand(id, 'claude --print hello');
    expect(manager.getState(id).watchingEnabled).toBe(true);

    finishCommand(id);
    expect(manager.getState(id).watchingEnabled).toBe(false);
  });

  it('notifies subscribers when WATCHING turns off as a watched command finishes', () => {
    const id = 'rule-finish-notify';
    manager.setWatchedCommands(['claude']);

    runCommand(id, 'claude');
    expect(manager.getState(id).watchingEnabled).toBe(true);

    // Subscribe after the command has started so we only capture the finish.
    const watching: boolean[] = [];
    manager.onStateChange((_id, state) => {
      if (_id === id) watching.push(state.watchingEnabled);
    });

    finishCommand(id);

    expect(manager.getState(id).watchingEnabled).toBe(false);
    // The off-transition must reach subscribers, not just live getState reads.
    expect(watching).toContain(false);
  });

  it('matches on the watch key, not the whole command line', () => {
    const id = 'rule-watch-key';
    manager.setWatchedCommands(['claude']);

    runCommand(id, 'FOO=1 env BAR=2 /usr/local/bin/claude --resume');
    expect(manager.getState(id).watchingEnabled).toBe(true);
  });

  it('engages WATCHING for a command fish reports on OSC 133;C', () => {
    const id = 'rule-fish';
    manager.setWatchedCommands(['claude']);
    const parsed = new TerminalProtocolParser().process('\x1b]133;C;cmdline_url=claude%20--resume\x1b\\');
    manager.applyTerminalSemanticEvents(id, collectTerminalSemanticEvents(parsed.events));
    expect(manager.getState(id).watchingEnabled).toBe(true);
  });

  it('leaves an unwatched command alone', () => {
    const id = 'rule-miss';
    manager.setWatchedCommands(['claude']);

    runCommand(id, 'git status');
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
    for (const id of [a, b]) runCommand(id, 'claude');
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
    finishCommand(id);
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

  it('rings a runner script only under a rule that covers it', () => {
    const id = 'runner-script-rule';
    const ringsUnder = (rules: string[]): boolean => {
      manager.setWatchedCommands(rules);
      runCommand(id, 'pnpm run dev');
      driveToBusy(id);
      settle();
      const ringing = manager.getState(id).status === 'ALERT_RINGING';
      manager.clearTodo(id);
      manager.applyTerminalSemanticEvents(id, [{ type: 'promptStart' }]);
      return ringing;
    };

    expect(ringsUnder(['pnpm test'])).toBe(false);
    expect(ringsUnder(['pnpm dev'])).toBe(true);
    // A bare runner rule keeps matching every script of that runner.
    expect(ringsUnder(['pnpm'])).toBe(true);
  });

  it('keeps a WATCHING ring whose command another rule still covers', () => {
    const id = 'ring-survives-covered';
    manager.setWatchedCommands(['pnpm', 'pnpm dev']);
    runCommand(id, 'pnpm dev');
    driveToBusy(id);
    settle();
    expect(manager.getState(id).status).toBe('ALERT_RINGING');

    manager.setWatchedCommands(['pnpm']);
    expect(manager.getState(id).status).toBe('ALERT_RINGING');
    manager.setWatchedCommands([]);
    expect(manager.getState(id).status).toBe('WATCHING_DISABLED');
  });

  it('silences a latched WATCHING ring when its rule is removed after command exit', () => {
    const id = 'exited-ring-dies-with-rule';
    driveToRinging(id);
    finishCommand(id);

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

  it.each(['promptStart', 'promptEnd'] as const)('resets unwatched output history on %s without a command watch', (type) => {
    const id = `prompt-boundary-${type}`;
    const completions: CompletionEvent[] = [];
    manager.registerCompletionClaimant(id, (event) => {
      completions.push(event);
      return false;
    });
    driveToBusy(id);
    manager.applyTerminalSemanticEvents(id, [{ type }]);
    settle();
    expect(completions).toEqual([]);

    // The prompt reset forgets old work but keeps observing subsequent output.
    driveToBusy(id);
    settle();
    expect(completions).toEqual([{ kind: 'settled' }]);
  });

  it('dismissing a WATCHING ring keeps the tail of its run from ringing again', () => {
    const id = 'dismiss-resets-tail';
    // Keep the ring through the tail's output: deferral would withdraw it.
    manager.setDeferAlertsUntilQuiet(false);
    driveToRinging(id);
    driveToBusy(id);

    manager.dismissAlert(id);
    settle();
    expect(manager.getState(id)).toMatchObject({ status: 'NOTHING_TO_SHOW', episode: null });
  });

  it('drives the detector on an unwatched Session without showing it or ringing', () => {
    const id = 'unwatched-detector';
    manager.setWatchedCommands(['claude']);
    runCommand(id, 'git log');

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
    runCommand(id, 'claude');

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

  it('holds a WATCHING ring when the Session is engaged at the settle', () => {
    const id = 'settle-while-attended';
    runWatchedCommand(id);
    engage(id);

    driveToBusy(id);
    expect(manager.getState(id).status).toBe('BUSY');

    settle();
    // The user is looking: no ring yet, and the detector simply starts over.
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
    finishCommand(id);

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
    engage(id);
    disengage();

    // Armed underneath, but the monitor's own state is what is published.
    expect(manager.getState(id).status).toBe('NOTHING_TO_SHOW');

    manager.setWatchedCommands([]);
    expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');
  });

  it('defers a protocol alert with no settings call, because deferral ships on', () => {
    const id = 'defer-shipped-default';
    driveToBusy(id);

    manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });
    expect(manager.getState(id)).toMatchObject({ todo: false, notification: null });

    vi.advanceTimersByTime(5_000);
    expect(manager.getState(id)).toMatchObject({ status: 'ALERT_RINGING', todo: true });
  });

  describe('defer terminal notifications until quiet', () => {
    beforeEach(() => {
      manager.setDeferAlertsUntilQuiet(true);
    });

    it('defers a protocol alert behind an unwatched confirmed-busy detector', () => {
      const id = 'defer-unwatched-protocol';
      driveToBusy(id);
      // The detector is private while no WATCHING rule matches.
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');

      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });

      vi.advanceTimersByTime(4_999);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');
      vi.advanceTimersByTime(1);
      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        todo: true,
        notification: { source: 'OSC 9', title: null, body: 'Done' },
      });
    });

    it('publishes the OSC_NOTIF_BUSY fallback when a progress cycle completes under deferral', () => {
      const id = 'progress-defer';
      const seen: string[] = [];
      manager.onStateChange((_id, state) => {
        if (_id === id) seen.push(state.status);
      });
      driveToBusy(id);

      manager.updateProtocolProgress(id, { state: 'normal', percent: 40 });
      expect(manager.getState(id).status).toBe('OSC_NOTIF_BUSY');
      seen.length = 0;

      manager.updateProtocolProgress(id, { state: 'normal', percent: 100 });

      expect(manager.getState(id).status).not.toBe('OSC_NOTIF_BUSY');
      expect(seen).not.toEqual([]);
    });

    it('counts MIGHT_NEED_ATTENTION as confirmed busy and keeps its remaining deadline', () => {
      const id = 'defer-might-need-attention';
      driveToBusy(id);
      vi.advanceTimersByTime(2_000);

      manager.notifyFromProtocol(id, { source: 'OSC 777', title: 'Done', body: null });
      vi.advanceTimersByTime(2_999);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');
      vi.advanceTimersByTime(1);
      expect(manager.getState(id).status).toBe('ALERT_RINGING');
    });

    it('does not defer from MIGHT_BE_BUSY, which has not confirmed activity', () => {
      const id = 'do-not-defer-candidate';
      manager.onData(id);
      vi.advanceTimersByTime(1_600);
      manager.onData(id);

      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });
      expect(manager.getState(id).status).toBe('ALERT_RINGING');
    });

    it('extends the quiet deadline when meaningful output resumes', () => {
      const id = 'defer-output-extension';
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });

      vi.advanceTimersByTime(4_000);
      manager.onData(id);
      vi.advanceTimersByTime(4_999);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');
      vi.advanceTimersByTime(1);
      expect(manager.getState(id).status).toBe('ALERT_RINGING');
    });

    it('does not defer an authoritative command-exit alert', () => {
      const id = 'immediate-command-exit';
      armCommandExit(id);
      vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
      driveToBusy(id);

      finishCommand(id);
      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        todo: true,
        notification: { source: 'COMMAND_EXIT', title: 'Command finished', body: 'pnpm build exited 0' },
      });
    });

    it('folds a pending terminal notification into an immediate command-exit ring', () => {
      const id = 'command-exit-with-pending-notification';
      armCommandExit(id);
      vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build done' });

      finishCommand(id);

      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        todo: true,
        // Protocol detail is richer than the generic command-exit receipt.
        notification: { source: 'OSC 9', title: null, body: 'Build done' },
      });
    });

    it('carries a deferred terminal notification across a command-boundary reset', () => {
      const id = 'defer-notification-across-finish';
      runCommand(id);
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });

      // This unarmed command finish resets the detector but is not itself an
      // alert; the pending terminal notification still owns its quiet deadline.
      finishCommand(id);
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });

      vi.advanceTimersByTime(5_000);
      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        todo: true,
        notification: { source: 'OSC 9', title: null, body: 'Done' },
      });
    });

    it('cancels deferred delivery when the user acknowledges', () => {
      const id = 'defer-attended';
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });

      manager.acknowledge(id, { input: false });
      vi.advanceTimersByTime(60_000);
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });
    });

    it('releases rather than drops deferred delivery when the setting is disabled', () => {
      const id = 'defer-disable';
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });

      manager.setDeferAlertsUntilQuiet(false);
      expect(manager.getState(id).status).toBe('ALERT_RINGING');
    });

    it('rings a deferred notification at the ceiling when output never goes quiet', () => {
      const id = 'defer-ceiling';
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'build failed' });

      heartbeat(id, cfg.alert.deferCeiling - 1_000);
      vi.advanceTimersByTime(999);
      expect(manager.getState(id).status).toBe('WATCHING_DISABLED');
      vi.advanceTimersByTime(1);
      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        notification: { source: 'OSC 9', title: null, body: 'build failed' },
      });
    });

    it('keeps the first deferral time when a later notification replaces the detail', () => {
      const id = 'defer-ceiling-latest';
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'First' });
      heartbeat(id, 20_000);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Second' });
      heartbeat(id, cfg.alert.deferCeiling - 21_000);
      vi.advanceTimersByTime(1_000);
      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        notification: { source: 'OSC 9', title: null, body: 'Second' },
      });
    });

    it('coalesces repeated protocol alerts to the latest detail', () => {
      const id = 'defer-latest-protocol';
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'First' });
      manager.notifyFromProtocol(id, { source: 'OSC 777', title: 'Second', body: null });

      vi.advanceTimersByTime(5_000);
      expect(manager.getState(id).notification).toEqual({
        source: 'OSC 777',
        title: 'Second',
        body: null,
      });
    });

    it('keeps richer deferred detail over a later bell', () => {
      const id = 'defer-richer-protocol';
      driveToBusy(id);
      // An agent's message, then a bell in the next read while it still animates.
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Build finished: 3 warnings' });
      manager.notifyFromProtocol(id, { source: 'BEL', title: 'Terminal bell', body: null });

      vi.advanceTimersByTime(5_000);
      expect(manager.getState(id)).toMatchObject({
        status: 'ALERT_RINGING',
        notification: { source: 'OSC 9', title: null, body: 'Build finished: 3 warnings' },
      });
    });

    it('offers a completion once and queues nothing when a claimant takes it', () => {
      const id = 'defer-claimed';
      driveToBusy(id);
      const seen = recordingClaimant(id, true);

      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });
      vi.advanceTimersByTime(60_000);

      expect(seen).toEqual([
        { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Done' } },
        { kind: 'settled' },
      ]);
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });
    });

    it('drops deferred delivery when the Session is removed', () => {
      const id = 'defer-remove';
      driveToBusy(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'Done' });

      manager.remove(id);
      vi.advanceTimersByTime(60_000);
      expect(manager.getState(id)).toEqual(DEFAULT_ALERT_STATE);
    });
  });

  // --- Ordered ingestion ---

  it('judges a notification written after a command finish against the reset detector', () => {
    const id = 'ordered-ingestion';
    const parser = new TerminalProtocolParser();
    const feed = (chunk: string): void => {
      const parsed = parser.process(chunk);
      applyTerminalEvents(manager, id, parsed.events);
      if (parsed.visibleData.length > 0) manager.onData(id);
    };
    feed('\x1b]633;E;./build.sh\x07\x1b]633;C\x07');
    for (let t = 0; t < 3_000; t += 200) {
      feed('compiling...\r\n');
      vi.advanceTimersByTime(200);
    }
    // A precmd hook reports after the shell's D and A, in the same read.
    feed('done\r\n\x1b]633;D;0\x07\x1b]633;A\x07\x1b]777;notify;Command completed;./build.sh\x1b\\$ ');

    expect(manager.getState(id)).toMatchObject({
      status: 'ALERT_RINGING',
      notification: { source: 'OSC 777', title: 'Command completed', body: './build.sh' },
    });
  });

  // --- Completion events (`docs/specs/alert.md` -> Completion events) ---

  describe('completion events', () => {
    it('claiming a settle keeps the WATCHING ring from ever latching', () => {
      const id = 'claim-settle';
      const seen = recordingClaimant(id, true);

      runWatchedCommand(id);
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
      driveToBusy(id);
      settle();

      expect(seen).toEqual([{ kind: 'settled' }]);
      expect(manager.getState(id).status).toBe('ALERT_RINGING');
    });

    it('reports a short engaged command finish that could never ring', () => {
      const id = 'observe-quick-command';
      const seen = recordingClaimant(id, false);

      engage(id);
      runCommand(id, 'npm test');
      vi.advanceTimersByTime(1_000);
      finishCommand(id);

      expect(seen).toEqual([{
        kind: 'commandFinished',
        displayCommand: 'npm test',
        watchKey: 'npm test',
        exitCode: 0,
        ranMs: 1_000,
        seen: true,
      }]);
      expect(manager.getState(id)).toMatchObject({
        status: 'WATCHING_DISABLED',
        todo: false,
        notification: null,
      });
    });

    it('claiming a seen command finish suppresses the COMMAND_EXIT ring', () => {
      const id = 'claim-command-exit';
      const seen = recordingClaimant(id, true);

      armCommandExit(id);
      vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
      expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

      finishCommand(id);

      expect(seen).toEqual([{
        kind: 'commandFinished',
        displayCommand: 'pnpm build',
        watchKey: 'pnpm build',
        exitCode: 0,
        ranMs: cfg.alert.commandExitMinRuntime,
        seen: true,
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

      armCommandExit(id);
      vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
      expect(manager.getState(id).status).toBe('COMMAND_EXIT_ARMED');

      manager.onExit(id, 1);

      expect(seen).toEqual([{
        event: {
          kind: 'commandFinished',
          displayCommand: 'pnpm build',
          watchKey: 'pnpm build',
          exitCode: 1,
          ranMs: cfg.alert.commandExitMinRuntime,
          seen: true,
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

    // 1. Already ringing at call time.

    it('leaves a TODO the human already had when it consumes a ring', async () => {
      const id = 'await-keeps-earlier-todo';
      manager.notifyFromProtocol(id, { source: 'OSC 777', title: 'earlier', body: null });
      manager.dismissAlert(id);
      manager.onData(id);
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'later' });
      expect(manager.getState(id).notification?.body).toBe('later');

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });

      expect(await handle.promise).toMatchObject({ kind: 'resolved', cause: 'bell' });
      expect(manager.getState(id)).toMatchObject({
        episode: null,
        todo: true,
        notification: { source: 'OSC 777', title: 'earlier', body: null },
      });
    });

    it('leaves no TODO whether the report arrived before or after the await parked', async () => {
      const parked = manager.awaitCompletion('await-first', { until: 'quiet', timeoutMs: NEVER });
      manager.notifyFromProtocol('await-first', { source: 'OSC 9', title: null, body: 'done' });
      expect(await parked.promise).toMatchObject({ kind: 'resolved', cause: 'bell' });

      // Already latched when the await arrives: it resolves on the spot and
      // withdraws the ring with the TODO it set.
      manager.notifyFromProtocol('bell-first', { source: 'OSC 9', title: null, body: 'done' });
      expect(manager.getState('bell-first')).toMatchObject({ status: 'ALERT_RINGING', todo: true });
      const consumed = manager.awaitCompletion('bell-first', { until: 'quiet', timeoutMs: NEVER });
      expect(await consumed.promise).toEqual({ kind: 'resolved', cause: 'bell', waitedMs: 0 });

      for (const id of ['await-first', 'bell-first']) {
        expect(manager.getState(id)).toMatchObject({
          status: 'WATCHING_DISABLED',
          todo: false,
          notification: null,
          awaited: false,
        });
      }
    });

    it('resolves on a latched WATCHING ring and withdraws its TODO', async () => {
      const id = 'await-standing-quiet';
      driveToRinging(id);
      expect(manager.getState(id).todo).toBe(true);

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
        ringFrom(id, 'exit');
        expect(manager.getState(id).todo).toBe(true);

        const handle = manager.awaitCompletion(id, { until, timeoutMs: NEVER });

        expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'exit', waitedMs: 0 });
        expect(manager.getState(id)).toMatchObject({ status: 'WATCHING_DISABLED', todo: false, notification: null });
      }
    });

    it('leaves a stale command-exit ring alone while a new command is running', async () => {
      const id = 'await-stale-exit-ring';
      ringFrom(id, 'exit');

      // A second command starts. The latched ring above belongs to the first —
      // `startCommandExitWatch` preserves `ALERT_RINGING` on purpose — so it
      // cannot be an answer about the one now running.
      runCommand(id, 'npm test');

      const handle = manager.awaitCompletion(id, { until: 'exit', timeoutMs: NEVER });
      const outcome = watch(handle);
      expect(await outcome()).toBeNull();
      // Not consumed either: the ring is still the human's.
      expect(manager.getState(id).status).toBe('ALERT_RINGING');

      finishCommand(id);
      expect(await outcome()).toMatchObject({ kind: 'resolved', cause: 'exit' });
    });

    it.each([
      // The real `dor send … && dor await …` shape: two CLI round trips, so the
      // await lands a few hundred ms after output resumed — inside the window
      // where the detector is still NOTHING_TO_SHOW, since it does not leave
      // that state until busyCandidateGap (1500ms) after the first chunk. That
      // window is why the gate is a flag on the entry rather than the detector's
      // own status.
      ["within the detector's busy-candidate window", 100],
      // And once the detector has noticed the output for itself.
      ['after the detector has noticed the output', 800],
    ] as const)('leaves a stale WATCHING ring alone once output has resumed, %s', async (_label, gapMs) => {
      const id = `await-stale-watching-ring-${gapMs}`;
      // Keep the latched ring across resumed output: deferral would withdraw it.
      manager.setDeferAlertsUntilQuiet(false);
      driveToRinging(id);

      // The peer was sent another turn and is talking again. Nothing clears the
      // latched ring — it is still the human's — but the quiet it describes is
      // over, so it cannot answer "output stopped" about the turn in flight.
      manager.onData(id);
      vi.advanceTimersByTime(gapMs);
      manager.onData(id);
      vi.advanceTimersByTime(gapMs);
      manager.onData(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      const outcome = watch(handle);
      expect(await outcome()).toBeNull();
      // Not consumed either: the stale ring is still the human's.
      expect(manager.getState(id).status).toBe('ALERT_RINGING');

      // The turn finishes for real, and that is what answers the caller.
      driveToBusy(id);
      settle();
      expect(await outcome()).toMatchObject({ kind: 'resolved', cause: 'quiet' });
    });

    it('leaves a stale WATCHING ring alone after a burst too sparse to confirm BUSY', async () => {
      const id = 'await-stale-watching-ring-sparse';
      driveToRinging(id);

      // Output that reaches MIGHT_BE_BUSY and then stops: the confirm timer
      // returns the detector to NOTHING_TO_SHOW without ever settling, so the
      // latch is untouched and the detector's status is back where it started.
      manager.onData(id);
      vi.advanceTimersByTime(1_600);
      manager.onData(id);
      vi.advanceTimersByTime(10_000);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      const outcome = watch(handle);
      expect(await outcome()).toBeNull();

      driveToBusy(id);
      settle();
      expect(await outcome()).toMatchObject({ kind: 'resolved', cause: 'quiet' });
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

    it('never acknowledges, so the next completion still rings the human', async () => {
      const id = 'await-does-not-attend';
      driveToRinging(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      expect(await handle.promise).toMatchObject({ kind: 'resolved', cause: 'quiet' });

      // An acknowledgement would record the settle as answered.
      driveToBusy(id);
      settle();
      expect(manager.getState(id).status).toBe('ALERT_RINGING');
    });

    // 2. Claiming the first qualifying completion.

    it('resolves quiet on a settle, claiming it before any ring rule runs', async () => {
      const id = 'await-quiet-settle';
      runWatchedCommand(id);

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
    ] as const)('keeps a parked quiet await armed when the user engages and acknowledges during %s', async (_status, beforeAttendMs, afterAttendMs) => {
      const id = `await-quiet-attended-${_status}`;
      runWatchedCommand(id);

      const handle = manager.awaitCompletion(id, { until: 'quiet', timeoutMs: NEVER });
      driveToBusy(id);
      vi.advanceTimersByTime(beforeAttendMs);
      expect(manager.getState(id).status).toBe(_status);

      engage(id);
      manager.acknowledge(id, { input: false });
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
      finishCommand(id, 2);

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

      const handle = manager.awaitCompletion(id, { until: 'exit', timeoutMs: NEVER });
      const outcome = watch(handle);

      // A build tool that BELs on a warning must not wake the strict caller...
      manager.notifyFromProtocol(id, { source: 'OSC 9', title: null, body: 'deprecation warning' });
      expect(await outcome()).toBeNull();

      // ...and neither must falling silent mid-run.
      driveToBusy(id);
      settle();
      expect(await outcome()).toBeNull();

      finishCommand(id);
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

      finishCommand(id);
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

      finishCommand(id);
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

      finishCommand(id);
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
