import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ALERT_STATE, type AlertState } from '../../lib/src/lib/alert-manager';
import type { PersistedSession } from '../../lib/src/lib/session-types';

const ptyManager = vi.hoisted(() => ({
  getBufferedPtys: vi.fn(),
  getCwd: vi.fn(),
}));

vi.mock('../src/pty-manager', () => ptyManager);

import { mergeAlertStates, refreshSavedSessionStateFromPtys } from '../src/session-state';

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
      version: 3,
      panes: [{ id: 'terminal-a', title: 'Terminal A', cwd: null, untouched: false }],
    };

    const merged = mergeAlertStates(session, new Map([
      ['terminal-a', liveAlert({
        status: 'ALERT_RINGING',
        watchingEnabled: true,
        todo: true,
        attentionDismissedRing: true,
        awaited: true,
        ringSeq: 7,
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
      ringSeq: 4,
    };
    const store = contextWithState({
      version: 3,
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
});
