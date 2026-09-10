import { describe, expect, it, vi } from 'vitest';
import { loadWindowState, saveWindowState, type SessionKeyValueStore } from './window-persistence';
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  wrapSessionInWindow,
  type PersistedSession,
  type PersistedWindow,
} from './session-types';

function memoryStore(seed?: string): SessionKeyValueStore & { value: () => string | null } {
  let stored: string | null = seed ?? null;
  return {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
    value: () => stored,
  };
}

const sessionA: PersistedSession = {
  version: 3,
  panes: [{ id: 'pane-a', title: 'A', cwd: '/a', untouched: false }],
};
const sessionB: PersistedSession = {
  version: 3,
  panes: [{ id: 'pane-b', title: 'B', cwd: '/b', untouched: false }],
};

const twoWorkspaces: PersistedWindow = {
  version: 1,
  workspaces: [
    { id: 'ws-1', name: 'One', session: sessionA },
    { id: 'ws-2', name: 'Two', session: sessionB },
  ],
  activeWorkspaceId: 'ws-2',
};

describe('window-persistence', () => {
  it('round-trips a Window through the slot', () => {
    const store = memoryStore();
    saveWindowState(store, 'k', twoWorkspaces);
    expect(loadWindowState(store, 'k')).toEqual(twoWorkspaces);
  });

  it('wraps a pre-Window blob as this Window\'s one Workspace', () => {
    const store = memoryStore(JSON.stringify(sessionA));
    expect(loadWindowState(store, 'k')).toEqual({
      version: 1,
      workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, session: sessionA }],
      activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    expect(loadWindowState(store, 'k')).toEqual(wrapSessionInWindow(sessionA));
  });

  it('starts fresh on an absent, corrupt, or unrecognizable blob', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadWindowState(memoryStore(), 'k')).toBeNull();
    expect(loadWindowState(memoryStore('{not json'), 'k')).toBeNull();
    expect(loadWindowState(memoryStore('{"version":99}'), 'k')).toBeNull();
    // A v3 blob that fails its own guard is not retried as a Window.
    expect(loadWindowState(memoryStore('{"version":3,"panes":"nope"}'), 'k')).toBeNull();
    warn.mockRestore();
  });

  it('drops an unreadable Workspace instead of the whole Window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = memoryStore(JSON.stringify({
      version: 1,
      workspaces: [
        { id: 'ws-1', name: 'One', session: sessionA },
        { id: 'ws-2', name: 'Two', session: { version: 3, panes: 'nope' } },
      ],
      activeWorkspaceId: 'ws-2',
    }));
    const loaded = loadWindowState(store, 'k');
    expect(loaded?.workspaces.map((ws) => ws.id)).toEqual(['ws-1']);
    // The dangling active id is repaired to a Workspace that survived.
    expect(loaded?.activeWorkspaceId).toBe('ws-1');
    warn.mockRestore();
  });
});
