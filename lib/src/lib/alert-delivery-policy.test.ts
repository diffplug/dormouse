import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./platform', () => ({ getPlatform: () => ({ alertPublishSettings: vi.fn() }) }));
import { normalizeAlertDeliveryOverrides, resolveAlertDeliveryPolicy } from './alert-delivery-model';
import { collectDeliveryOverrides, getSessionAlertPolicy } from './alert-delivery-policy';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from './alert-settings';
import { createWorkspace, renameWorkspace, resetWorkspaces, setWorkspaceAlertDelivery } from './workspace-store';
import { resetWorkspaceSurfaces, setWorkspaceSurfaces } from './workspace-surfaces';
import { readPersistedSession, readPersistedWindow } from './session-types';
import { getWindowSnapshot, publishWorkspaceSession, resetWindowSessionAggregator } from './window-session-aggregator';

/**
 * A Workspace's sparse delivery overrides (`docs/specs/alert.md` -> Alarm
 * settings): how they persist, how a Session resolves them, and what the
 * renderer publishes to the host's scheduler. The scheduling itself is
 * `alert-delivery-scheduler.test.ts`.
 */

beforeEach(() => {
  resetWorkspaces(); resetWorkspaceSurfaces(); resetWindowSessionAggregator();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
});
function workspace() {
  const ws = createWorkspace({ id: 'ws' });
  setWorkspaceSurfaces(ws.id, ['pane']);
  setWorkspaceAlertDelivery(ws.id, { speakEnabled: true, speakDelayMs: 1000 });
  return ws.id;
}

describe('workspace delivery policy', () => {
  it('keeps absent fields inherited and rejects malformed overrides', () => {
    expect(normalizeAlertDeliveryOverrides({ speakEnabled: 'false', pushDelayMs: NaN, speakDelayMs: -2, other: true }))
      .toEqual({ speakDelayMs: 1000 });
    expect(resolveAlertDeliveryPolicy({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true }, { pushEnabled: false, speakVoice: null }))
      .toMatchObject({ speakEnabled: true, pushEnabled: false, speakVoice: null });
  });
  it('round-trips sparse choices in both host shapes and follows rename/reset', () => {
    const id = workspace();
    setWorkspaceAlertDelivery(id, { speakVoice: 'voice-uri', speakEnabled: false });
    publishWorkspaceSession(id, { version: 3, panes: [] });
    renameWorkspace(id, 'New name');
    const saved = readPersistedWindow(JSON.stringify(getWindowSnapshot()))!;
    expect(saved.workspaces[0]).toMatchObject({ name: 'New name', session: { alertDelivery: { speakVoice: 'voice-uri', speakEnabled: false } } });
    expect(readPersistedSession(JSON.stringify(saved.workspaces[0].session))?.alertDelivery).toEqual({ speakVoice: 'voice-uri', speakEnabled: false });
    setWorkspaceAlertDelivery(id, {});
    expect(getWindowSnapshot().workspaces[0].session).not.toHaveProperty('alertDelivery');
  });
  it('resolves a member Session under its Workspace, and one without membership under the defaults', () => {
    workspace();
    expect(getSessionAlertPolicy('pane')).toMatchObject({ speakEnabled: true, speakDelayMs: 1000, pushEnabled: false });
    expect(getSessionAlertPolicy('elsewhere')).toMatchObject({ speakEnabled: false, speakDelayMs: DEFAULT_ALERT_SETTINGS.speakDelayMs });
  });
  it('publishes every member Session with its Workspace\'s overrides, an empty one included', () => {
    workspace();
    createWorkspace({ id: 'plain' });
    setWorkspaceSurfaces('plain', ['a', 'b']);
    expect(collectDeliveryOverrides()).toEqual({
      pane: { speakEnabled: true, speakDelayMs: 1000 },
      a: {},
      b: {},
    });
  });
});
