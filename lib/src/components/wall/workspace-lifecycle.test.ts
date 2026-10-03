/**
 * The Workspace close verb's guards (`docs/specs/layout.md` → "Workspaces").
 * The composed behavior — real Walls, real Surfaces — is in
 * `WorkspaceWindow.test.tsx`; this pins what the verb refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeWorkspaceWithSurfaces,
  enterWorkspace,
  requestWorkspaceClose,
} from './workspace-lifecycle';
import { registerWallHandle, resetWallHandles, stubWallHandle, type WallHandle } from './wall-handles';
import { cancelPendingConfirmation, getWorkspaceUiSnapshot, requestConfirmation, resetWorkspaceUi, setRenamingWorkspace } from '../../lib/workspace-ui-store';
import {
  closeWorkspace,
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  resetWorkspaces,
  setActiveWorkspace,
} from '../../lib/workspace-store';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
import { cancelEditorClose, decideEditorClose, getEditorClosePrompt, UNSAVED_TOOL_REFUSAL } from '../../lib/tool-editor';

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
  cancelEditorClose();
  resetToolDirty();
  vi.restoreAllMocks();
});

describe('closeWorkspaceWithSurfaces', () => {
  it('closes the last Workspace before creating its replacement', async () => {
    const [only] = ids();
    const closeAll = vi.fn(async () => null);
    handleFor(only, { closeAll });

    expect(await closeWorkspaceWithSurfaces(only)).toBeNull();
    expect(closeAll).toHaveBeenCalled();
    expect(ids()).toHaveLength(1);
    expect(ids()).not.toContain(only);
  });

  it('asks once for every dirty Tool before closing any Surface; a command close refuses', async () => {
    const [only] = ids();
    const closeAll = vi.fn(async () => null);
    handleFor(only, { closeAll, dirtyToolIds: () => ['a', 'b'] });
    recordToolDirty('a', true);
    recordToolDirty('b', true);

    expect(await closeWorkspaceWithSurfaces(only, 'silent')).toBe(UNSAVED_TOOL_REFUSAL);
    expect(getEditorClosePrompt()).toBeNull();
    const cancelled = closeWorkspaceWithSurfaces(only);
    expect(getEditorClosePrompt()?.items.map((item) => item.id)).toEqual(['a', 'b']);
    await decideEditorClose('cancel');
    expect(await cancelled).toBe(UNSAVED_TOOL_REFUSAL);
    expect(closeAll).not.toHaveBeenCalled();

    const discarded = closeWorkspaceWithSurfaces(only);
    await decideEditorClose('discard');
    expect(await discarded).toBeNull();
    expect(closeAll).toHaveBeenCalledWith(['a', 'b']);
  });

  it('abandons a close awaiting dirty-editor consent when a newer move starts', async () => {
    const [only] = ids();
    const closeAll = vi.fn(async () => null);
    handleFor(only, { closeAll, dirtyToolIds: () => ['editor'] });
    recordToolDirty('editor', true);
    const pending = closeWorkspaceWithSurfaces(only);
    expect(getEditorClosePrompt()).not.toBeNull();
    cancelPendingConfirmation();
    await decideEditorClose('discard');
    expect(await pending).toContain('superseded');
    expect(closeAll).not.toHaveBeenCalled();
    expect(ids()).toContain(only);
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
    expect(getWorkspaceUiSnapshot().confirmation).toBeNull();

    releaseFirst();
    expect(await firstClose).toBeNull();
    expect(ids()).toEqual(['ws-2']);
  });

  it('replaces the last Workspace even when a sibling disappears during closure', async () => {
    const [first] = ids();
    createWorkspace({ id: 'ws-2' });
    // A sibling disappears while this close is walking its Surfaces.
    handleFor('ws-2', {
      closeAll: async () => { closeWorkspace(first); return null; },
    });

    expect(await closeWorkspaceWithSurfaces('ws-2')).toBeNull();
    expect(ids()).toHaveLength(1);
    expect(ids()).not.toContain('ws-2');
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

  it('drops the strip UI state with the Workspace, so a stranded rename cannot hold the keyboard lease', async () => {
    createWorkspace({ id: 'ws-2' });
    handleFor('ws-2', { closeAll: async () => null });
    // The rename editor is open on the Workspace being closed: nothing unmounts
    // it through `blur`, so the verb itself has to clear it.
    setRenamingWorkspace('ws-2');
    const answer = vi.fn();
    requestConfirmation({ id: 'ws-2', char: 'a', answer });

    expect(await closeWorkspaceWithSurfaces('ws-2')).toBeNull();
    expect(answer).toHaveBeenCalledExactlyOnceWith(false);
    expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
    expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
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
      expect(closeAll).toHaveBeenCalled();
      expect(ids()).toEqual([first]);
      expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises the confirmation once the registered Wall reports work', async () => {
    const [first] = ids();
    createWorkspace({ id: 'ws-2' });
    handleFor('ws-2', { needsCloseConfirmation: () => true });
    requestWorkspaceClose('ws-2');
    await Promise.resolve();
    expect(getWorkspaceUiSnapshot().confirmation?.id).toBe('ws-2');
    expect(ids()).toEqual([first, 'ws-2']);
  });
});

it('preserves another Workspace’s rename and close confirmation when closing a sibling', async () => {
  const [first] = ids();
  createWorkspace({ id: 'ws-2' });
  const answer = vi.fn();
  // A confirmation raised while the close walks its Surfaces is a newer question.
  handleFor('ws-2', { closeAll: async () => { requestConfirmation({ id: first, char: 'x', answer }); return null; } });
  setRenamingWorkspace(first);
  expect(await closeWorkspaceWithSurfaces('ws-2')).toBeNull();
  expect(getWorkspaceUiSnapshot()).toMatchObject({ renamingId: first, confirmation: { id: first, char: 'x' } });
  expect(answer).not.toHaveBeenCalled();
});

it('answers a pending confirmation no when a close is requested', () => {
  createWorkspace({ id: 'ws-2' });
  const answer = vi.fn();
  requestConfirmation({ id: 'ws-2', char: 'a', answer });
  requestWorkspaceClose('ws-2');
  expect(answer).toHaveBeenCalledExactlyOnceWith(false);
  expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
});


describe('enterWorkspace', () => {
  it.each([false, true])('waits for the new Wall and respects navigation away: %s', async navigatedAway => {
    vi.useFakeTimers();
    try {
      const first = getActiveWorkspaceId();
      createWorkspace({ id: 'ws-new' });
      const entering = enterWorkspace('ws-new');
      if (navigatedAway) setActiveWorkspace(first);
      const enterSelectedPane = vi.fn();
      handleFor('ws-new', { enterSelectedPane });
      await vi.advanceTimersByTimeAsync(0);
      await entering;
      expect(enterSelectedPane).toHaveBeenCalledTimes(navigatedAway ? 0 : 1);
      expect(getActiveWorkspaceId()).toBe(navigatedAway ? first : 'ws-new');
    } finally {
      vi.useRealTimers();
    }
  });
});
