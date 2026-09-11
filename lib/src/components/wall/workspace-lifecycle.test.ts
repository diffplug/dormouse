/**
 * The Workspace close verb's guards (`docs/specs/layout.md` → "Workspaces").
 * The composed behavior — real Walls, real Surfaces — is in
 * `WorkspaceWindow.test.tsx`; this pins what the verb refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeWorkspaceWithSurfaces,
  LAST_WORKSPACE_REFUSAL,
  requestWorkspaceClose,
} from './workspace-lifecycle';
import { registerWallHandle, resetWallHandles, stubWallHandle, type WallHandle } from './wall-handles';
import { getWorkspaceUiSnapshot, resetWorkspaceUi, setPendingWorkspaceClose, setRenamingWorkspace } from '../../lib/workspace-ui-store';
import {
  closeWorkspace,
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  resetWorkspaces,
} from '../../lib/workspace-store';

function handleFor(workspaceId: string, overrides: Partial<WallHandle> = {}): WallHandle {
  const handle = stubWallHandle(workspaceId, overrides);
  registerWallHandle(handle);
  return handle;
}

const ids = () => getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id);

beforeEach(() => {
  resetWorkspaces();
  resetWorkspaceUi();
  resetWallHandles();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('closeWorkspaceWithSurfaces', () => {
  it('refuses the last Workspace before emptying its Wall', async () => {
    const [only] = ids();
    const closeAll = vi.fn(async () => null);
    handleFor(only, { closeAll });

    expect(await closeWorkspaceWithSurfaces(only)).toBe(LAST_WORKSPACE_REFUSAL);
    expect(closeAll).not.toHaveBeenCalled();
    expect(ids()).toEqual([only]);
  });

  it('refuses a second close while one is in flight, so both Walls cannot empty', async () => {
    const [first] = ids();
    createWorkspace({ id: 'ws-2' });
    let releaseFirst!: () => void;
    const firstClosed = new Promise<void>((resolve) => { releaseFirst = resolve; });
    handleFor(first, { closeAll: async () => { await firstClosed; return null; } });
    const secondCloseAll = vi.fn(async () => null);
    handleFor('ws-2', { closeAll: secondCloseAll });

    const firstClose = closeWorkspaceWithSurfaces(first);
    expect(await closeWorkspaceWithSurfaces('ws-2')).toBe('another Workspace is closing');
    expect(secondCloseAll).not.toHaveBeenCalled();
    // The verb the strip and the keys share takes the same lock.
    requestWorkspaceClose('ws-2');
    expect(getWorkspaceUiSnapshot().pendingClose).toBeNull();

    releaseFirst();
    expect(await firstClose).toBeNull();
    expect(ids()).toEqual(['ws-2']);
  });

  it('hands the Wall back its auto-spawn when the store refuses after a clean closeAll', async () => {
    const [first] = ids();
    createWorkspace({ id: 'ws-2' });
    const cancelClose = vi.fn();
    // The count drops to one WHILE this close is walking its Surfaces, so the
    // store refuses to remove the Workspace the Wall has already emptied.
    handleFor('ws-2', {
      closeAll: async () => { closeWorkspace(first); return null; },
      cancelClose,
    });

    expect(await closeWorkspaceWithSurfaces('ws-2')).toBe(LAST_WORKSPACE_REFUSAL);
    expect(cancelClose).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['ws-2']);
  });

  it('reveals a refused Workspace only when a prompt is what refused it', async () => {
    const [first] = ids();
    createWorkspace({ id: 'ws-2', activate: false });
    handleFor('ws-2', { closeAll: async () => 'notepad archive failed' });

    // `dor workspace close`: the caller is a command, so the refusal comes back
    // as a message and the user stays where they were.
    expect(await closeWorkspaceWithSurfaces('ws-2', 'silent')).toBe('notepad archive failed');
    expect(getActiveWorkspaceId()).toBe(first);

    // A user gesture: the archive-failure prompt is on the refused Workspace's
    // Wall, so that Workspace is revealed.
    expect(await closeWorkspaceWithSurfaces('ws-2', 'prompt')).toBe('notepad archive failed');
    expect(getActiveWorkspaceId()).toBe('ws-2');
  });

  it('refuses a Workspace with no registered Wall instead of closing past its Sessions', async () => {
    const [first] = ids();
    createWorkspace({ id: 'ws-2', activate: false });
    // No `handleFor('ws-2')`: nothing would walk its member Surfaces, so
    // removing the Workspace would leave them running and unreachable. The
    // wording is the router's, so a `dor` caller reads one refusal either way.
    expect(await closeWorkspaceWithSurfaces('ws-2', 'silent')).toBe("workspace 'workspace:2' is still mounting");
    expect(ids()).toEqual([first, 'ws-2']);
  });

  it('releases the lock after a refusal, so the next close still works', async () => {
    const [first] = ids();
    createWorkspace({ id: 'ws-2' });
    handleFor('ws-2', { closeAll: async () => 'notepad archive failed' });
    expect(await closeWorkspaceWithSurfaces('ws-2')).toBe('notepad archive failed');
    expect(ids()).toEqual([first, 'ws-2']);

    handleFor('ws-2', { closeAll: async () => null });
    expect(await closeWorkspaceWithSurfaces('ws-2')).toBeNull();
    expect(ids()).toEqual([first]);
  });

  it('drops the strip UI state with the Workspace, so a stranded rename cannot hold the keyboard lease', async () => {
    createWorkspace({ id: 'ws-2' });
    handleFor('ws-2', { closeAll: async () => null });
    // The rename editor is open on the Workspace being closed: nothing unmounts
    // it through `blur`, so the verb itself has to clear it.
    setRenamingWorkspace('ws-2');
    setPendingWorkspaceClose({ id: 'ws-2', char: 'x' });

    expect(await closeWorkspaceWithSurfaces('ws-2')).toBeNull();
    expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
    expect(getWorkspaceUiSnapshot().pendingClose).toBeNull();
  });
});

describe('requestWorkspaceClose', () => {
  it('waits out the Wall registration gap, then closes rather than refusing unseen', async () => {
    vi.useFakeTimers();
    try {
      const [first] = ids();
      createWorkspace({ id: 'ws-2' });
      // The strip's `×` right after a create: the Workspace is in the store,
      // its Wall is one passive effect away. A gesture has nobody to hand a
      // refusal to, so it waits like the `dor` path instead.
      requestWorkspaceClose('ws-2');
      expect(ids()).toEqual([first, 'ws-2']);
      const closeAll = vi.fn(async () => null);
      handleFor('ws-2', { closeAll });

      await vi.advanceTimersByTimeAsync(0);
      expect(closeAll).toHaveBeenCalledWith('prompt');
      expect(ids()).toEqual([first]);
      expect(getWorkspaceUiSnapshot().pendingClose).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises the confirmation once the registered Wall reports work', async () => {
    const [first] = ids();
    createWorkspace({ id: 'ws-2' });
    handleFor('ws-2', { runningCount: () => 1 });
    requestWorkspaceClose('ws-2');
    await Promise.resolve();
    expect(getWorkspaceUiSnapshot().pendingClose?.id).toBe('ws-2');
    expect(ids()).toEqual([first, 'ws-2']);
  });
});

it('preserves another Workspace’s rename and close confirmation when closing a sibling', async () => {
  const [first] = ids();
  createWorkspace({ id: 'ws-2' });
  handleFor('ws-2');
  setRenamingWorkspace(first);
  setPendingWorkspaceClose({ id: first, char: 'x' });
  const before = getWorkspaceUiSnapshot();
  expect(await closeWorkspaceWithSurfaces('ws-2')).toBeNull();
  expect(getWorkspaceUiSnapshot()).toBe(before);
});
