import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';
import { createAlertDeliveryScheduler, type AlertDeliveryScheduler } from './alert-delivery-scheduler';
import { DEFAULT_ALERT_SETTINGS } from './alert-settings-model';
import { armCommandExit, driveToBusy, driveToCandidate, engage, finishCommand, goIdle, heartbeat, press, REPORT, runCommand, settle, work } from './alert-manager-test-utils';
import { toPersistedAlertState } from './session-types';
import { createOwnerPtyStream } from '../host/owner-pty';

const ID = 'resumed-work';
const WATCHED = 'longtask';
const DELAY = 10_000;
let manager: AlertManager;
let scheduler: AlertDeliveryScheduler;
let spoken: ReturnType<typeof vi.fn>;
let pushed: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  spoken = vi.fn();
  pushed = vi.fn();
  manager = new AlertManager();
  manager.setWatchedCommands([WATCHED]);
  runCommand(manager, ID, WATCHED);
  scheduler = createAlertDeliveryScheduler({ manager, speak: spoken, push: pushed });
  scheduler.setDefaults({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: DELAY, pushEnabled: true, pushDelayMs: DELAY });
});
afterEach(() => {
  scheduler.dispose();
  manager.dispose();
  vi.useRealTimers();
});
/** Output every 100ms for `ms`: dense enough to confirm work. */
function burst(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    vi.advanceTimersByTime(100);
    manager.onData(ID);
  }
}
function ring(source: 'watching' | 'report'): void {
  if (source === 'report') manager.notifyFromProtocol(ID, REPORT);
  else { driveToBusy(manager, ID); settle(); }
}

describe('owed alerts during resumed output', () => {
  it('releases a deferred report despite one new chunk while a claimant takes the settle', () => {
    driveToBusy(manager, ID);
    manager.notifyFromProtocol(ID, REPORT);
    vi.advanceTimersByTime(1_000);
    manager.onData(ID);
    manager.registerCompletionClaimant(ID, (event) => {
      if (event.kind !== 'settled') return false;
      work(manager, ID);
      return true;
    });
    settle();
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
  });
  it.each(['watching', 'report'] as const)('keeps a %s ringing through candidate activity, deferring it once work is confirmed, on its original alarm deadlines', (source) => {
    ring(source);
    const episode = manager.getState(ID).episode;
    vi.advanceTimersByTime(1_000);
    driveToCandidate(manager, ID);
    // A candidate alone would blink the ring with every sparse redraw.
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    manager.onData(ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'BUSY', episode, todo: false });
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    // Due a full delay after the ring opened, not after it came back.
    vi.advanceTimersByTime(episode!.startedAt + DELAY - Date.now() - 1);
    expect(spoken).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spoken).toHaveBeenCalledExactlyOnceWith(ID, episode!.id);
    expect(pushed).toHaveBeenCalledOnce();
  });
  it.each(['watching', 'report'] as const)('keeps a %s past its deadlines during output, then delivers once on quiet', (source) => {
    ring(source);
    const episode = manager.getState(ID).episode;
    // Another turn starts, and runs for two minutes.
    work(manager, ID);
    heartbeat(manager, ID, 120_000);
    expect(manager.getState(ID).status).not.toBe('ALERT_RINGING');
    expect(manager.getState(ID).episode).toEqual(episode);
    expect(spoken).not.toHaveBeenCalled();
    expect(pushed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_999);
    expect(spoken).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    expect(spoken).toHaveBeenCalledExactlyOnceWith(ID, episode!.id);
    expect(pushed).toHaveBeenCalledOnce();
  });
  it('does not repeat delivered sinks through repeated deferrals', () => {
    ring('report');
    vi.advanceTimersByTime(DELAY);
    for (let i = 0; i < 3; i++) {
      driveToBusy(manager, ID);
      vi.advanceTimersByTime(5_000 + DELAY);
    }
    expect(spoken).toHaveBeenCalledOnce();
    expect(pushed).toHaveBeenCalledOnce();
  });
  it('preserves an unsent push when speech already sent', () => {
    scheduler.setDefaults({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: 1_000, pushEnabled: true, pushDelayMs: DELAY });
    ring('report');
    vi.advanceTimersByTime(1_000);
    heartbeat(manager, ID, DELAY);
    vi.advanceTimersByTime(5_001);
    expect(spoken).toHaveBeenCalledOnce();
    expect(pushed).toHaveBeenCalledOnce();
  });
  it('keeps the richest detail across deferrals and new reports', () => {
    ring('report');
    driveToBusy(manager, ID);
    manager.notifyFromProtocol(ID, { source: 'BEL', title: 'Terminal bell', body: null });
    expect(manager.getState(ID).notification).toEqual(REPORT);
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
  });
  it('exempts a mixed command-exit ring from deferral', () => {
    armCommandExit(manager, ID, WATCHED);
    ring('report');
    driveToBusy(manager, ID);
    finishCommand(manager, ID);
    heartbeat(manager, ID, DELAY);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
    expect(spoken).toHaveBeenCalledOnce();
  });
  it('releases an already-shown ring when an engaged command exit resets activity', () => {
    armCommandExit(manager, ID, WATCHED);
    ring('report');
    driveToBusy(manager, ID);
    engage(manager, ID);
    finishCommand(manager, ID);
    const released = manager.getState(ID);
    expect(released.episode).not.toBeNull();
    expect(released.status).toBe('ALERT_RINGING');
    goIdle(manager, ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode: released.episode });
  });
  it('defers a report once an await consumes the exit that exempted it', async () => {
    armCommandExit(manager, ID, WATCHED);
    ring('report');
    finishCommand(manager, ID);
    driveToBusy(manager, ID);
    expect(await manager.awaitCompletion(ID, { until: 'exit', timeoutMs: 60_000 }).promise).toMatchObject({ cause: 'exit' });
    expect(manager.getState(ID).status).not.toBe('ALERT_RINGING');
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
  });
  it('works without a matching WATCHING rule', () => {
    manager.setWatchedCommands([]);
    ring('report');
    driveToBusy(manager, ID);
    expect(manager.getState(ID).status).toBe('WATCHING_DISABLED');
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
  });
  it('shows a notification followed by an isolated redraw in the same PTY read', () => {
    const stream = createOwnerPtyStream(ID, {
      alerts: manager, colorProvider: () => null,
      onToolEvents() {}, onSemanticEvents() {}, writeResponse() {}, onClipboardOffer() {}, onChunk() {},
    });
    stream.write('\x1b]9;needs input\x07final spinner frame');
    const episode = manager.getState(ID).episode;
    expect(episode).not.toBeNull();
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
  });
  it('ignores a repaint long after the last input when deciding whether to defer', () => {
    vi.advanceTimersByTime(60_000);
    ring('report');
    // A resize or focus repaint, with nothing typed since the command started.
    burst(3_000);
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
  });
  it('lets a progress report start work with no input, deferring an owed ring while the turn runs', () => {
    vi.advanceTimersByTime(60_000);
    ring('report');
    const episode = manager.getState(ID).episode;
    // A turn the program began unasked, announced as `OSC 9;4;3`.
    manager.updateProtocolProgress(ID, { state: 'indeterminate', percent: null });
    burst(3_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'OSC_NOTIF_BUSY', episode });
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
  });
  it('ignores repeated typing echoes', () => {
    press(manager, ID);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(400);
      press(manager, ID);
      manager.onData(ID);
    }
    vi.advanceTimersByTime(751);
    manager.onData(ID); // Fresh output ends acknowledgement suppression.
    manager.notifyFromProtocol(ID, REPORT);
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
  });
  it('publishes deferral and its release for unwatched commands without moving alarm deadlines', () => {
    manager.setWatchedCommands([]);
    scheduler.setDefaults({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: 1_000, pushEnabled: true, pushDelayMs: 1_000 });
    driveToBusy(manager, ID);
    manager.notifyFromProtocol(ID, REPORT);
    const episode = manager.getState(ID).episode;
    expect(manager.getState(ID).status).toBe('WATCHING_DISABLED');
    vi.advanceTimersByTime(4_999);
    expect(spoken).not.toHaveBeenCalled();
    expect(pushed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    // Long overdue, so delivered at once rather than a full delay after quiet.
    vi.advanceTimersByTime(1);
    expect(spoken).toHaveBeenCalledExactlyOnceWith(ID, episode!.id);
    expect(pushed).toHaveBeenCalledOnce();
  });
  it('releases a deferral when disabled and defers immediately when re-enabled', () => {
    ring('report');
    const episode = manager.getState(ID).episode;
    driveToBusy(manager, ID);
    manager.setDeferAlertsUntilQuiet(false);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    manager.setDeferAlertsUntilQuiet(true);
    expect(manager.getState(ID).status).not.toBe('ALERT_RINGING');
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
  });
  it('persists a deferred ring as TODO, whether or not it was ever visible', () => {
    ring('report');
    driveToBusy(manager, ID);
    expect(toPersistedAlertState(manager.getState(ID))).toMatchObject({ todo: true, notification: REPORT });
    driveToBusy(manager, 'never-visible');
    manager.notifyFromProtocol('never-visible', REPORT);
    expect(toPersistedAlertState(manager.getState('never-visible'))).toMatchObject({ todo: true, notification: REPORT });
  });
  it.each(['acknowledge', 'dismiss', 'clearTodo', 'remove', 'seed'] as const)('clears a deferred summons on %s without stale delivery', (action) => {
    manager.setWatchedCommands([]); // Isolate report delivery from a later WATCHING settle.
    ring('report');
    driveToBusy(manager, ID);
    if (action === 'acknowledge') manager.acknowledge(ID, { input: false });
    else if (action === 'dismiss') manager.dismissAlert(ID);
    else if (action === 'seed') manager.seed(ID, { todo: false });
    else manager[action](ID);
    vi.advanceTimersByTime(60_000);
    expect(manager.getState(ID).episode).toBeNull();
    expect(spoken).not.toHaveBeenCalled();
    expect(pushed).not.toHaveBeenCalled();
  });
  it('removes a deferred WATCHING source with its rule while retaining a report', () => {
    ring('watching');
    driveToBusy(manager, ID);
    manager.setWatchedCommands([]);
    expect(manager.getState(ID).episode).toBeNull();
    vi.advanceTimersByTime(5_000);
    ring('report');
    driveToBusy(manager, ID);
    manager.setWatchedCommands([WATCHED]);
    manager.setWatchedCommands([]);
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
  });
  it('lets an await claim a new settle without replaying the old inference', async () => {
    ring('watching');
    driveToBusy(manager, ID);
    const handle = manager.awaitCompletion(ID, { until: 'quiet', timeoutMs: 60_000 });
    settle();
    expect(await handle.promise).toMatchObject({ kind: 'resolved', cause: 'quiet' });
    vi.advanceTimersByTime(DELAY);
    expect(manager.getState(ID)).toMatchObject({ status: 'NOTHING_TO_SHOW', episode: null });
    expect(spoken).not.toHaveBeenCalled();
  });
});

describe('output that paints nothing', () => {
  function ownerStream() {
    return createOwnerPtyStream(ID, {
      alerts: manager, colorProvider: () => null,
      onToolEvents() {}, onSemanticEvents() {}, writeResponse() {}, onClipboardOffer() {}, onChunk() {},
    });
  }
  function work(stream: ReturnType<typeof ownerStream>): void {
    stream.write('working');
    vi.advanceTimersByTime(1_600);
    stream.write('still working');
    stream.write('more');
    expect(manager.getState(ID).status).toBe('BUSY');
  }
  it('shows a deferred report while an idle program polls the cursor position', () => {
    const stream = ownerStream();
    work(stream);
    stream.write('\x1b]9;done\x07');
    expect(manager.getState(ID)).toMatchObject({ status: 'BUSY', notification: { body: 'done' } });
    for (let elapsed = 0; elapsed < 10_000; elapsed += 200) {
      vi.advanceTimersByTime(200);
      stream.write('\x1b[?6n');
    }
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
  });
  it('never wakes an idle watched command for frames that only move the cursor', () => {
    const stream = ownerStream();
    for (let elapsed = 0; elapsed < 3_000; elapsed += 50) {
      vi.advanceTimersByTime(50);
      stream.write('\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[51;3H\x1b[?25h\x1b[?2026l');
    }
    settle();
    expect(manager.getState(ID)).toMatchObject({ status: 'NOTHING_TO_SHOW', episode: null });
  });
});
