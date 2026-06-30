import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeWorkspace,
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  renameWorkspace,
  resetWorkspaces,
  setActiveWorkspace,
  setWorkspaces,
  subscribeToWorkspaces,
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
});
