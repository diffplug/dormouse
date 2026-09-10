/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWorkspaceControl, listAllWorkspaceSurfaces, workspaceRows } from './workspace-control';
import { registerWallHandle, resetWallHandles, stubWallHandle, type WallHandle } from './wall-handles';
import type { DorControlRequest } from './use-dor-control';
import {
  createWorkspace,
  getWorkspacesSnapshot,
  renameWorkspace,
  resetWorkspaces,
} from '../../lib/workspace-store';
import { clearTerminalActivity, setTerminalActivity } from '../../lib/session-activity-store';
import { resetWorkspaceSurfaces, setWorkspaceSurfaces } from '../../lib/workspace-surfaces';
import { resetWindowSessionAggregator } from '../../lib/window-session-aggregator';

const disposers: Array<() => void> = [];

function handleFor(workspaceId: string, overrides: Partial<WallHandle> = {}): WallHandle {
  const handle = stubWallHandle(workspaceId, overrides);
  disposers.push(registerWallHandle(handle));
  return handle;
}

function request(method: string, params: Record<string, unknown> = {}): DorControlRequest & { respond: ReturnType<typeof vi.fn> } {
  return {
    requestId: 'r1',
    method,
    params,
    respond: vi.fn(),
  } as unknown as DorControlRequest & { respond: ReturnType<typeof vi.fn> };
}

/** The `result` of a request that succeeded, else the failure's message. */
function answer(detail: { respond: ReturnType<typeof vi.fn> }): unknown {
  const [response] = detail.respond.mock.calls[0] ?? [];
  expect(response).toBeDefined();
  return response.ok ? response.result : response.error;
}

beforeEach(() => {
  resetWallHandles();
  resetWorkspaces();
  resetWorkspaceSurfaces();
  resetWindowSessionAggregator();
  clearTerminalActivity();
});

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
});

describe('workspace.list', () => {
  it('reports one row per Workspace with its union status', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    const second = createWorkspace({ id: 'ws-2', name: 'build', activate: false }).id;
    setWorkspaceSurfaces(first, ['a']);
    setWorkspaceSurfaces(second, ['b', 'c']);
    setTerminalActivity('b', { status: 'ALERT_RINGING' });
    setTerminalActivity('c', { todo: true });

    const detail = request('workspace.list');
    await handleWorkspaceControl(detail);

    expect(answer(detail)).toEqual({
      windowRef: 'window:1',
      workspaces: [
        { ref: 'workspace:1', id: first, name: 'Workspace 1', active: true, ringing: false, todo: false, count: 0 },
        { ref: 'workspace:2', id: 'ws-2', name: 'build', active: false, ringing: true, todo: true, count: 2 },
      ],
    });
    expect(workspaceRows()).toHaveLength(2);
  });
});

describe('workspace mutation verbs', () => {
  it('creates in the background, so the user is not moved', async () => {
    const active = getWorkspacesSnapshot().activeId;
    const detail = request('workspace.new', { name: '  build  ' });
    await handleWorkspaceControl(detail);

    const created = getWorkspacesSnapshot().workspaces[1];
    expect(answer(detail)).toEqual({
      status: 'created',
      workspaceId: created.id,
      workspaceRef: 'workspace:2',
      name: 'build',
    });
    expect(getWorkspacesSnapshot().activeId).toBe(active);
  });

  it('renames and switches by positional ref or name', async () => {
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });

    const renamed = request('workspace.rename', { workspace: 'workspace:build', name: 'agents' });
    await handleWorkspaceControl(renamed);
    expect(answer(renamed)).toEqual({
      status: 'renamed', workspaceId: 'ws-2', workspaceRef: 'workspace:2', name: 'agents',
    });

    const switched = request('workspace.switch', { workspace: 'agents' });
    await handleWorkspaceControl(switched);
    expect(answer(switched)).toMatchObject({ status: 'active', workspaceId: 'ws-2' });
    expect(getWorkspacesSnapshot().activeId).toBe('ws-2');
  });

  it('refuses an ambiguous name instead of picking, and lists the candidates', async () => {
    renameWorkspace(getWorkspacesSnapshot().workspaces[0].id, 'build');
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });

    const detail = request('workspace.switch', { workspace: 'build' });
    await handleWorkspaceControl(detail);

    expect(answer(detail)).toBe(
      'workspace target \'build\' matched multiple Workspaces: workspace:1 "build", workspace:2 "build"',
    );
  });

  it('requires a target and a name', async () => {
    const noTarget = request('workspace.rename', { name: 'x' });
    await handleWorkspaceControl(noTarget);
    expect(answer(noTarget)).toBe('workspace is required');

    const noName = request('workspace.rename', { workspace: 'workspace:1', name: '   ' });
    await handleWorkspaceControl(noName);
    expect(answer(noName)).toBe('name is required');
  });
});

describe('workspace.close', () => {
  it('refuses a Workspace holding work, and closes it with force', async () => {
    const second = createWorkspace({ id: 'ws-2', name: 'build', activate: false }).id;
    const closeAll = vi.fn(async () => null);
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    handleFor(second, { runningCount: () => 1, closeAll });

    const refused = request('workspace.close', { workspace: 'workspace:2' });
    await handleWorkspaceControl(refused);
    expect(answer(refused)).toBe(
      "workspace 'workspace:2' holds running or touched Surfaces; pass --force to close it",
    );
    expect(closeAll).not.toHaveBeenCalled();
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(2);

    const forced = request('workspace.close', { workspace: 'workspace:2', force: true });
    await handleWorkspaceControl(forced);
    expect(answer(forced)).toEqual({
      status: 'closed', workspaceId: second, workspaceRef: 'workspace:2', name: 'build',
    });
    // A command close raises no pane prompt, exactly like `dor kill`.
    expect(closeAll).toHaveBeenCalledWith('silent');
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
  });

  it('refuses the last Workspace', async () => {
    const only = getWorkspacesSnapshot().workspaces[0].id;
    handleFor(only);
    const detail = request('workspace.close', { workspace: 'workspace:1' });
    await handleWorkspaceControl(detail);
    expect(answer(detail)).toBe(
      "workspace 'workspace:1' was not closed: the last Workspace cannot be closed",
    );
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
  });

  it('refuses a second close while one is in flight', async () => {
    createWorkspace({ id: 'ws-2', activate: false });
    createWorkspace({ id: 'ws-3', activate: false });
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    let releaseFirst = () => {};
    handleFor('ws-2', { closeAll: () => new Promise<string | null>((resolve) => { releaseFirst = () => resolve(null); }) });
    handleFor('ws-3');

    const first = request('workspace.close', { workspace: 'workspace:2', force: true });
    const running = handleWorkspaceControl(first);

    const second = request('workspace.close', { workspace: 'workspace:3', force: true });
    await handleWorkspaceControl(second);
    expect(answer(second)).toBe("workspace 'workspace:3' was not closed: another Workspace is closing");

    releaseFirst();
    await running;
    expect(answer(first)).toMatchObject({ status: 'closed' });
  });
});

describe('surface.list --all', () => {
  it('tags every row with its Workspace and carries the directory', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    const listing = (refs: string[]) => vi.fn((detail: DorControlRequest) => {
      detail.respond({
        ok: true,
        result: {
          surfaces: refs.map((ref) => ({ ref, id: `${ref}-id` })),
          workspaceRef: 'workspace:x',
          windowRef: 'window:1',
        },
      });
    });
    handleFor(first, { handleDorControl: listing(['surface:1']) });
    const second = listing(['surface:1', 'surface:2']);
    handleFor('ws-2', { handleDorControl: second });

    const detail = request('surface.list', { scope: 'all', includePorts: true });
    await listAllWorkspaceSurfaces(detail);

    const result = answer(detail) as { surfaces: Array<{ ref: string; workspaceRef: string }>; workspaces: unknown[] };
    expect(result.surfaces.map((surface) => [surface.workspaceRef, surface.ref])).toEqual([
      ['workspace:1', 'surface:1'],
      ['workspace:2', 'surface:1'],
      ['workspace:2', 'surface:2'],
    ]);
    expect(result.workspaces).toHaveLength(2);
    // Each Wall is asked for its own Workspace, with the caller's scope removed.
    expect(second.mock.calls[0][0].params).toMatchObject({ scope: 'workspace', includePorts: true });
  });

  it('fails the whole listing when one Workspace cannot answer', async () => {
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    handleFor(getWorkspacesSnapshot().workspaces[0].id, {
      handleDorControl: (detail) => detail.respond({ ok: true, result: { surfaces: [], workspaceRef: 'workspace:1', windowRef: 'window:1' } }),
    });
    handleFor('ws-2', { handleDorControl: () => { throw new Error('boom'); } });

    const detail = request('surface.list', { scope: 'all' });
    await listAllWorkspaceSurfaces(detail);
    expect(answer(detail)).toBe('workspace:2: boom');
  });
});
