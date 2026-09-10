import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptWorkspaceSession,
  flushWindowSession,
  forgetWorkspaceSession,
  getWindowSnapshot,
  installWindowSessionWriter,
  previousWorkspaceSession,
  publishWorkspaceSession,
  resetWindowSessionAggregator,
  seedWindowSession,
} from './window-session-aggregator';
import type { PersistedSession, PersistedWindow } from './session-types';
import {
  createWorkspace,
  moveWorkspace,
  renameWorkspace,
  resetWorkspaces,
  setActiveWorkspace,
  getWorkspacesSnapshot,
} from './workspace-store';

function session(paneId: string): PersistedSession {
  return { version: 3, panes: [{ id: paneId, title: paneId, cwd: null, untouched: true, alert: null }], doors: [] };
}

/** Run the debounce out and let the writer's own promise settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetWindowSessionAggregator();
  resetWorkspaces();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('window session aggregator', () => {
  it('orders Workspaces by the store and carries the active id', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    const second = createWorkspace({ name: 'Second' }).id;
    publishWorkspaceSession(first, session('a'));
    publishWorkspaceSession(second, session('b'));

    expect(getWindowSnapshot()).toMatchObject({
      version: 1,
      activeWorkspaceId: second,
      workspaces: [{ id: first }, { id: second, name: 'Second' }],
    });

    moveWorkspace(second, 0);
    expect(getWindowSnapshot().workspaces.map((ws) => ws.id)).toEqual([second, first]);
    setActiveWorkspace(first);
    expect(getWindowSnapshot().activeWorkspaceId).toBe(first);
  });

  it('drops a Workspace with neither a published nor a seeded session', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ name: 'Second' });
    publishWorkspaceSession(first, session('a'));
    expect(getWindowSnapshot().workspaces.map((ws) => ws.id)).toEqual([first]);
  });

  it('forgets a Workspace session and its seed', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    seedWindowSession({ version: 1, workspaces: [{ id: first, name: 'One', session: session('seed') }], activeWorkspaceId: first });
    publishWorkspaceSession(first, session('a'));
    forgetWorkspaceSession(first);
    expect(getWindowSnapshot().workspaces).toEqual([]);
    expect(previousWorkspaceSession(first)).toBeNull();
  });

  describe('seed', () => {
    const first = () => getWorkspacesSnapshot().workspaces[0].id;

    it('answers for a Workspace whose Wall has not published yet', () => {
      const second = createWorkspace({ id: 'ws-2', name: 'Second' }).id;
      const seeded: PersistedWindow = {
        version: 1,
        workspaces: [
          { id: first(), name: 'One', session: session('a-seed') },
          { id: second, name: 'Second', session: session('b-seed') },
        ],
        activeWorkspaceId: second,
      };
      seedWindowSession(seeded);

      // Both Workspaces are in the snapshot before any Wall mounts, so a write
      // taken mid-boot cannot replace a restored Workspace with a blank one.
      expect(getWindowSnapshot().workspaces.map((ws) => ws.session.panes[0].id))
        .toEqual(['a-seed', 'b-seed']);
      expect(previousWorkspaceSession(second)?.panes[0].id).toBe('b-seed');

      // A publish takes over for that Workspace only.
      publishWorkspaceSession(second, session('b-live'));
      expect(previousWorkspaceSession(second)?.panes[0].id).toBe('b-live');
      expect(previousWorkspaceSession(first())?.panes[0].id).toBe('a-seed');
    });

    it('replaces the previous seed, and null clears it', () => {
      seedWindowSession({ version: 1, workspaces: [{ id: first(), name: 'One', session: session('old') }], activeWorkspaceId: first() });
      seedWindowSession(null);
      expect(previousWorkspaceSession(first())).toBeNull();
      expect(getWindowSnapshot().workspaces).toEqual([]);
    });

    it('adopts a record from elsewhere as that Workspace\'s previous', () => {
      const second = createWorkspace({ id: 'ws-2', name: 'Second' }).id;
      publishWorkspaceSession(second, session('stale'));
      adoptWorkspaceSession(second, session('moved-in'));
      expect(previousWorkspaceSession(second)?.panes[0].id).toBe('moved-in');
    });
  });

  describe('writer', () => {
    it('debounces publishes into one write and flushes on demand', async () => {
      const write = vi.fn();
      installWindowSessionWriter(write);
      const first = getWorkspacesSnapshot().workspaces[0].id;
      const second = createWorkspace({ name: 'Second' }).id;

      publishWorkspaceSession(first, session('a'));
      publishWorkspaceSession(second, session('b'));
      expect(write).not.toHaveBeenCalled();

      await settle();
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0].workspaces).toHaveLength(2);

      // Flush writes immediately and leaves nothing pending behind it.
      publishWorkspaceSession(first, session('a2'));
      await flushWindowSession();
      expect(write).toHaveBeenCalledTimes(2);
      await settle();
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('awaits the host write a flush starts', async () => {
      let resolveWrite = () => {};
      const write = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
      installWindowSessionWriter(write);
      publishWorkspaceSession(getWorkspacesSnapshot().workspaces[0].id, session('a'));

      let done = false;
      const flushed = flushWindowSession().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      resolveWrite();
      await flushed;
      expect(done).toBe(true);
    });

    it('writes on a Workspace-store change with no session change', async () => {
      const write = vi.fn();
      const first = getWorkspacesSnapshot().workspaces[0].id;
      publishWorkspaceSession(first, session('a'));
      installWindowSessionWriter(write);

      renameWorkspace(first, 'Renamed');
      await settle();
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0].workspaces[0].name).toBe('Renamed');

      const second = createWorkspace({ name: 'Second' }).id;
      setActiveWorkspace(second);
      await settle();
      expect(write.mock.calls.at(-1)?.[0].activeWorkspaceId).toBe(second);
    });

    it('stops writing once uninstalled, pending timer included', async () => {
      const write = vi.fn();
      const uninstall = installWindowSessionWriter(write);
      const first = getWorkspacesSnapshot().workspaces[0].id;

      publishWorkspaceSession(first, session('a'));
      uninstall();
      await settle();
      expect(write).not.toHaveBeenCalled();

      publishWorkspaceSession(first, session('b'));
      await settle();
      expect(write).not.toHaveBeenCalled();
      // The store subscription goes with it.
      renameWorkspace(first, 'Renamed');
      await settle();
      expect(write).not.toHaveBeenCalled();
    });

    it('ships with no writer installed', async () => {
      const first = getWorkspacesSnapshot().workspaces[0].id;
      expect(() => publishWorkspaceSession(first, session('a'))).not.toThrow();
      await expect(flushWindowSession()).resolves.toBeUndefined();
    });

    it('survives a rejecting host write', async () => {
      const write = vi.fn(() => Promise.reject(new Error('disk full')));
      installWindowSessionWriter(write);
      publishWorkspaceSession(getWorkspacesSnapshot().workspaces[0].id, session('a'));
      await expect(flushWindowSession()).resolves.toBeUndefined();
    });
  });
});
