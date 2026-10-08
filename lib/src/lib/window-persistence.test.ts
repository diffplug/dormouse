import { describe, expect, it, vi } from 'vitest';
import { loadWindowState, saveWindowState, type SessionKeyValueStore } from './window-persistence';
import type { PersistedSession, PersistedWindow } from './session-types';

function memoryStore(seed?: string): SessionKeyValueStore & { value: () => string | null } {
  let stored: string | null = seed ?? null;
  return {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
    value: () => stored,
  };
}

const sessionA: PersistedSession = {
  version: 4,
  panes: [{ id: 'pane-a', title: 'A', cwd: '/a', untouched: false }],
};
const sessionB: PersistedSession = {
  version: 4,
  panes: [{ id: 'pane-b', title: 'B', cwd: '/b', untouched: false }],
};

const twoWorkspaces: PersistedWindow = {
  version: 2,
  workspaces: [
    { id: 'ws-1', name: 'One', nameIsAuto: false, session: sessionA },
    { id: 'ws-2', name: 'Two', nameIsAuto: false, session: sessionB },
  ],
  activeWorkspaceId: 'ws-2',
};

describe('window-persistence', () => {
  it('round-trips a Window through the slot', () => {
    const store = memoryStore();
    saveWindowState(store, 'k', twoWorkspaces);
    expect(loadWindowState(store, 'k')).toEqual(twoWorkspaces);
  });

  it('discards a blob an older build wrote, quietly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    // A bare Session from before standalone persisted Windows is not wrapped.
    expect(loadWindowState(memoryStore(JSON.stringify({ ...sessionA, version: 3 })), 'k')).toBeNull();
    expect(loadWindowState(memoryStore(JSON.stringify({ ...twoWorkspaces, version: 1 })), 'k')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    info.mockRestore();
  });

  it('starts fresh on an absent, corrupt, or unrecognizable blob', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadWindowState(memoryStore(), 'k')).toBeNull();
    expect(loadWindowState(memoryStore('{not json'), 'k')).toBeNull();
    expect(loadWindowState(memoryStore('{"version":2,"workspaces":"nope"}'), 'k')).toBeNull();
    expect(loadWindowState(memoryStore('{"panes":[]}'), 'k')).toBeNull();
    warn.mockRestore();
  });

  it('drops an unreadable Workspace instead of the whole Window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = memoryStore(JSON.stringify({
      version: 2,
      workspaces: [
        { id: 'ws-1', name: 'One', session: sessionA },
        { id: 'ws-2', name: 'Two', session: { version: 4, panes: 'nope' } },
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
