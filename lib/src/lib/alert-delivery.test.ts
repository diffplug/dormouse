import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from './platform';
import type { BurrowLink } from './platform/types';
import { startAlertDelivery } from './alert-delivery';
import { speechQueue } from './speech-queue';
import { DEFAULT_ALERT_SETTINGS, updateAlertSettings } from './alert-settings';
import { clearTerminalActivity, initAlertStateReceiver } from './session-activity-store';
import { createWorkspace, resetWorkspaces, setWorkspaceAlertDelivery } from './workspace-store';
import { resetWorkspaceSurfaces, setWorkspaceSurfaces } from './workspace-surfaces';

/**
 * A realm's half of ring delivery (`docs/specs/alert.md` -> Alarm settings),
 * against the fake adapter's real in-process host: the realm publishes its
 * Workspaces' overrides, the host decides when, and the realm performs.
 */

const PANE = 'pane';
let platform: FakePtyAdapter;
let spoken: string[];
let stop: (() => void) | null;

function ring(): void {
  platform.sendOutput(PANE, '\x1b]9;build finished\x07');
}

beforeEach(() => {
  vi.useFakeTimers();
  spoken = [];
  vi.stubGlobal('speechSynthesis', { speak: (utterance: { text: string }) => void spoken.push(utterance.text), cancel: () => {} });
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
  resetWorkspaces();
  resetWorkspaceSurfaces();
  clearTerminalActivity();
  platform = new FakePtyAdapter();
  setPlatform(platform);
  initAlertStateReceiver();
  updateAlertSettings({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: 1_000 });
  platform.setScenario(PANE, { name: 'none', chunks: [] });
  platform.spawnPty(PANE);
  stop = startAlertDelivery();
});

afterEach(() => {
  stop?.();
  speechQueue.clear();
  updateAlertSettings(DEFAULT_ALERT_SETTINGS);
  platform.shutdown();
  clearTerminalActivity();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('alert delivery', () => {
  it('speaks the pane label when the host says a ring is due', () => {
    ring();
    vi.advanceTimersByTime(999);
    expect(spoken).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(spoken).toEqual(['terminal']);
  });

  it('tells the host its Workspaces\' overrides, once per change', () => {
    const publish = vi.spyOn(platform, 'alertPublishDeliveryPolicy');
    updateAlertSettings({ speakEnabled: false });
    const workspace = createWorkspace({ id: 'ws' });
    setWorkspaceSurfaces(workspace.id, [PANE]);
    setWorkspaceAlertDelivery(workspace.id, { speakEnabled: true, speakDelayMs: 3_000 });
    // A Lath commit with the same members is no news.
    setWorkspaceSurfaces(workspace.id, [PANE]);
    expect(publish.mock.calls.at(-1)).toEqual([{ [PANE]: { speakEnabled: true, speakDelayMs: 3_000 } }]);
    expect(publish).toHaveBeenCalledTimes(2);

    ring();
    vi.advanceTimersByTime(3_000);
    expect(spoken).toEqual(['terminal']);
  });

  it('pushes through the Burrow with the pane label', async () => {
    const command = vi.fn(async () => ({}));
    platform.burrow = { command } as unknown as BurrowLink;
    updateAlertSettings({ speakEnabled: false, pushEnabled: true, pushDelayMs: 1_000 });
    ring();
    vi.advanceTimersByTime(1_000);
    expect(command).toHaveBeenCalledExactlyOnceWith('push', { sessionId: PANE, title: 'terminal' });
  });

  it('performs nothing once stopped', () => {
    stop!();
    stop = null;
    ring();
    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });
});
