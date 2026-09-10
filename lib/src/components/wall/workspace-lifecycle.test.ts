/**
 * The Workspace close verb's guards (`docs/specs/layout.md` → "Workspaces").
 * The composed behavior — real Walls, real Surfaces — is in
 * `WorkspaceWindow.test.tsx`; this pins what the verb refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeWorkspaceWithSurfaces,
  LAST_WORKSPACE_REFUSAL,
  NO_WALL_REFUSAL,
  requestWorkspaceClose,
} from './workspace-lifecycle';
import { registerWallHandle, resetWallHandles, stubWallHandle, type WallHandle } from './wall-handles';
import { resetWorkspaceUi, getWorkspaceUiSnapshot } from '../../lib/workspace-ui-store';
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
    // removing the Workspace would leave them running and unreachable.
    expect(await closeWorkspaceWithSurfaces('ws-2', 'silent')).toBe(NO_WALL_REFUSAL);
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
});
