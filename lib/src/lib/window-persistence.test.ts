import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSessionFromStored, loadSessionState, saveSessionState, storedValueForSession } from './window-persistence';
import {
  DEFAULT_WORKSPACE_ID,
  wrapSessionInWindow,
  type PersistedSession,
  type PersistedWindow,
} from './session-types';
import { setWorkspacesEnabled } from './feature-flags';

function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
}

const sessionA: PersistedSession = {
  version: 3,
  panes: [{ id: 'pane-a', title: 'A', cwd: null, scrollback: null, resumeCommand: null, untouched: false }],
};
const sessionB: PersistedSession = {
  version: 3,
  panes: [{ id: 'pane-b', title: 'B', cwd: null, scrollback: null, resumeCommand: null, untouched: false }],
};

describe('window-persistence', () => {
  beforeEach(stubLocalStorage);
  afterEach(() => vi.unstubAllGlobals());

  describe('flag off (passthrough — identical to today)', () => {
    beforeEach(() => setWorkspacesEnabled(false));

    it('load returns the stored value unchanged', () => {
      expect(activeSessionFromStored(sessionA)).toBe(sessionA);
    });

    it('save returns the session unchanged (bare, not wrapped)', () => {
      expect(storedValueForSession(null, sessionA)).toBe(sessionA);
    });
  });

  describe('flag on (Window container)', () => {
    beforeEach(() => setWorkspacesEnabled(true));

    it('save wraps a fresh session into a single-Workspace Window', () => {
      const stored = storedValueForSession(null, sessionA) as PersistedWindow;
      expect(stored.version).toBe(1);
      expect(stored.workspaces).toHaveLength(1);
      expect(stored.activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
      expect(stored.workspaces[0].session.panes[0].id).toBe('pane-a');
    });

    it('round-trips: save then load yields the same active session', () => {
      const stored = storedValueForSession(null, sessionA);
      expect(activeSessionFromStored(stored)).toEqual(sessionA);
    });

    it('save replaces only the active Workspace, preserving the others', () => {
      const existing: PersistedWindow = {
        version: 1,
        activeWorkspaceId: 'ws-b',
        workspaces: [
          { id: 'ws-a', name: 'A', session: sessionA },
          { id: 'ws-b', name: 'B', session: sessionA },
        ],
      };
      const stored = storedValueForSession(existing, sessionB) as PersistedWindow;
      expect(stored.workspaces.find((w) => w.id === 'ws-a')!.session).toEqual(sessionA);
      expect(stored.workspaces.find((w) => w.id === 'ws-b')!.session).toEqual(sessionB);
    });

    it('load returns the active Workspace session from a multi-Workspace Window', () => {
      const win = wrapSessionInWindow(sessionA);
      const multi: PersistedWindow = {
        version: 1,
        activeWorkspaceId: 'ws-b',
        workspaces: [...win.workspaces, { id: 'ws-b', name: 'B', session: sessionB }],
      };
      expect(activeSessionFromStored(multi)).toEqual(sessionB);
    });

    it('load returns null for unusable stored input', () => {
      expect(activeSessionFromStored(null)).toBeNull();
      expect(activeSessionFromStored({ junk: true })).toBeNull();
    });
  });

  describe('storage round trip (loadSessionState / saveSessionState)', () => {
    function spyStorage(initial: string | null = null) {
      let value = initial;
      const getItem = vi.fn((_key: string) => value);
      const setItem = vi.fn((_key: string, next: string) => { value = next; });
      const storage = { getItem, setItem, removeItem: vi.fn() } as unknown as Storage;
      return { storage, getItem, setItem };
    }

    it('flag off: saves the bare session WITHOUT reading the existing blob', () => {
      setWorkspacesEnabled(false);
      const { storage, getItem, setItem } = spyStorage(JSON.stringify(sessionB));
      saveSessionState(storage, 'k', sessionA);
      // The efficiency win: no wasted read/parse of the (scrollback-bearing) blob.
      expect(getItem).not.toHaveBeenCalled();
      expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual(sessionA);
    });

    it('flag off: load returns the bare stored session', () => {
      setWorkspacesEnabled(false);
      const { storage } = spyStorage(JSON.stringify(sessionA));
      expect(loadSessionState(storage, 'k')).toEqual(sessionA);
    });

    it('flag on: save wraps into a Window and load round-trips the active session', () => {
      setWorkspacesEnabled(true);
      const { storage } = spyStorage();
      saveSessionState(storage, 'k', sessionA);
      const stored = JSON.parse((storage.getItem('k'))!) as PersistedWindow;
      expect(stored.version).toBe(1);
      expect(stored.activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
      expect(loadSessionState(storage, 'k')).toEqual(sessionA);
    });

    it('flag on: save preserves other Workspaces by reading the existing Window', () => {
      setWorkspacesEnabled(true);
      const existing: PersistedWindow = {
        version: 1,
        activeWorkspaceId: 'ws-b',
        workspaces: [
          { id: 'ws-a', name: 'A', session: sessionA },
          { id: 'ws-b', name: 'B', session: sessionA },
        ],
      };
      const { storage } = spyStorage(JSON.stringify(existing));
      saveSessionState(storage, 'k', sessionB);
      const stored = JSON.parse((storage.getItem('k'))!) as PersistedWindow;
      expect(stored.workspaces.find((w) => w.id === 'ws-a')!.session).toEqual(sessionA);
      expect(stored.workspaces.find((w) => w.id === 'ws-b')!.session).toEqual(sessionB);
    });

    it('load returns null when storage is empty', () => {
      const { storage } = spyStorage(null);
      expect(loadSessionState(storage, 'k')).toBeNull();
    });
  });
});
