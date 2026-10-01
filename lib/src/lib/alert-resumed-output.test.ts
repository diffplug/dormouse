import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';
import { createAlertDeliveryScheduler, type AlertDeliveryScheduler } from './alert-delivery-scheduler';
import { DEFAULT_ALERT_SETTINGS } from './alert-settings-model';
import { armCommandExit, driveToBusy, engage, finishCommand, goIdle, heartbeat, REPORT, runCommand, settle } from './alert-manager-test-utils';
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
function ring(source: 'watching' | 'report'): void {
  if (source === 'report') manager.notifyFromProtocol(ID, REPORT);
  else { driveToBusy(manager, ID); settle(); }
}

describe('owed alerts during resumed output', () => {
  it('keeps a deferred report when output arrives while a claimant takes the settle', () => {
    driveToBusy(manager, ID);
    manager.notifyFromProtocol(ID, REPORT);
    vi.advanceTimersByTime(1_000);
    manager.onData(ID);
    manager.registerCompletionClaimant(ID, (event) => {
      if (event.kind !== 'settled') return false;
      manager.onData(ID);
      return true;
    });
    settle();
    expect(manager.getState(ID).status).not.toBe('ALERT_RINGING');
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
  });
  it.each(['watching', 'report'] as const)('pauses a %s on the first redraw and keeps its original alarm deadlines', (source) => {
    ring(source);
    const episode = manager.getState(ID).episode;
    vi.advanceTimersByTime(1_000);
    manager.onData(ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'NOTHING_TO_SHOW', episode, todo: false });
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    vi.advanceTimersByTime(3_999);
    expect(spoken).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spoken).toHaveBeenCalledExactlyOnceWith(ID, episode!.id);
    expect(pushed).toHaveBeenCalledOnce();
  });
  it.each(['watching', 'report'] as const)('keeps a %s past its deadlines during output, then delivers once on quiet', (source) => {
    ring(source);
    const episode = manager.getState(ID).episode;
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
  it('does not repeat delivered sinks through repeated pauses', () => {
    ring('report');
    vi.advanceTimersByTime(DELAY);
    for (let i = 0; i < 3; i++) {
      manager.onData(ID);
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
  it('keeps the richest detail across pauses and new reports', () => {
    ring('report');
    manager.onData(ID);
    manager.notifyFromProtocol(ID, { source: 'BEL', title: 'Terminal bell', body: null });
    expect(manager.getState(ID).notification).toEqual(REPORT);
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
  });
  it('exempts a mixed command-exit ring from pauses', () => {
    armCommandExit(manager, ID, WATCHED);
    ring('report');
    manager.onData(ID);
    finishCommand(manager, ID);
    heartbeat(manager, ID, DELAY);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
    expect(spoken).toHaveBeenCalledOnce();
  });
  it('leaves a paused ring paused behind an engaged exit until the exit escalates', () => {
    armCommandExit(manager, ID, WATCHED);
    ring('report');
    manager.onData(ID);
    engage(manager, ID);
    finishCommand(manager, ID);
    const paused = manager.getState(ID);
    expect(paused.episode).not.toBeNull();
    expect(paused.status).not.toBe('ALERT_RINGING');
    goIdle(manager, ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode: paused.episode });
  });
  it('pauses a report once an await consumes the exit that exempted it', async () => {
    armCommandExit(manager, ID, WATCHED);
    ring('report');
    finishCommand(manager, ID);
    manager.onData(ID);
    expect(await manager.awaitCompletion(ID, { until: 'exit', timeoutMs: 60_000 }).promise).toMatchObject({ cause: 'exit' });
    expect(manager.getState(ID).status).not.toBe('ALERT_RINGING');
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', notification: REPORT });
  });
  it('works without a matching WATCHING rule', () => {
    manager.setWatchedCommands([]);
    ring('report');
    manager.onData(ID);
    expect(manager.getState(ID).status).toBe('WATCHING_DISABLED');
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
  });
  it('pauses a notification followed by output in the same PTY read', () => {
    const stream = createOwnerPtyStream(ID, {
      alerts: manager, colorProvider: () => null,
      onToolEvents() {}, onSemanticEvents() {}, writeResponse() {}, onClipboardOffer() {}, onChunk() {},
    });
    stream.write('\x1b]9;needs input\x07final spinner frame');
    const episode = manager.getState(ID).episode;
    expect(episode).not.toBeNull();
    expect(manager.getState(ID).status).not.toBe('ALERT_RINGING');
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
  });
  it('ignores resize output when deciding whether to pause', () => {
    ring('report');
    manager.onResize(ID);
    manager.onData(ID);
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
    vi.advanceTimersByTime(DELAY);
    expect(spoken).toHaveBeenCalledOnce();
  });
  it('releases a pause when disabled and pauses immediately when re-enabled', () => {
    ring('report');
    const episode = manager.getState(ID).episode;
    manager.onData(ID);
    manager.setDeferAlertsUntilQuiet(false);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    manager.setDeferAlertsUntilQuiet(true);
    expect(manager.getState(ID).status).not.toBe('ALERT_RINGING');
    vi.advanceTimersByTime(5_000);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
  });
  it('persists a previously visible pause as TODO but keeps initial deferral live-only', () => {
    ring('report');
    manager.onData(ID);
    expect(toPersistedAlertState(manager.getState(ID))).toMatchObject({ todo: true, notification: REPORT });
    manager.onData('never-visible');
    manager.notifyFromProtocol('never-visible', REPORT);
    expect(toPersistedAlertState(manager.getState('never-visible'))).toMatchObject({ todo: false, notification: null });
  });
  it.each(['acknowledge', 'dismiss', 'clearTodo', 'remove', 'seed'] as const)('clears a paused summons on %s without stale delivery', (action) => {
    ring('report');
    manager.onData(ID);
    if (action === 'acknowledge') manager.acknowledge(ID, { input: false });
    else if (action === 'dismiss') manager.dismissAlert(ID);
    else if (action === 'seed') manager.seed(ID, { todo: false });
    else manager[action](ID);
    vi.advanceTimersByTime(60_000);
    expect(manager.getState(ID).episode).toBeNull();
    expect(spoken).not.toHaveBeenCalled();
    expect(pushed).not.toHaveBeenCalled();
  });
  it('removes a paused WATCHING source with its rule while retaining a report', () => {
    ring('watching');
    manager.onData(ID);
    manager.setWatchedCommands([]);
    expect(manager.getState(ID).episode).toBeNull();
    vi.advanceTimersByTime(5_000);
    ring('report');
    manager.onData(ID);
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
