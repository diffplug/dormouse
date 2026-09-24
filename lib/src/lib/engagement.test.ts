/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from './platform';
import { publishEngagementFocus, retainEngagementReporter, withdrawEngagementFocus } from './engagement';
import { getAlertSettings } from './alert-settings';

let platform: FakePtyAdapter;
let report: ReturnType<typeof vi.spyOn>;
let release: () => void;
const wall = {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  report = vi.spyOn(platform, 'alertEngagement');
  release = retainEngagementReporter();
});

afterEach(() => {
  withdrawEngagementFocus(wall);
  release();
  platform.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('engagement reporter', () => {
  it('holds a watched settle while the user only moves the mouse, and rings once they stop', () => {
    const states: string[] = [];
    platform.onAlertState(({ id, status }) => { if (id === 'pane-a') states.push(status); });
    platform.alertSetWatchedCommands(['claude']);
    platform.setScenario('pane-a', { name: 'none', chunks: [] });
    platform.spawnPty('pane-a');
    publishEngagementFocus(wall, 'pane-a');
    window.dispatchEvent(new Event('keydown'));
    platform.sendOutput('pane-a', '\x1b]633;E;claude\x07\x1b]633;C\x07');
    // Claude works for three seconds and goes quiet; the user reads along,
    // moving the mouse now and then but never typing.
    for (let t = 0; t < 3_000; t += 100) {
      vi.advanceTimersByTime(100);
      platform.sendOutput('pane-a', 'thinking…');
    }
    for (let t = 0; t < 60_000; t += 5_000) {
      vi.advanceTimersByTime(5_000);
      window.dispatchEvent(new Event('pointermove'));
    }
    expect(states).toContain('BUSY');
    expect(states).not.toContain('ALERT_RINGING');

    vi.advanceTimersByTime(getAlertSettings().inactivityTimeoutMs);
    expect(states.at(-1)).toBe('ALERT_RINGING');
  });

  it('reports changes only, never each input event', () => {
    publishEngagementFocus(wall, 'pane-a');
    for (let i = 0; i < 50; i++) window.dispatchEvent(new Event('pointermove'));
    publishEngagementFocus(wall, 'pane-a');

    expect(report.mock.calls).toEqual([
      [{ present: false, focusId: 'pane-a' }, undefined],
      [{ present: true, focusId: 'pane-a' }, undefined],
    ]);
  });

  it('names an inactivity lapse as idle, keeping the focus', () => {
    publishEngagementFocus(wall, 'pane-a');
    window.dispatchEvent(new Event('keydown'));
    report.mockClear();

    vi.advanceTimersByTime(getAlertSettings().inactivityTimeoutMs);
    expect(report.mock.calls).toEqual([[{ present: false, focusId: 'pane-a' }, 'idle']]);
  });

  it('reports a focus change while present without a lapse', () => {
    window.dispatchEvent(new Event('keydown'));
    publishEngagementFocus(wall, 'pane-a');
    publishEngagementFocus(wall, null);
    expect(report.mock.calls.at(-1)).toEqual([{ present: true, focusId: null }, undefined]);
  });

  it('reports the realm gone once the last holder releases', () => {
    const second = retainEngagementReporter();
    window.dispatchEvent(new Event('keydown'));
    publishEngagementFocus(wall, 'pane-a');
    second();
    expect(report.mock.calls.at(-1)).toEqual([{ present: true, focusId: 'pane-a' }, undefined]);

    withdrawEngagementFocus(wall);
    release();
    expect(report.mock.calls.at(-1)).toEqual([{ present: false, focusId: null }, 'leave']);
    release = retainEngagementReporter();
  });
});
