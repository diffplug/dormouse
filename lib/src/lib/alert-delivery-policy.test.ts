import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./platform', () => ({ getPlatform: () => ({ alertPublishSettings: vi.fn() }) }));
import { normalizeAlertDeliveryOverrides, resolveAlertDeliveryPolicy } from './alert-delivery-model';
import { getSessionAlertPolicy, subscribeToAlertDeliveryPolicy } from './alert-delivery-policy';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from './alert-settings';
import { createWorkspace, renameWorkspace, resetWorkspaces, setWorkspaceAlertDelivery } from './workspace-store';
import { resetWorkspaceSurfaces, setWorkspaceSurfaces } from './workspace-surfaces';
import { clearTerminalActivity, setTerminalActivity } from './session-activity-store';
import { watchUnattendedRings } from './alert-ring-watch';
import { forgetAlertDelivery, getAlertDeliveryReceipts, markAlertConsumed, pauseAlertDelivery, restoreAlertDelivery, resumeAlertDelivery, snapshotAlertDelivery } from './alert-delivery-state';
import { readPersistedSession, readPersistedWindow } from './session-types';
import { getWindowSnapshot, publishWorkspaceSession, resetWindowSessionAggregator } from './window-session-aggregator';

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); resetWorkspaces(); resetWorkspaceSurfaces(); clearTerminalActivity();
  resetWindowSessionAggregator(); forgetAlertDelivery(['pane']);
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
});
afterEach(() => { stop?.(); stop = undefined; clearTerminalActivity(); forgetAlertDelivery(['pane']); vi.useRealTimers(); });
const ring = () => { setTerminalActivity('pane', { status: 'NOTHING_TO_SHOW' }); setTerminalActivity('pane', { status: 'ALERT_RINGING' }); };
function watch() {
  const fire = vi.fn();
  stop = watchUnattendedRings({ sink: 'speech', enabled: id => getSessionAlertPolicy(id).speakEnabled,
    delayMs: id => getSessionAlertPolicy(id).speakDelayMs, subscribe: subscribeToAlertDeliveryPolicy, fire });
  return fire;
}
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
  it('cancels immediately on disable and never replays when enabled again', () => {
    const id = workspace(); const fire = watch(); ring();
    vi.advanceTimersByTime(500);
    setWorkspaceAlertDelivery(id, { speakEnabled: false });
    setWorkspaceAlertDelivery(id, { speakEnabled: true });
    vi.advanceTimersByTime(60_000);
    expect(fire).not.toHaveBeenCalled();
  });
  it('keeps an admitted deadline through later delay edits', () => {
    const id = workspace(); const fire = watch(); ring();
    vi.advanceTimersByTime(500);
    setWorkspaceAlertDelivery(id, { speakEnabled: true, speakDelayMs: 50_000 });
    vi.advanceTimersByTime(500);
    expect(fire).toHaveBeenCalledTimes(1);
  });
  it('suspends pending delivery and restores its deadline on hand-back', () => {
    workspace(); const fire = watch(); ring();
    vi.advanceTimersByTime(500); pauseAlertDelivery(['pane']);
    vi.advanceTimersByTime(5000);
    expect(fire).not.toHaveBeenCalled();
    resumeAlertDelivery(['pane']); vi.advanceTimersByTime(0);
    expect(fire).toHaveBeenCalledTimes(1);
  });
  it('consumes a suspended receipt when its sink is disabled, so hand-back never replays it', () => {
    const id = workspace(); const fire = watch(); ring();
    vi.advanceTimersByTime(500); pauseAlertDelivery(['pane']);
    setWorkspaceAlertDelivery(id, { speakEnabled: false, speakDelayMs: 1000 });
    setWorkspaceAlertDelivery(id, { speakEnabled: true, speakDelayMs: 1000 });
    resumeAlertDelivery(['pane']); vi.advanceTimersByTime(60_000);
    expect(fire).not.toHaveBeenCalled();
  });
  it('never re-arms a receipt forgotten on the same episode', () => {
    workspace(); const fire = watch(); ring();
    vi.advanceTimersByTime(500);
    forgetAlertDelivery(['pane']);
    vi.advanceTimersByTime(60_000);
    expect(fire).not.toHaveBeenCalled();
    expect(getAlertDeliveryReceipts('speech').get('pane')?.phase).toBe('consumed');
  });
  it('prunes receipts of Sessions that left while no watcher ran', () => {
    workspace(); watch(); ring();
    stop!(); stop = undefined;
    clearTerminalActivity();
    expect(getAlertDeliveryReceipts('speech').has('pane')).toBe(true);
    watch();
    expect(getAlertDeliveryReceipts('speech').has('pane')).toBe(false);
  });
  it('continues an unadmitted queue item in a fresh watcher, but never a delivered receipt', () => {
    workspace(); const fire = watch(); ring(); vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
    pauseAlertDelivery(['pane']);
    const handoff = snapshotAlertDelivery('pane');
    stop!(); restoreAlertDelivery('pane', handoff);
    const destination = watch(); resumeAlertDelivery(['pane']); vi.advanceTimersByTime(0);
    expect(destination).toHaveBeenCalledTimes(1);
    const receipt = getAlertDeliveryReceipts('speech').get('pane')!;
    markAlertConsumed('speech', 'pane', receipt.episodeId);
    const delivered = snapshotAlertDelivery('pane');
    stop!(); restoreAlertDelivery('pane', delivered);
    const third = watch(); vi.advanceTimersByTime(60_000);
    expect(third).not.toHaveBeenCalled();
  });
});
