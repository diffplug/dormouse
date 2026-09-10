import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeWorkspace,
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  moveWorkspace,
  renameWorkspace,
  resetWorkspaces,
  setActiveWorkspace,
  setWorkspaces,
  subscribeToWorkspaces,
  workspaceIdForRef,
  workspaceRefFor,
} from './workspace-store';
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME } from './session-types';

describe('workspace-store', () => {
  beforeEach(() => resetWorkspaces());

  it('defaults to a single "Workspace 1", active', () => {
    expect(getWorkspacesSnapshot()).toEqual({
      workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME }],
      activeId: DEFAULT_WORKSPACE_ID,
    });
  });

  it('returns a stable snapshot reference until a mutation', () => {
    const first = getWorkspacesSnapshot();
    expect(getWorkspacesSnapshot()).toBe(first);
    createWorkspace({ id: 'ws-2' });
    expect(getWorkspacesSnapshot()).not.toBe(first);
  });

  it('createWorkspace appends, auto-names "Workspace N", and activates by default', () => {
    const meta = createWorkspace();
    expect(meta.name).toBe('Workspace 2');
    expect(getActiveWorkspaceId()).toBe(meta.id);
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(2);
  });

  it('createWorkspace with activate:false leaves the active workspace unchanged', () => {
    createWorkspace({ id: 'ws-2', activate: false });
    expect(getActiveWorkspaceId()).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('generates unique ids that never collide with the default', () => {
    const a = createWorkspace();
    const b = createWorkspace();
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(DEFAULT_WORKSPACE_ID);
  });

  it('keeps generated identities unique when the random source repeats', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const a = createWorkspace();
      const b = createWorkspace();
      expect(a.id).not.toBe(b.id);
      expect(closeWorkspace(b.id)).toBe(true);
      expect(getActiveWorkspaceId()).toBe(a.id);
    } finally {
      random.mockRestore();
    }
  });

  it('rejects duplicate identities without mutation or notification', () => {
    const initial = getWorkspacesSnapshot();
    const listener = vi.fn();
    const unsubscribe = subscribeToWorkspaces(listener);
    try {
      expect(() => createWorkspace({ id: DEFAULT_WORKSPACE_ID })).toThrow('Duplicate Workspace id');
      expect(() => setWorkspaces({
        activeId: DEFAULT_WORKSPACE_ID,
        workspaces: [...initial.workspaces, { id: DEFAULT_WORKSPACE_ID, name: 'Duplicate' }],
      })).toThrow('Duplicate Workspace id');
      expect(getWorkspacesSnapshot()).toBe(initial);
      expect(listener).not.toHaveBeenCalled();
      expect(closeWorkspace(DEFAULT_WORKSPACE_ID)).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('setActiveWorkspace switches and ignores unknown ids', () => {
    createWorkspace({ id: 'ws-2', activate: false });
    setActiveWorkspace('ws-2');
    expect(getActiveWorkspaceId()).toBe('ws-2');
    setActiveWorkspace('nope');
    expect(getActiveWorkspaceId()).toBe('ws-2');
  });

  it('renameWorkspace updates the name; ignores empty and unknown', () => {
    renameWorkspace(DEFAULT_WORKSPACE_ID, '  Build  ');
    expect(getWorkspacesSnapshot().workspaces[0].name).toBe('Build');
    renameWorkspace(DEFAULT_WORKSPACE_ID, '   ');
    expect(getWorkspacesSnapshot().workspaces[0].name).toBe('Build');
    renameWorkspace('nope', 'X'); // no throw
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
  });

  it('closeWorkspace refuses to close the last Workspace', () => {
    expect(closeWorkspace(DEFAULT_WORKSPACE_ID)).toBe(false);
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
  });

  it('closeWorkspace removes a non-last Workspace and activates the previous neighbor', () => {
    createWorkspace({ id: 'ws-2' });
    createWorkspace({ id: 'ws-3' }); // active = ws-3
    expect(closeWorkspace('ws-3')).toBe(true);
    expect(getActiveWorkspaceId()).toBe('ws-2'); // previous neighbor
    expect(getWorkspacesSnapshot().workspaces.map((w) => w.id)).toEqual([DEFAULT_WORKSPACE_ID, 'ws-2']);
  });

  it('closing an inactive Workspace keeps the active one', () => {
    createWorkspace({ id: 'ws-2' }); // active = ws-2
    expect(closeWorkspace(DEFAULT_WORKSPACE_ID)).toBe(true);
    expect(getActiveWorkspaceId()).toBe('ws-2');
  });

  it('setWorkspaces loads a list; bad activeId falls back to first; empty resets to default', () => {
    setWorkspaces({ workspaces: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], activeId: 'gone' });
    expect(getActiveWorkspaceId()).toBe('a');
    setWorkspaces({ workspaces: [], activeId: 'x' });
    expect(getWorkspacesSnapshot()).toEqual({
      workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME }],
      activeId: DEFAULT_WORKSPACE_ID,
    });
  });

  it('notifies subscribers on change', () => {
    const listener = vi.fn();
    const unsub = subscribeToWorkspaces(listener);
    createWorkspace({ id: 'ws-2' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    createWorkspace({ id: 'ws-3' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('moveWorkspace reorders and clamps, and reports whether the list changed', () => {
    createWorkspace({ id: 'ws-2' });
    createWorkspace({ id: 'ws-3' });
    const ids = () => getWorkspacesSnapshot().workspaces.map((w) => w.id);

    expect(moveWorkspace('ws-3', 0)).toBe(true);
    expect(ids()).toEqual(['ws-3', DEFAULT_WORKSPACE_ID, 'ws-2']);
    // Clamped into range rather than refused.
    expect(moveWorkspace('ws-3', 99)).toBe(true);
    expect(ids()).toEqual([DEFAULT_WORKSPACE_ID, 'ws-2', 'ws-3']);
    expect(moveWorkspace('ws-3', 2)).toBe(false);
    expect(moveWorkspace('missing', 0)).toBe(false);
    // Reordering never changes which Workspace is active.
    expect(getActiveWorkspaceId()).toBe('ws-3');
  });

  it('workspace refs are positional and renumber on reorder', () => {
    createWorkspace({ id: 'ws-2' });
    expect(workspaceRefFor(DEFAULT_WORKSPACE_ID)).toBe('workspace:1');
    expect(workspaceRefFor('ws-2')).toBe('workspace:2');
    // A Workspace already gone (its Wall is mid-unmount) answers the first ref.
    expect(workspaceRefFor('missing')).toBe('workspace:1');
    expect(workspaceIdForRef('workspace:2')).toBe('ws-2');
    expect(workspaceIdForRef('2')).toBe('ws-2');
    expect(workspaceIdForRef('workspace:9')).toBeNull();
    expect(workspaceIdForRef('workspace:0')).toBeNull();
    expect(workspaceIdForRef('nonsense')).toBeNull();

    moveWorkspace('ws-2', 0);
    expect(workspaceRefFor('ws-2')).toBe('workspace:1');
    expect(workspaceIdForRef('workspace:1')).toBe('ws-2');
  });
});
