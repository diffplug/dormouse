import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager, type ActivityNotification, type AwaitOutcome } from './alert-manager';
import { applyTerminalProtocolEvents, TerminalProtocolParser } from './terminal-protocol';
import { cfg } from '../cfg';

/**
 * Engagement (`docs/specs/alert.md` -> Engagement): presence and focus arrive
 * per viewer, a completion on an engaged Session is held, and what ends the
 * engagement decides whether the held completion rings or is dropped.
 */

const PANE = 'pane';
const OTHER = 'other';
const VIEWER = 'viewer';

const PERMISSION: ActivityNotification = { source: 'OSC 9', title: null, body: 'Claude needs your permission' };
const BELL: ActivityNotification = { source: 'BEL', title: 'Terminal bell', body: null };

let manager: AlertManager;

beforeEach(() => {
  vi.useFakeTimers();
  manager = new AlertManager();
});

afterEach(() => {
  manager.dispose();
  vi.useRealTimers();
});

function engage(id: string, viewer = VIEWER): void {
  manager.setViewer(viewer, { present: true, focusId: id });
}

/** Focus moved off, or the window blurred or hid. */
function leave(viewer = VIEWER): void {
  manager.setViewer(viewer, { present: false, focusId: null }, 'leave');
}

/** No input for the inactivity timeout; focus unchanged. */
function goIdle(id: string, viewer = VIEWER): void {
  manager.setViewer(viewer, { present: false, focusId: id }, 'idle');
}

function runCommand(id: string, commandLine: string): void {
  manager.applyTerminalSemanticEvents(id, [
    { type: 'commandLine', commandLine },
    { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
  ]);
}

function finishCommand(id: string, exitCode = 0): void {
  manager.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode }, { type: 'promptStart' }]);
}

/** Output every `everyMs` for `ms`. */
function output(id: string, ms: number, everyMs = 100): void {
  for (let t = 0; t < ms; t += everyMs) {
    vi.advanceTimersByTime(everyMs);
    manager.onData(id);
  }
}

/** One keystroke into the pane, echoed a few ms later. */
function keystroke(id: string): void {
  manager.acknowledge(id, { input: true });
  vi.advanceTimersByTime(8);
  manager.onData(id);
}

/** Type at ~7 keys a second for `ms`. */
function typeFor(id: string, ms: number): void {
  for (let t = 0; t < ms; t += 140) {
    keystroke(id);
    vi.advanceTimersByTime(132);
  }
}

function ringing(id: string): boolean {
  return manager.getState(id).status === 'ALERT_RINGING';
}

/** A watched command, busy and then quiet: the settle a WATCHING ring needs. */
function watchedTurn(id: string): void {
  manager.setWatchedCommands(['claude']);
  runCommand(id, 'claude');
  output(id, 3_000);
  vi.advanceTimersByTime(5_000);
}

/** A seen command that outlasted the minimum runtime, finished while engaged. */
function longRunFinishedEngaged(id: string): void {
  engage(id);
  runCommand(id, 'pnpm build');
  vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
  finishCommand(id, 2);
}

describe('held completions', () => {
  it.each([
    ['report', (id: string) => manager.notifyFromProtocol(id, PERMISSION)],
    ['settle', (id: string) => watchedTurn(id)],
    ['exit', (id: string) => { runCommand(id, 'pnpm build'); vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime); finishCommand(id); }],
  ] as const)('holds a %s while engaged and rings it once presence lapses from inactivity', (_kind, complete) => {
    manager.onData(PANE);
    engage(PANE);
    complete(PANE);
    expect(ringing(PANE)).toBe(false);
    expect(manager.getState(PANE).todo).toBe(false);

    goIdle(PANE);
    expect(manager.getState(PANE)).toMatchObject({ status: 'ALERT_RINGING', todo: true });
  });

  it.each([
    ['the window leaving', () => leave()],
    ['focus moving to another pane', () => engage(OTHER)],
    ['focus moving away while presence lapses', () => manager.setViewer(VIEWER, { present: false, focusId: OTHER }, 'idle')],
    ['the viewer going away', () => manager.removeViewer(VIEWER)],
  ] as const)('drops a held completion on an explicit disengage: %s', (_how, disengage) => {
    manager.onData(PANE);
    engage(PANE);
    manager.notifyFromProtocol(PANE, PERMISSION);

    disengage();
    vi.advanceTimersByTime(120_000);
    goIdle(PANE);
    expect(manager.getState(PANE)).toMatchObject({ status: 'WATCHING_DISABLED', todo: false, notification: null });
  });

  it('rings a held exit with its exit code', () => {
    longRunFinishedEngaged(PANE);
    expect(ringing(PANE)).toBe(false);
    goIdle(PANE);
    expect(manager.getState(PANE).notification).toEqual({
      source: 'COMMAND_EXIT', title: 'Command finished', body: 'pnpm build exited 2',
    });
  });

  it('escalates with the richest detail it held', () => {
    manager.onData(PANE);
    engage(PANE);
    manager.notifyFromProtocol(PANE, PERMISSION);
    manager.notifyFromProtocol(PANE, BELL);
    goIdle(PANE);
    expect(manager.getState(PANE).notification).toEqual(PERMISSION);
  });

  it('sends an escalated report through animation deferral', () => {
    output(PANE, 3_000);
    engage(PANE);
    manager.notifyFromProtocol(PANE, PERMISSION);
    output(PANE, 1_000);

    goIdle(PANE);
    // Still animating: the report waits for quiet, like any other.
    expect(ringing(PANE)).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(PANE)).toMatchObject({ status: 'ALERT_RINGING', notification: PERMISSION });
  });

  it('holds a deferred report that comes due while engaged', () => {
    output(PANE, 3_000);
    manager.notifyFromProtocol(PANE, PERMISSION);
    engage(PANE);
    vi.advanceTimersByTime(5_000);
    expect(ringing(PANE)).toBe(false);

    goIdle(PANE);
    expect(manager.getState(PANE)).toMatchObject({ status: 'ALERT_RINGING', notification: PERMISSION });
  });

  it('acknowledging drops what was held and records it as answered', () => {
    manager.setWatchedCommands(['claude']);
    engage(PANE);
    watchedTurn(PANE);
    manager.acknowledge(PANE, { input: false });
    goIdle(PANE);
    expect(ringing(PANE)).toBe(false);

    // Claude's idle ping about the same turn is a receipt, not a second summons.
    manager.notifyFromProtocol(PANE, { source: 'OSC 99', title: 'Claude Code', body: 'Claude is waiting for your input' });
    expect(manager.getState(PANE)).toMatchObject({ status: 'NOTHING_TO_SHOW', todo: true });
  });

  it('withdraws a held settle once watched work resumes', () => {
    engage(PANE);
    watchedTurn(PANE);
    output(PANE, 3_000);
    goIdle(PANE);
    expect(ringing(PANE)).toBe(false);
  });
});

describe('viewers', () => {
  it('lets no viewer disengage a Session another viewer engages', () => {
    // Two VS Code webviews on one manager: the user clicks into webview B,
    // and webview A's blur arrives after.
    engage('p1', 'webview-a');
    runCommand('p2', 'cargo build');
    engage('p2', 'webview-b');
    leave('webview-a');

    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
    finishCommand('p2');
    expect(ringing('p2')).toBe(false);
  });

  it('derives the command-exit arm from engagement, publishing each edge', () => {
    const statuses: string[] = [];
    manager.onStateChange((id, state) => { if (id === PANE) statuses.push(state.status); });
    engage(PANE);
    runCommand(PANE, 'pnpm build');
    expect(manager.getState(PANE).status).toBe('WATCHING_DISABLED');

    leave();
    expect(manager.getState(PANE).status).toBe('COMMAND_EXIT_ARMED');
    engage(PANE);
    expect(manager.getState(PANE).status).toBe('WATCHING_DISABLED');
    expect(statuses).toEqual(['WATCHING_DISABLED', 'COMMAND_EXIT_ARMED', 'WATCHING_DISABLED']);
  });

  it('counts an acknowledgement as seeing the running command', () => {
    runCommand(PANE, 'pnpm build');
    expect(manager.getState(PANE).status).toBe('WATCHING_DISABLED');
    manager.acknowledge(PANE, { input: false });
    expect(manager.getState(PANE).status).toBe('COMMAND_EXIT_ARMED');
  });
});

describe('acknowledge', () => {
  it('turns TODO off on any keystroke, and leaves it on for a click', () => {
    manager.onData(PANE);
    manager.toggleTodo(PANE);
    manager.acknowledge(PANE, { input: false });
    expect(manager.getState(PANE).todo).toBe(true);

    manager.acknowledge(PANE, { input: true });
    expect(manager.getState(PANE)).toMatchObject({ todo: false, notification: null });
  });

  it('never creates an entry for an id it does not know', () => {
    manager.acknowledge('browser-1', { input: false });
    manager.acknowledge('browser-1', { input: true });
    manager.dismissAlert('browser-1');
    expect(manager.getAllStates().has('browser-1')).toBe(false);
  });
});

describe('echo window', () => {
  it('never builds BUSY from the echo of the user typing', () => {
    manager.setWatchedCommands(['claude']);
    runCommand(PANE, 'claude');
    engage(PANE);
    typeFor(PANE, 3_000);
    expect(manager.getState(PANE).status).toBe('NOTHING_TO_SHOW');

    // The draft is left unsubmitted and the user clicks another pane.
    engage(OTHER);
    vi.advanceTimersByTime(10_000);
    expect(ringing(PANE)).toBe(false);
  });

  it('does not resolve a quiet await on a half-typed draft', async () => {
    runCommand(PANE, 'claude');
    const handle = manager.awaitCompletion(PANE, { until: 'quiet', timeoutMs: 600_000 });
    let outcome: AwaitOutcome | undefined;
    void handle.promise.then((value) => { outcome = value; });
    typeFor(PANE, 3_000);
    vi.advanceTimersByTime(6_000);
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    handle.cancel();
  });

  it('counts output once the window has passed', () => {
    manager.acknowledge(PANE, { input: false });
    manager.onData(PANE);
    manager.acknowledge(PANE, { input: true });
    vi.advanceTimersByTime(cfg.alert.echoWindow);
    output(PANE, 2_000);
    // Confirmed busy, so a report now waits for quiet.
    manager.notifyFromProtocol(PANE, BELL);
    expect(ringing(PANE)).toBe(false);
  });

  it.each([
    ['the exit Ctrl-C caused', () => { vi.advanceTimersByTime(20); finishCommand(PANE, 130); }],
    ['a bell answering Tab', () => { vi.advanceTimersByTime(5); manager.notifyFromProtocol(PANE, BELL); }],
  ] as const)('neither rings nor holds %s', (_what, answer) => {
    engage(PANE);
    runCommand(PANE, 'pnpm build');
    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
    manager.acknowledge(PANE, { input: true });
    answer();
    goIdle(PANE);
    expect(ringing(PANE)).toBe(false);
    expect(manager.getState(PANE)).toMatchObject({ todo: false, notification: null });
  });
});

/**
 * A synthetic timeline with the timings of a recorded Claude Code 2.1 session
 * (2026-09-23, under `TERM_PROGRAM=iTerm.app`): the user types a prompt,
 * submits it, and sits back without touching anything; Claude asks for
 * permission eight seconds later, then redraws its prompt cursor every 600ms.
 */
describe('walking away from a permission prompt', () => {
  const OSC99 = '\x1b]99;i=6875:d=0:p=title;Claude Code\x1b\\\x1b]99;i=6875:p=body;Claude needs your permission\x1b\\\x1b]99;i=6875:d=1:a=focus;\x1b\\';
  const ENTER_AT = 9_300;

  function replay(untilMs: number): void {
    const parser = new TerminalProtocolParser();
    const timeline: { at: number; step: () => void }[] = [];
    timeline.push({ at: 0, step: () => { engage(PANE); runCommand(PANE, 'claude'); } });
    // First paint.
    for (let at = 230; at < 830; at += 100) timeline.push({ at, step: () => manager.onData(PANE) });
    // The prompt, typed at 40ms a key, each key echoed.
    for (let at = 6_000; at <= 9_000; at += 40) {
      timeline.push({ at, step: () => manager.acknowledge(PANE, { input: true }) });
      timeline.push({ at: at + 7, step: () => manager.onData(PANE) });
    }
    timeline.push({ at: ENTER_AT, step: () => manager.acknowledge(PANE, { input: true }) });
    // Working, then the permission prompt drawn.
    for (let at = 9_390; at < 11_960; at += 110) timeline.push({ at, step: () => manager.onData(PANE) });
    timeline.push({ at: 17_960, step: () => applyTerminalProtocolEvents(manager, PANE, parser.process(OSC99).events) });
    // The idle prompt's cursor redraw.
    for (let at = 12_415; at < untilMs; at += 605) timeline.push({ at, step: () => manager.onData(PANE) });
    // The renderer's presence lapses 15s after the last input.
    timeline.push({ at: ENTER_AT + cfg.alert.userAttention, step: () => goIdle(PANE) });

    timeline.sort((a, b) => a.at - b.at);
    let now = 0;
    for (const { at, step } of timeline) {
      if (at > untilMs) break;
      vi.advanceTimersByTime(at - now);
      now = at;
      step();
    }
    vi.advanceTimersByTime(untilMs - now);
  }

  it('holds the permission request while the user is still there', () => {
    replay(ENTER_AT + cfg.alert.userAttention - 1);
    expect(manager.getState(PANE)).toMatchObject({ todo: false, notification: null });
  });

  it('rings it once the user has gone quiet, through the redraw that never stops', () => {
    replay(120_000);
    expect(manager.getState(PANE)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
      notification: { body: 'Claude needs your permission' },
    });
  });
});
