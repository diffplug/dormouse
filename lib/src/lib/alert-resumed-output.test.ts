import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';
import { createAlertDeliveryScheduler, type AlertDeliveryScheduler } from './alert-delivery-scheduler';
import { DEFAULT_ALERT_SETTINGS } from './alert-settings-model';
import { armCommandExit, driveToBusy, engage, finishCommand, goIdle, heartbeat, press, REPORT, runCommand, settle, work } from './alert-manager-test-utils';
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
  it('keeps a report ringing while a claimant that takes the settle restarts work', () => {
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
  it.each(['watching', 'report'] as const)('keeps a %s ringing through resumed output, delivering once on its original deadlines', (source) => {
    ring(source);
    const episode = manager.getState(ID).episode;
    // Another turn starts, and runs for two minutes.
    work(manager, ID);
    vi.advanceTimersByTime(episode!.startedAt + DELAY - Date.now() - 1);
    expect(spoken).not.toHaveBeenCalled();
    heartbeat(manager, ID, 120_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    expect(spoken).toHaveBeenCalledExactlyOnceWith(ID, episode!.id);
    expect(pushed).toHaveBeenCalledOnce();
    settle();
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    expect(spoken).toHaveBeenCalledOnce();
  });
  it('does not repeat delivered sinks through repeated output', () => {
    ring('report');
    vi.advanceTimersByTime(DELAY);
    for (let i = 0; i < 3; i++) {
      driveToBusy(manager, ID);
      vi.advanceTimersByTime(5_000 + DELAY);
    }
    expect(spoken).toHaveBeenCalledOnce();
    expect(pushed).toHaveBeenCalledOnce();
  });
  it('keeps the richest detail across resumed output and new reports', () => {
    ring('report');
    driveToBusy(manager, ID);
    manager.notifyFromProtocol(ID, { source: 'BEL', title: 'Terminal bell', body: null });
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
  });
  it('keeps a showing ring when an engaged command exit is held beside it', () => {
    armCommandExit(manager, ID, WATCHED);
    ring('report');
    driveToBusy(manager, ID);
    engage(manager, ID);
    finishCommand(manager, ID);
    const kept = manager.getState(ID);
    expect(kept.episode).not.toBeNull();
    expect(kept.status).toBe('ALERT_RINGING');
    goIdle(manager, ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode: kept.episode });
  });
  it('keeps a report ringing once an await consumes the exit beside it', async () => {
    armCommandExit(manager, ID, WATCHED);
    ring('report');
    finishCommand(manager, ID);
    driveToBusy(manager, ID);
    expect(await manager.awaitCompletion(ID, { until: 'exit', timeoutMs: 60_000 }).promise).toMatchObject({ cause: 'exit' });
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
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
  it('ignores a repaint long after the last input', () => {
    vi.advanceTimersByTime(60_000);
    // A resize or focus repaint, with nothing typed since the command started.
    burst(3_000);
    expect(manager.getState(ID).status).toBe('NOTHING_TO_SHOW');
  });
  it('lets a progress update start work with no input, so the turn it ends is news', () => {
    vi.advanceTimersByTime(60_000);
    manager.notifyFromProtocol(ID, REPORT);
    manager.dismissAlert(ID);
    // A turn the program began unasked, announced as `OSC 9;4;3`.
    manager.updateProtocolProgress(ID, { state: 'indeterminate', percent: null });
    burst(3_000);
    manager.updateProtocolProgress(ID, { state: 'clear', percent: null });
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: { source: 'OSC 9;4' } });
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
  it('persists an unacknowledged ring as TODO', () => {
    ring('report');
    driveToBusy(manager, ID);
    expect(toPersistedAlertState(manager.getState(ID))).toMatchObject({ todo: true, notification: REPORT });
  });
  it.each(['acknowledge', 'dismiss', 'clearTodo', 'remove', 'seed'] as const)('clears a ring on %s without stale delivery', (action) => {
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
  it('removes a WATCHING source with its rule while retaining a report', () => {
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
  it('settles a finished program that polls the cursor position', () => {
    const stream = ownerStream();
    work(stream);
    for (let elapsed = 0; elapsed < 10_000; elapsed += 200) {
      vi.advanceTimersByTime(200);
      stream.write('\x1b[?6n');
    }
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: { source: 'WATCHING' } });
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
