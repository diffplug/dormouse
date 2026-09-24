import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import { AlertManager } from './alert-manager';
import { watchUnattendedRings } from './alert-ring-watch';
import { startAlertSpeech } from './alert-speech';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from './alert-settings';
import { clearTerminalActivity, setTerminalActivity } from './session-activity-store';
import { cfg } from '../cfg';
import { armCommandExit, driveToBusy, finishCommand, runCommand, settle } from './alert-manager-test-utils';

const ID = 'resumed-watched-work';
const WATCHED = 'longtask';
const DELAY = 10_000;
let manager: AlertManager;
let stopSpeech: () => void;
let stopPush: () => void;
let spoken: ReturnType<typeof vi.fn>;
let pushed: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  clearTerminalActivity();
  spoken = vi.fn();
  pushed = vi.fn();
  vi.stubGlobal('speechSynthesis', { speak: spoken, cancel: vi.fn() });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    constructor(readonly text: string) {}
  });
  applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: DELAY });
  manager = new AlertManager();
  manager.setDeferAlertsUntilQuiet(true);
  manager.onStateChange(setTerminalActivity);
  manager.setWatchedCommands([WATCHED]);
  runCommand(manager, ID, WATCHED);
  stopSpeech = startAlertSpeech();
  // Push shares the ring watcher; exercise its delivery decision without a Relay.
  stopPush = watchUnattendedRings({ sink: 'push', subscribe: () => () => {}, enabled: () => true, delayMs: () => DELAY, fire: pushed });
});

afterEach(() => {
  stopPush();
  stopSpeech();
  manager.dispose();
  clearTerminalActivity();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WATCHING output resuming before alarm delivery', () => {
  it('cancels pending speech and push during animation, then gives the next settle a fresh delay', () => {
    driveToBusy(manager, ID);
    settle();
    const firstEpisode = manager.getState(ID).episode;
    expect(firstEpisode?.id).toBeTruthy();
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
    vi.advanceTimersByTime(1_000);
    driveToBusy(manager, ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'BUSY', todo: false, episode: null });

    // Keep animating across the old speech deadline, as in the marked incident.
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(200);
      manager.onData(ID);
    }
    expect(spoken).not.toHaveBeenCalled();
    expect(pushed).not.toHaveBeenCalled();

    settle();
    const relatched = manager.getState(ID);
    expect(relatched.status).toBe('ALERT_RINGING');
    expect(relatched.episode?.id).toBeTruthy();
    expect(relatched.episode?.id).not.toBe(firstEpisode?.id);
    vi.advanceTimersByTime(DELAY - 1);
    expect(spoken).not.toHaveBeenCalled();
    expect(pushed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spoken).toHaveBeenCalledOnce();
    expect(pushed).toHaveBeenCalledExactlyOnceWith(ID, manager.getState(ID).episode);
  });

  it('keeps an inferred ring through a short redraw that never confirms BUSY', () => {
    driveToBusy(manager, ID);
    settle();
    manager.onData(ID);
    vi.advanceTimersByTime(62);
    manager.onData(ID);
    vi.advanceTimersByTime(DELAY);
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
    expect(spoken).toHaveBeenCalledOnce();
  });

  it('retains the latched ring with animation deferral disabled', () => {
    manager.setDeferAlertsUntilQuiet(false);
    driveToBusy(manager, ID);
    settle();
    driveToBusy(manager, ID);
    expect(manager.getState(ID).status).toBe('ALERT_RINGING');
    vi.advanceTimersByTime(DELAY);
    expect(spoken).toHaveBeenCalledOnce();
  });

  it('preserves TODO and notification detail when withdrawing inferred completion', () => {
    manager.notifyFromProtocol(ID, { source: 'OSC 9', title: 'earlier notice', body: null });
    manager.dismissAlert(ID);
    const receipt = manager.getState(ID);
    expect(receipt.todo).toBe(true);
    driveToBusy(manager, ID);
    settle();
    driveToBusy(manager, ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'BUSY', todo: true, notification: receipt.notification });
  });

  it.each(['report', 'exit'] as const)('preserves an authoritative %s source behind WATCHING', (source) => {
    armCommandExit(manager, ID, WATCHED);
    vi.advanceTimersByTime(cfg.alert.commandExitMinRuntime);
    driveToBusy(manager, ID);
    settle();
    if (source === 'report') {
      manager.notifyFromProtocol(ID, { source: 'OSC 9', title: 'input needed', body: null });
    } else {
      finishCommand(manager, ID);
      expect(manager.getState(ID).notification?.source).toBe('COMMAND_EXIT');
      runCommand(manager, ID, WATCHED);
    }
    const episode = manager.getState(ID).episode;
    driveToBusy(manager, ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', episode });
    vi.advanceTimersByTime(DELAY);
    expect(spoken).toHaveBeenCalledOnce();
  });

  it('keeps a WATCHING ring through output after the watched command exits', () => {
    driveToBusy(manager, ID);
    settle();
    finishCommand(manager, ID);
    driveToBusy(manager, ID);
    expect(manager.getState(ID)).toMatchObject({ status: 'ALERT_RINGING', watchingEnabled: false });
  });

  it('keeps the resumed detector alive so an await can claim its next settle', async () => {
    driveToBusy(manager, ID);
    settle();
    driveToBusy(manager, ID);
    const handle = manager.awaitCompletion(ID, { until: 'quiet', timeoutMs: 60_000 });
    settle();
    expect(await handle.promise).toMatchObject({ kind: 'resolved', cause: 'quiet' });
    vi.advanceTimersByTime(DELAY);
    expect(manager.getState(ID)).toMatchObject({ status: 'NOTHING_TO_SHOW', todo: false });
    expect(spoken).not.toHaveBeenCalled();
  });
});
