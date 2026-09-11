import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeWorkspace,
  createWorkspace,
  generateWorkspaceId,
  installWorkspaceIdPool,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  moveWorkspace,
  renameWorkspace,
  resetWorkspaceIdPool,
  resetWorkspaces,
  setActiveWorkspace,
  setWorkspaces,
  subscribeToWorkspaces,
  resolveWorkspaceRef,
  workspaceRefFor,
} from './workspace-store';
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME } from './session-types';

/** A host that mints: `workspace-<from>` upward, one block per call. */
function minting(from = 100) {
  let next = from;
  return vi.fn(async (count: number) => Array.from({ length: count }, () => `workspace-${next++}`));
}

describe('workspace-store', () => {
  beforeEach(() => {
    resetWorkspaceIdPool();
    resetWorkspaces();
  });

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

  it('workspace refs are the minted id number under a registry, and survive a reorder', async () => {
    await installWorkspaceIdPool(minting(7));
    // Under a registry the bare Wall's default id, `workspace-1`, is a minted one.
    const second = createWorkspace();
    expect(second.id).toBe('workspace-7');
    expect(workspaceRefFor(DEFAULT_WORKSPACE_ID)).toBe('workspace:1');
    expect(workspaceRefFor('workspace-7')).toBe('workspace:7');
    // A minted Workspace already gone (its Wall is mid-unmount) keeps its number.
    expect(workspaceRefFor('workspace-9')).toBe('workspace:9');
    // A resolution carries the Workspace, so a caller needs no second lookup.
    expect(resolveWorkspaceRef('workspace:7')).toEqual({ ok: true, id: 'workspace-7', name: 'Workspace 2', ref: 'workspace:7' });
    expect(resolveWorkspaceRef('7')).toMatchObject({ ok: true, id: 'workspace-7' });
    // The strip position is not a ref once ids are minted.
    for (const ref of ['workspace:2', 'workspace:9', 'workspace:0', 'nonsense']) {
      expect(resolveWorkspaceRef(ref)).toEqual({ ok: false, message: `unknown workspace target '${ref}'` });
    }

    moveWorkspace('workspace-7', 0);
    expect(workspaceRefFor('workspace-7')).toBe('workspace:7');
    expect(resolveWorkspaceRef('workspace:7')).toMatchObject({ ok: true, id: 'workspace-7', ref: 'workspace:7' });
    expect(resolveWorkspaceRef('workspace:1')).toMatchObject({ ok: true, id: DEFAULT_WORKSPACE_ID });
  });

  it('refs are positional only while nothing in the Window was minted', async () => {
    await installWorkspaceIdPool(minting(7));
    // A snapshot from before the registry: every id unminted, so refs are
    // positions and a reorder renumbers them.
    setWorkspaces({ workspaces: [{ id: 'ws-a', name: 'A' }, { id: 'ws-b', name: 'B' }], activeId: 'ws-a' });
    expect(workspaceRefFor('ws-b')).toBe('workspace:2');
    expect(resolveWorkspaceRef('workspace:2')).toMatchObject({ ok: true, id: 'ws-b', ref: 'workspace:2' });
    moveWorkspace('ws-b', 0);
    expect(workspaceRefFor('ws-b')).toBe('workspace:1');
    expect(resolveWorkspaceRef('workspace:1')).toMatchObject({ ok: true, id: 'ws-b' });
    // A Workspace already gone reports the first ref.
    expect(workspaceRefFor('missing')).toBe('workspace:1');

    // The first minted id flips the whole Window to stable refs: the number
    // names the minted Workspace and nothing else, and an unminted one is
    // addressed by its name, so no ref reads two ways.
    createWorkspace({ activate: false });
    expect(workspaceRefFor('workspace-7')).toBe('workspace:7');
    expect(resolveWorkspaceRef('workspace:1')).toEqual({ ok: false, message: "unknown workspace target 'workspace:1'" });
    expect(resolveWorkspaceRef('workspace:2')).toEqual({ ok: false, message: "unknown workspace target 'workspace:2'" });
    expect(workspaceRefFor('ws-b')).toBe('workspace:B');
    expect(resolveWorkspaceRef('workspace:B')).toMatchObject({ ok: true, id: 'ws-b', ref: 'workspace:B' });
    expect(workspaceRefFor('missing')).toBe('workspace:B');
  });

  it('a host with no registry numbers by position, its default id included', () => {
    // VS Code: the default `workspace-1` beside random ids, and no pool. The
    // default is not a minted id here, so a reorder renumbers it like the rest.
    const second = createWorkspace();
    expect(second.id).not.toMatch(/^workspace-\d+$/);
    expect(workspaceRefFor(DEFAULT_WORKSPACE_ID)).toBe('workspace:1');
    expect(workspaceRefFor(second.id)).toBe('workspace:2');
    moveWorkspace(second.id, 0);
    expect(workspaceRefFor(second.id)).toBe('workspace:1');
    expect(workspaceRefFor(DEFAULT_WORKSPACE_ID)).toBe('workspace:2');
    expect(resolveWorkspaceRef('workspace:1')).toMatchObject({ ok: true, id: second.id, ref: 'workspace:1' });
    expect(resolveWorkspaceRef('workspace:2')).toMatchObject({ ok: true, id: DEFAULT_WORKSPACE_ID, ref: 'workspace:2' });
    // An explicit `workspace-<n>` id is no more minted than a random one.
    createWorkspace({ id: 'workspace-7' });
    expect(workspaceRefFor('workspace-7')).toBe('workspace:3');
    expect(resolveWorkspaceRef('workspace:7')).toEqual({ ok: false, message: "unknown workspace target 'workspace:7'" });
  });

  it('mints ids from the host pool once one is installed', async () => {
    const reserve = minting(100);
    await installWorkspaceIdPool(reserve);
    expect(reserve).toHaveBeenCalledWith(32);
    expect(generateWorkspaceId()).toBe('workspace-100');
    expect(createWorkspace().id).toBe('workspace-101');
    expect(workspaceRefFor('workspace-101')).toBe('workspace:101');
    // Draining past the low-water mark refills in the background.
    for (let i = 0; i < 23; i++) generateWorkspaceId();
    await Promise.resolve();
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it('an installed pool that ran dry throws rather than mint a random id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let reject: (reason: Error) => void = () => {};
      const reserve = vi.fn(() => new Promise<string[]>((_, r) => { reject = r; }));
      const installed = installWorkspaceIdPool(reserve);
      // The first block is still in flight.
      expect(() => generateWorkspaceId()).toThrow('still reserving a block');
      reject(new Error('host down'));
      await installed;
      // The rejection is logged, not swallowed, and the next create names it.
      expect(error).toHaveBeenCalledWith(expect.stringContaining('did not reserve Workspace ids'), expect.any(Error));
      expect(() => createWorkspace()).toThrow('the last reservation failed');
      // A host with no registry falls back to a random id.
      resetWorkspaceIdPool();
      expect(createWorkspace().id).toMatch(/^workspace-[a-z0-9]+-\d+$/);
    } finally {
      error.mockRestore();
    }
  });

  it('resolves a Workspace by name, and refuses an ambiguous one', () => {
    renameWorkspace(DEFAULT_WORKSPACE_ID, 'build');
    createWorkspace({ id: 'ws-2', name: 'agents' });
    expect(resolveWorkspaceRef('workspace:agents')).toMatchObject({ ok: true, id: 'ws-2', name: 'agents' });
    expect(resolveWorkspaceRef('agents')).toMatchObject({ ok: true, id: 'ws-2' });

    createWorkspace({ id: 'ws-3', name: 'agents' });
    expect(resolveWorkspaceRef('agents')).toEqual({
      ok: false,
      message: 'workspace target \'agents\' matched multiple Workspaces: workspace:2 "agents", workspace:3 "agents"',
    });
    // A positional ref is never read as a name, even when a Workspace is named
    // for a number.
    renameWorkspace('ws-3', '1');
    expect(resolveWorkspaceRef('1')).toMatchObject({ ok: true, id: DEFAULT_WORKSPACE_ID });
  });
});
