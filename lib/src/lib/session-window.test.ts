import { describe, expect, it } from 'vitest';
import {
  activeWorkspaceSession,
  readPersistedWindow,
  wrapSessionInWindow,
  type PersistedSession,
  type PersistedWindow,
} from './session-types';

const sessionA: PersistedSession = {
  version: 3,
  panes: [{ id: 'pane-a', title: 'A', cwd: null, scrollback: null, resumeCommand: null, untouched: false }],
};

const sessionB: PersistedSession = {
  version: 3,
  panes: [{ id: 'pane-b', title: 'B', cwd: null, scrollback: null, resumeCommand: null, untouched: false }],
};

describe('readPersistedWindow', () => {
  it('round-trips a canonical multi-Workspace window', () => {
    const win: PersistedWindow = {
      version: 1,
      activeWorkspaceId: 'ws-b',
      workspaces: [
        { id: 'ws-a', name: 'Left', session: sessionA },
        { id: 'ws-b', name: 'Right', session: sessionB },
      ],
    };
    expect(readPersistedWindow(win)).toEqual(win);
  });

  it('parses a JSON-stringified window blob', () => {
    const win = wrapSessionInWindow(sessionA);
    expect(readPersistedWindow(JSON.stringify(win))).toEqual(win);
  });

  it('falls back to the first Workspace when activeWorkspaceId matches none', () => {
    const win: PersistedWindow = {
      version: 1,
      activeWorkspaceId: 'gone',
      workspaces: [{ id: 'ws-a', name: 'A', session: sessionA }],
    };
    expect(readPersistedWindow(win)?.activeWorkspaceId).toBe('ws-a');
  });

  it('drops Workspaces with an unreadable session, keeping the rest', () => {
    const win = {
      version: 1 as const,
      activeWorkspaceId: 'ws-a',
      workspaces: [
        { id: 'ws-a', name: 'A', session: sessionA },
        { id: 'ws-bad', name: 'Bad', session: { nonsense: true } },
      ],
    };
    const read = readPersistedWindow(win);
    expect(read?.workspaces).toHaveLength(1);
    expect(read?.workspaces[0].id).toBe('ws-a');
  });

  it('returns null for unusable input', () => {
    expect(readPersistedWindow(null)).toBeNull();
    expect(readPersistedWindow({ random: 'junk' })).toBeNull();
    expect(readPersistedWindow('not json')).toBeNull();
  });
});

describe('activeWorkspaceSession', () => {
  it('returns the active Workspace session', () => {
    const win: PersistedWindow = {
      version: 1,
      activeWorkspaceId: 'ws-b',
      workspaces: [
        { id: 'ws-a', name: 'A', session: sessionA },
        { id: 'ws-b', name: 'B', session: sessionB },
      ],
    };
    expect(activeWorkspaceSession(win)).toBe(sessionB);
  });

  it('falls back to the first Workspace when the active id is missing', () => {
    const win: PersistedWindow = {
      version: 1,
      activeWorkspaceId: 'gone',
      workspaces: [{ id: 'ws-a', name: 'A', session: sessionA }],
    };
    expect(activeWorkspaceSession(win)).toBe(sessionA);
  });
});
