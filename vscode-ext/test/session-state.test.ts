import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ALERT_STATE, type AlertState } from '../../lib/src/lib/alert-manager';
import type { PersistedSession } from '../../lib/src/lib/session-types';

const ptyManager = vi.hoisted(() => ({
  getBufferedPtys: vi.fn(),
  getCwd: vi.fn(),
}));

vi.mock('../src/pty-manager', () => ptyManager);

import { discardUnreadableSessionState, getSavedSessionState, mergeAlertStates, refreshSavedSessionStateFromPtys } from '../src/session-state';

const liveAlert = (overrides: Partial<AlertState> = {}): AlertState => ({
  ...DEFAULT_ALERT_STATE,
  ...overrides,
});

function contextWithState(initial: unknown) {
  let state = initial;
  return {
    context: {
      workspaceState: {
        get: () => state,
        update: (_key: string, next: unknown) => {
          state = next;
          return Promise.resolve();
        },
      },
    } as never,
    read: () => state,
  };
}

describe('VS Code session alert persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptyManager.getBufferedPtys.mockReturnValue(new Map());
    ptyManager.getCwd.mockResolvedValue(null);
  });

  it('projects live alert state before a periodic save', () => {
    const session: PersistedSession = {
      version: 4,
      panes: [{ id: 'terminal-a', title: 'Terminal A', cwd: null, untouched: false }],
    };

    const merged = mergeAlertStates(session, new Map([
      ['terminal-a', liveAlert({
        status: 'ALERT_RINGING',
        watchingEnabled: true,
        todo: true,
        awaited: true,
        episode: { id: 'episode-live', startedAt: 0 },
      })],
    ])) as PersistedSession;

    expect(merged.panes[0].alert).toEqual({
      status: 'ALERT_RINGING',
      todo: true,
      notification: null,
    });
  });

  it('strips transient alert fields from browser and terminal fallbacks during host refresh', async () => {
    const staleAlert = {
      status: 'NOTHING_TO_SHOW' as const,
      todo: true,
      notification: null,
      watchingEnabled: true,
      awaited: true,
      episode: { id: 'episode-stale', startedAt: 0 },
    };
    const store = contextWithState({
      version: 4,
      panes: [
        { id: 'browser-a', title: 'Browser A', cwd: null, untouched: false, surfaceType: 'browser', alert: staleAlert },
        { id: 'terminal-a', title: 'Terminal A', cwd: '/saved', untouched: false, alert: staleAlert },
      ],
    });

    await refreshSavedSessionStateFromPtys(store.context);

    const saved = store.read() as PersistedSession;
    expect(saved.panes.map((pane) => pane.alert)).toEqual([
      { status: 'NOTHING_TO_SHOW', todo: true, notification: null },
      { status: 'NOTHING_TO_SHOW', todo: true, notification: null },
    ]);
  });

  it('reads an older build\'s saved session as none, so the view starts fresh', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const old = { version: 3, panes: [{ id: 'pane-1', title: 'Old', cwd: '/old', untouched: false }] };
    const store = contextWithState(old);

    expect(getSavedSessionState(store.context)).toBeNull();
    // A panel's `setState` blob goes through the same reader on its way back in.
    expect(mergeAlertStates(old, new Map([['pane-1', liveAlert({ todo: true })]]))).toBe(old);
    await refreshSavedSessionStateFromPtys(store.context);
    expect(store.read()).toBe(old);
    info.mockRestore();
  });

  it('deletes an older build\'s saved session at activation and keeps a current one', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const old = contextWithState({ version: 3, panes: [{ id: 'pane-1', title: 'Old', cwd: '/old', untouched: false, scrollback: 'secret' }] });
    await discardUnreadableSessionState(old.context);
    expect(old.read()).toBeUndefined();
    const current = { version: 4, panes: [{ id: 'surface:1', title: 'New', cwd: '/new', untouched: false }] };
    const kept = contextWithState(current);
    await discardUnreadableSessionState(kept.context);
    expect(kept.read()).toBe(current);
    info.mockRestore();
  });
});
