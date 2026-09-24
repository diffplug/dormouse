import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager, type ActivityNotification, type AwaitOutcome } from './alert-manager';
import { applyTerminalEvents, TerminalProtocolParser } from './terminal-protocol';
import { cfg } from '../cfg';
import { collectEpisodes, engage, finishCommand, goIdle, leave, runCommand, VIEWER } from './alert-manager-test-utils';
import { alertedPty, createOwnerPtyStream } from '../host/owner-pty';

/**
 * Engagement (`docs/specs/alert.md` -> Engagement): presence and focus arrive
 * per viewer, a completion on an engaged Session is held, and what ends the
 * engagement decides whether the held completion rings or is dropped.
 */

const PANE = 'pane';
const OTHER = 'other';

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

/** One step of a replayed timeline, due `at` ms in. */
interface Step { at: number; step: () => void }

function at(ms: number, step: () => void): Step {
  return { at: ms, step };
}

/**
 * Runs `steps` in time order, ties in list order, advancing the clock between
 * them; each `to` resumes where the last one stopped.
 */
function player(steps: Step[]): { to(ms: number): void } {
  const queue = [...steps].sort((a, b) => a.at - b.at);
  let now = 0;
  return {
    to(ms) {
      while (queue.length > 0 && queue[0].at <= ms) {
        const next = queue.shift()!;
        vi.advanceTimersByTime(next.at - now);
        now = next.at;
        next.step();
      }
      vi.advanceTimersByTime(ms - now);
      now = ms;
    },
  };
}

/** A watched command, busy and then quiet: the settle a WATCHING ring needs. */
function watchedTurn(id: string): void {
  manager.setWatchedCommands(['claude']);
  runCommand(manager, id, 'claude');
  output(id, 3_000);
  vi.advanceTimersByTime(5_000);
}

/** A seen command that outlasted the minimum runtime, finished while engaged. */
function longRunFinishedEngaged(id: string): void {
  engage(manager, id);
  runCommand(manager, id, 'pnpm build');
  vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
  finishCommand(manager, id, 2, { promptStart: true });
}

describe('held completions', () => {
  it.each([
    ['report', (id: string) => manager.notifyFromProtocol(id, PERMISSION)],
    ['settle', (id: string) => watchedTurn(id)],
    ['exit', (id: string) => { runCommand(manager, id, 'pnpm build'); vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime); finishCommand(manager, id, 0, { promptStart: true }); }],
  ] as const)('holds a %s while engaged and rings it once presence lapses from inactivity', (_kind, complete) => {
    manager.onData(PANE);
    engage(manager, PANE);
    complete(PANE);
    expect(ringing(PANE)).toBe(false);
    expect(manager.getState(PANE).todo).toBe(false);

    goIdle(manager, PANE);
    expect(manager.getState(PANE)).toMatchObject({ status: 'ALERT_RINGING', todo: true });
  });

  it.each([
    ['the window leaving', () => leave(manager)],
    ['focus moving to another pane', () => engage(manager, OTHER)],
    ['focus moving away while presence lapses', () => manager.setViewer(VIEWER, { present: false, focusId: OTHER }, 'idle')],
    ['the viewer going away', () => manager.removeViewer(VIEWER)],
  ] as const)('drops a held completion on an explicit disengage: %s', (_how, disengage) => {
    manager.onData(PANE);
    engage(manager, PANE);
    manager.notifyFromProtocol(PANE, PERMISSION);

    disengage();
    vi.advanceTimersByTime(120_000);
    goIdle(manager, PANE);
    expect(manager.getState(PANE)).toMatchObject({ status: 'WATCHING_DISABLED', todo: false, notification: null });
  });

  it('rings a held exit with its exit code', () => {
    longRunFinishedEngaged(PANE);
    expect(ringing(PANE)).toBe(false);
    goIdle(manager, PANE);
    expect(manager.getState(PANE).notification).toEqual({
      source: 'COMMAND_EXIT', title: 'Command finished', body: 'pnpm build exited 2',
    });
  });

  it('escalates with the richest detail it held', () => {
    manager.onData(PANE);
    engage(manager, PANE);
    manager.notifyFromProtocol(PANE, PERMISSION);
    manager.notifyFromProtocol(PANE, BELL);
    goIdle(manager, PANE);
    expect(manager.getState(PANE).notification).toEqual(PERMISSION);
  });

  it('sends an escalated report through animation deferral', () => {
    output(PANE, 3_000);
    engage(manager, PANE);
    manager.notifyFromProtocol(PANE, PERMISSION);
    output(PANE, 1_000);

    goIdle(manager, PANE);
    // Still animating: the report waits for quiet, like any other.
    expect(ringing(PANE)).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(PANE)).toMatchObject({ status: 'ALERT_RINGING', notification: PERMISSION });
  });

  it('holds a deferred report that comes due while engaged', () => {
    output(PANE, 3_000);
    manager.notifyFromProtocol(PANE, PERMISSION);
    engage(manager, PANE);
    vi.advanceTimersByTime(5_000);
    expect(ringing(PANE)).toBe(false);

    goIdle(manager, PANE);
    expect(manager.getState(PANE)).toMatchObject({ status: 'ALERT_RINGING', notification: PERMISSION });
  });

  it('acknowledging drops what was held and records it as answered', () => {
    manager.setWatchedCommands(['claude']);
    engage(manager, PANE);
    watchedTurn(PANE);
    manager.acknowledge(PANE, { input: false });
    goIdle(manager, PANE);
    expect(ringing(PANE)).toBe(false);

    // Claude's idle ping about the same turn is a receipt, not a second summons.
    manager.notifyFromProtocol(PANE, { source: 'OSC 99', title: 'Claude Code', body: 'Claude is waiting for your input' });
    expect(manager.getState(PANE)).toMatchObject({ status: 'NOTHING_TO_SHOW', todo: true });
  });

  it('withdraws a held settle once watched work resumes', () => {
    engage(manager, PANE);
    watchedTurn(PANE);
    output(PANE, 3_000);
    goIdle(manager, PANE);
    expect(ringing(PANE)).toBe(false);
  });
});

describe('viewers', () => {
  it('lets no viewer disengage a Session another viewer engages', () => {
    // Two VS Code webviews on one manager: the user clicks into webview B,
    // and webview A's blur arrives after.
    engage(manager, 'p1', 'webview-a');
    runCommand(manager, 'p2', 'cargo build');
    engage(manager, 'p2', 'webview-b');
    leave(manager, 'webview-a');

    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
    finishCommand(manager, 'p2', 0, { promptStart: true });
    expect(ringing('p2')).toBe(false);
  });

  it('derives the command-exit arm from engagement, publishing each edge', () => {
    const statuses: string[] = [];
    manager.onStateChange((id, state) => { if (id === PANE) statuses.push(state.status); });
    engage(manager, PANE);
    runCommand(manager, PANE, 'pnpm build');
    expect(manager.getState(PANE).status).toBe('WATCHING_DISABLED');

    leave(manager);
    expect(manager.getState(PANE).status).toBe('COMMAND_EXIT_ARMED');
    engage(manager, PANE);
    expect(manager.getState(PANE).status).toBe('WATCHING_DISABLED');
    expect(statuses).toEqual(['WATCHING_DISABLED', 'COMMAND_EXIT_ARMED', 'WATCHING_DISABLED']);
  });

  it('counts an acknowledgement as seeing the running command', () => {
    runCommand(manager, PANE, 'pnpm build');
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
    runCommand(manager, PANE, 'claude');
    engage(manager, PANE);
    typeFor(PANE, 3_000);
    expect(manager.getState(PANE).status).toBe('NOTHING_TO_SHOW');

    // The draft is left unsubmitted and the user clicks another pane.
    engage(manager, OTHER);
    vi.advanceTimersByTime(10_000);
    expect(ringing(PANE)).toBe(false);
  });

  it('does not resolve a quiet await on a half-typed draft', async () => {
    runCommand(manager, PANE, 'claude');
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
    ['the exit Ctrl-C caused', () => { vi.advanceTimersByTime(20); finishCommand(manager, PANE, 130, { promptStart: true }); }],
    ['a bell answering Tab', () => { vi.advanceTimersByTime(5); manager.notifyFromProtocol(PANE, BELL); }],
  ] as const)('neither rings nor holds %s', (_what, answer) => {
    engage(manager, PANE);
    runCommand(manager, PANE, 'pnpm build');
    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
    manager.acknowledge(PANE, { input: true });
    answer();
    goIdle(manager, PANE);
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
    const steps = [at(0, () => { engage(manager, PANE); runCommand(manager, PANE, 'claude'); })];
    // First paint.
    for (let t = 230; t < 830; t += 100) steps.push(at(t, () => manager.onData(PANE)));
    // The prompt, typed at 40ms a key, each key echoed.
    for (let t = 6_000; t <= 9_000; t += 40) {
      steps.push(at(t, () => manager.acknowledge(PANE, { input: true })), at(t + 7, () => manager.onData(PANE)));
    }
    steps.push(at(ENTER_AT, () => manager.acknowledge(PANE, { input: true })));
    // Working, then the permission prompt drawn.
    for (let t = 9_390; t < 11_960; t += 110) steps.push(at(t, () => manager.onData(PANE)));
    steps.push(at(17_960, () => applyTerminalEvents(manager, PANE, parser.process(OSC99).events)));
    // The idle prompt's cursor redraw.
    for (let t = 12_415; t < untilMs; t += 605) steps.push(at(t, () => manager.onData(PANE)));
    // The renderer's presence lapses 15s after the last input.
    steps.push(at(ENTER_AT + cfg.alert.inactivityTimeout, () => goIdle(manager, PANE)));
    player(steps).to(untilMs);
  }

  it('holds the permission request while the user is still there', () => {
    replay(ENTER_AT + cfg.alert.inactivityTimeout - 1);
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

/**
 * One Claude Code 2.1.281 turn, recorded under the iTerm2 3.6.6 identity
 * (2026-09-23, `claude --model haiku`, a one-sentence answer), which Claude
 * answers with progress reports: `OSC 9;4;3` 47ms after Enter, a frame about
 * every 110ms, `OSC 9;4;0` 1.8s after Enter and one trailing frame, then
 * silence until its idle `OSC 99` 60s later. Replayed as bytes through the
 * host's parse site and input path; a longer answer only adds frames.
 */
describe('a Claude Code turn', () => {
  const ENTER_AT = 8_236;
  const RECORDED_TURN_MS = 1_785;
  const LONG_TURN_MS = 8_000;
  const IDLE_NOTICE_AFTER_MS = 60_011;
  const QUIET_MS = cfg.alert.mightNeedAttention + cfg.alert.needsAttentionConfirm;
  const IDLE_NOTICE = '\x1b]99;i=3319:d=0:p=title;Claude Code\x07\x1b]99;i=3319:p=body;Claude is waiting for your input\x07\x1b]99;i=3319:d=1:a=focus;\x07';
  const FINISHED: ActivityNotification = { source: 'OSC 9;4', title: 'claude finished', body: null };
  /** The user clicks another pane mid-turn. */
  const MOVED_AWAY = at(ENTER_AT + 600, () => engage(manager, OTHER));

  let emit: (ms: number, data: string) => Step;
  let key: (ms: number, data: string) => Step;
  let episodes: Set<string>;

  beforeEach(() => {
    const stream = createOwnerPtyStream(PANE, {
      alerts: manager,
      colorProvider: () => null,
      onToolEvents() {},
      onSemanticEvents() {},
      writeResponse() {},
      onChunk() {},
    });
    const pty = alertedPty(manager, { write() {}, resize() {} });
    emit = (ms, data) => at(ms, () => stream.write(data));
    key = (ms, data) => at(ms, () => pty.write(PANE, data, { userInput: true }));
    episodes = collectEpisodes(manager, PANE);
  });

  /** The turn on the pane the user starts at: the prompt typed and submitted, then Claude working for `turnMs`. */
  function turn(turnMs: number): Step[] {
    const endAt = ENTER_AT + turnMs;
    const steps = [
      at(0, () => engage(manager, PANE)),
      // Shell integration names the command; Claude paints and clears any stale progress.
      emit(0, '\x1b]633;E;claude\x07\x1b]633;C\x07'),
      emit(358, 'Claude Code'),
      emit(715, '\x1b]9;4;0;\x07'),
      emit(945, '> '),
      key(ENTER_AT, '\r'),
      emit(ENTER_AT + 47, '\x1b]9;4;3;\x07'),
      emit(endAt, '\x1b]9;4;0;\x07'),
      emit(endAt + 3, 'Worked for 1s'),
      emit(endAt + IDLE_NOTICE_AFTER_MS, IDLE_NOTICE),
    ];
    // The prompt, a key every 42ms, each echoed.
    for (let t = 6_003; t < 7_900; t += 42) steps.push(key(t, 'x'), emit(t + 12, 'x'));
    for (let t = ENTER_AT + 49; t < endAt; t += 110) steps.push(emit(t, 'frame'));
    return steps;
  }

  it('holds the finish while the user watches, and drops it once they type', () => {
    const endAt = ENTER_AT + RECORDED_TURN_MS;
    const typedAt = endAt + 2_000;
    const run = player([
      ...turn(RECORDED_TURN_MS),
      key(typedAt, 'x'),
      at(typedAt + cfg.alert.inactivityTimeout, () => goIdle(manager, PANE)),
    ]);

    run.to(typedAt - 1);
    expect(manager.getState(PANE)).toMatchObject({ todo: false, notification: null });
    run.to(endAt + IDLE_NOTICE_AFTER_MS - 1);
    expect(episodes.size).toBe(0);
    expect(manager.getState(PANE)).toMatchObject({ todo: false, notification: null });
  });

  it.each([
    ['at the end of the recorded turn, too short to look busy', RECORDED_TURN_MS, 0],
    ['once a longer turn has gone quiet', LONG_TURN_MS, 3 + QUIET_MS],
  ] as const)('rings "claude finished" once when the user moved away mid-turn: %s', (_when, turnMs, afterEndMs) => {
    const ringAt = ENTER_AT + turnMs + afterEndMs;
    const run = player([...turn(turnMs), MOVED_AWAY]);

    run.to(ringAt - 1);
    expect(ringing(PANE)).toBe(false);
    run.to(ringAt);
    expect(manager.getState(PANE)).toMatchObject({ status: 'ALERT_RINGING', todo: true, notification: FINISHED });
    run.to(ringAt + 30_000);
    expect(episodes.size).toBe(1);
  });

  it('records the idle notice after a click on the ring as TODO, without a second summons', () => {
    const endAt = ENTER_AT + RECORDED_TURN_MS;
    const clickAt = endAt + 5_000;
    const run = player([
      ...turn(RECORDED_TURN_MS),
      MOVED_AWAY,
      at(clickAt, () => { engage(manager, PANE); manager.acknowledge(PANE, { input: false }); }),
      at(clickAt + cfg.alert.inactivityTimeout, () => goIdle(manager, PANE)),
    ]);

    run.to(endAt + IDLE_NOTICE_AFTER_MS);
    expect(ringing(PANE)).toBe(false);
    expect(manager.getState(PANE)).toMatchObject({
      todo: true,
      notification: { source: 'OSC 99', title: 'Claude Code', body: 'Claude is waiting for your input' },
    });
    expect(episodes.size).toBe(1);
  });

  it('rings once the user, still focused on the pane, has gone idle', () => {
    const idleAt = ENTER_AT + cfg.alert.inactivityTimeout;
    const run = player([...turn(RECORDED_TURN_MS), at(idleAt, () => goIdle(manager, PANE))]);

    run.to(idleAt - 1);
    expect(manager.getState(PANE)).toMatchObject({ todo: false, notification: null });
    run.to(idleAt);
    expect(manager.getState(PANE)).toMatchObject({ status: 'ALERT_RINGING', todo: true, notification: FINISHED });
  });
});
