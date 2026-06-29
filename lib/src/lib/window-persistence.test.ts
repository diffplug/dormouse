import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeSessionFromStored, storedValueForSession } from './window-persistence';
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
  layout: { panels: { 'pane-a': {} } },
  panes: [{ id: 'pane-a', title: 'A', cwd: null, scrollback: null, resumeCommand: null, untouched: false }],
};
const sessionB: PersistedSession = {
  version: 3,
  layout: { panels: { 'pane-b': {} } },
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

    it('load migrates a pre-workspace bare session transparently', () => {
      expect(activeSessionFromStored(sessionA)).toEqual(sessionA);
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
});
