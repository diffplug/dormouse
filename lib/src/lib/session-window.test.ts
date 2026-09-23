import { describe, expect, it } from 'vitest';
import {
  readPersistedWindow,
  windowPaneIds,
  wrapSessionInWindow,
  type PersistedSession,
  type PersistedWindow,
} from './session-types';

const sessionA: PersistedSession = {
  version: 3,
  panes: [{ id: 'pane-a', title: 'A', cwd: null, untouched: false }],
};

const sessionB: PersistedSession = {
  version: 3,
  panes: [{ id: 'pane-b', title: 'B', cwd: null, untouched: false }],
};

describe('readPersistedWindow', () => {
  it('round-trips a canonical multi-Workspace window', () => {
    const win: PersistedWindow = {
      version: 1,
      activeWorkspaceId: 'ws-b',
      workspaces: [
        { id: 'ws-a', name: 'Left', nameIsAuto: false, session: sessionA },
        { id: 'ws-b', name: 'dormouse @ main', nameIsAuto: true, session: sessionB },
      ],
    };
    expect(readPersistedWindow(win)).toEqual(win);
  });

  it('reads a blob from before auto-naming: only a `Workspace <n>` name is auto', () => {
    const win = readPersistedWindow({
      version: 1,
      activeWorkspaceId: 'ws-a',
      workspaces: [
        { id: 'ws-a', name: 'Workspace 3', session: sessionA },
        { id: 'ws-b', name: 'Build', session: sessionB },
      ],
    });
    expect(win?.workspaces.map((ws) => ws.nameIsAuto)).toEqual([true, false]);
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

  it('keeps only the first of a duplicated Workspace id', () => {
    // `setWorkspaces` rejects a duplicate outright, so a blob carrying one would
    // otherwise take the whole launch down before anything rendered.
    const win = {
      version: 1 as const,
      activeWorkspaceId: 'ws-a',
      workspaces: [
        { id: 'ws-a', name: 'First', session: sessionA },
        { id: 'ws-a', name: 'Second', session: sessionB },
      ],
    };
    const read = readPersistedWindow(win);
    expect(read?.workspaces).toHaveLength(1);
    expect(read?.workspaces[0].name).toBe('First');
    expect(read?.activeWorkspaceId).toBe('ws-a');
  });

  it('returns null for unusable input', () => {
    expect(readPersistedWindow(null)).toBeNull();
    expect(readPersistedWindow({ random: 'junk' })).toBeNull();
    expect(readPersistedWindow('not json')).toBeNull();
  });
});

describe('windowPaneIds', () => {
  it('names every pane across every Workspace, and nothing without a Window', () => {
    const win: PersistedWindow = {
      version: 1,
      activeWorkspaceId: 'ws-a',
      workspaces: [
        { id: 'ws-a', name: 'A', session: sessionA },
        { id: 'ws-b', name: 'B', session: sessionB },
      ],
    };
    expect(windowPaneIds(win)).toEqual(['pane-a', 'pane-b']);
    expect(windowPaneIds(null)).toEqual([]);
  });
});
