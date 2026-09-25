import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from './platform';
import { LABEL_PUBLISH_THROTTLE_MS, startAlertDelivery } from './alert-delivery';
import { speechQueue } from './alert-speech-queue';
import { DEFAULT_ALERT_SETTINGS, updateAlertSettings } from './alert-settings';
import { clearTerminalActivity, initAlertStateReceiver } from './session-activity-store';
import { removeTerminalPaneState, setTerminalUserTitle } from './terminal-state-store';
import { createWorkspace, resetWorkspaces, setWorkspaceAlertDelivery } from './workspace-store';
import { resetWorkspaceSurfaces, setWorkspaceSurfaces } from './workspace-surfaces';
import { stubSpeechSynthesis, type SpeechSynthesisStub } from './speech-synthesis-test-utils';

/**
 * A realm's half of ring delivery (`docs/specs/alert.md` -> Alarm settings),
 * against the fake adapter's real in-process host: the realm publishes its
 * Sessions' labels and Workspace overrides, the host decides when, and the
 * realm speaks what it is handed.
 */

const PANE = 'pane';
let platform: FakePtyAdapter;
let engine: SpeechSynthesisStub;
let stop: (() => void) | null;

function ring(): void {
  platform.sendOutput(PANE, '\x1b]9;build finished\x07');
}

/** `PANE` a member of Workspace `ws`, published. */
function showPane(): string {
  const workspace = createWorkspace({ id: 'ws' });
  setWorkspaceSurfaces(workspace.id, [PANE]);
  vi.advanceTimersByTime(0);
  return workspace.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  engine = stubSpeechSynthesis();
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
  removeTerminalPaneState(PANE);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('alert delivery', () => {
  it('speaks once when the host says a ring is due', () => {
    ring();
    vi.advanceTimersByTime(999);
    expect(engine.spoken).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(engine.spoken).toEqual(['terminal']);
  });

  it('publishes each Session with its label and Workspace overrides, once per change', () => {
    const publish = vi.spyOn(platform, 'alertPublishSessions');
    const workspaceId = showPane();
    setWorkspaceAlertDelivery(workspaceId, { speakDelayMs: 3_000 });
    vi.advanceTimersByTime(0);
    expect(publish.mock.calls).toEqual([
      [{ [PANE]: { label: 'terminal', overrides: {} } }],
      [{ [PANE]: { label: 'terminal', overrides: { speakDelayMs: 3_000 } } }],
    ]);

    // A Lath commit with the same members, a settings edit, and a ring that
    // leaves the label as it was are no news.
    setWorkspaceSurfaces(workspaceId, [PANE]);
    updateAlertSettings({ pushDelayMs: 5_000 });
    ring();
    vi.advanceTimersByTime(LABEL_PUBLISH_THROTTLE_MS);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('publishes a label change on a trailing throttle, the latest one only', () => {
    const publish = vi.spyOn(platform, 'alertPublishSessions');
    showPane();
    publish.mockClear();
    setTerminalUserTitle(PANE, 'one');
    setTerminalUserTitle(PANE, 'two');
    vi.advanceTimersByTime(LABEL_PUBLISH_THROTTLE_MS - 1);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(publish.mock.calls).toEqual([[{ [PANE]: { label: 'two', overrides: {} } }]]);
  });

  it('has the host push titled by the label it published', () => {
    const pushed: Array<[string, string]> = [];
    platform.onAlertPush = (sessionId, title) => void pushed.push([sessionId, title]);
    updateAlertSettings({ speakEnabled: false, pushEnabled: true, pushDelayMs: 1_000 });
    showPane();
    setTerminalUserTitle(PANE, 'Builds');
    vi.advanceTimersByTime(LABEL_PUBLISH_THROTTLE_MS);
    ring();
    vi.advanceTimersByTime(1_000);
    expect(pushed).toEqual([[PANE, 'Builds']]);
  });

  it('speaks nothing once stopped', () => {
    stop!();
    stop = null;
    ring();
    vi.advanceTimersByTime(60_000);
    expect(engine.spoken).toEqual([]);
  });
});
