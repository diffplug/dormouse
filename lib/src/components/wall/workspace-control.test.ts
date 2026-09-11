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
import { setPlatform } from '../../lib/platform';
import type { OpenPort, PlatformAdapter } from '../../lib/platform/types';

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

describe('workspace.move', () => {
  it('reorders within the Window without a host, and refuses a move between Windows there', async () => {
    const second = createWorkspace({ id: 'workspace-7', name: 'build', activate: false }).id;
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    handleFor(second);
    const reorder = request('workspace.move', { workspace: 'workspace:7', index: 0 });
    await handleWorkspaceControl(reorder);
    expect(answer(reorder)).toMatchObject({ status: 'moved', workspaceId: second, workspaceRef: 'workspace:7' });
    expect(getWorkspacesSnapshot().workspaces[0].id).toBe(second);

    setPlatform({} as unknown as PlatformAdapter);
    const across = request('workspace.move', { workspace: 'workspace:7', toWindow: 'ws-2' });
    await handleWorkspaceControl(across);
    expect(answer(across)).toMatch(/one window/);

    const neither = request('workspace.move', { workspace: 'workspace:7' });
    await handleWorkspaceControl(neither);
    expect(answer(neither)).toMatch(/needs a window, an index, or both/);
  });

  it('refuses to move a Workspace holding iframes unless told to destroy their page state', async () => {
    const second = createWorkspace({ id: 'workspace-7', name: 'build', activate: false }).id;
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    handleFor(second, { iframeSurfaceIds: () => ['browser-1'] });
    const transferWorkspace = vi.fn(async () => {});
    setPlatform({ transferWorkspace } as unknown as PlatformAdapter);

    const refused = request('workspace.move', { workspace: 'workspace:7', toWindow: 'window:ws-2' });
    await handleWorkspaceControl(refused);
    expect(answer(refused)).toMatch(/1 iframe Surface\(s\).*surface:browser-1.*--dangerously-destroy-iframe-page-state/);
    expect(transferWorkspace).not.toHaveBeenCalled();

    const forced = request('workspace.move', {
      workspace: 'workspace:7', toWindow: 'window:ws-2', dangerouslyDestroyIframePageState: true,
    });
    await handleWorkspaceControl(forced);
    expect(transferWorkspace).toHaveBeenCalledWith(second, 'ws-2', {});
    expect(answer(forced)).toMatchObject({ status: 'moved', workspaceRef: 'workspace:7' });

    transferWorkspace.mockRejectedValueOnce(new Error('the host refused'));
    const failed = request('workspace.move', { workspace: 'workspace:7', toWindow: 'new', dangerouslyDestroyIframePageState: true });
    await handleWorkspaceControl(failed);
    expect(answer(failed)).toMatch(/was not moved: the host refused/);
  });

  it('carries --index to the target window rather than reordering here', async () => {
    const second = createWorkspace({ id: 'workspace-7', name: 'build', activate: false }).id;
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    handleFor(second);
    const transferWorkspace = vi.fn(async () => {});
    setPlatform({ transferWorkspace } as unknown as PlatformAdapter);

    const both = request('workspace.move', { workspace: 'workspace:7', toWindow: 'ws-2', index: 0 });
    await handleWorkspaceControl(both);
    expect(transferWorkspace).toHaveBeenCalledWith(second, 'ws-2', { index: 0 });
    expect(answer(both)).toMatchObject({ status: 'moved', workspaceRef: 'workspace:7' });
    // The slot it names is the target's: this strip is not reordered on the way out.
    expect(getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id)[1]).toBe(second);
  });

  it('answers moved only once the target has adopted the Workspace, and the hand-back reason otherwise', async () => {
    const second = createWorkspace({ id: 'workspace-7', name: 'build', activate: false }).id;
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    handleFor(second);
    let adopt!: () => void;
    const transferWorkspace = vi.fn(() => new Promise<void>((resolve) => { adopt = resolve; }));
    setPlatform({ transferWorkspace } as unknown as PlatformAdapter);

    const pending = request('workspace.move', { workspace: 'workspace:7', toWindow: 'ws-2' });
    const running = handleWorkspaceControl(pending);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transferWorkspace).toHaveBeenCalled();
    // The host took the hand-off; nothing is said until the target settles it.
    expect(pending.respond).not.toHaveBeenCalled();
    adopt();
    await running;
    expect(answer(pending)).toMatchObject({ status: 'moved', workspaceRef: 'workspace:7' });

    transferWorkspace.mockRejectedValueOnce(new Error('the target window closed mid-arrival'));
    const handedBack = request('workspace.move', { workspace: 'workspace:7', toWindow: 'ws-2' });
    await handleWorkspaceControl(handedBack);
    expect(answer(handedBack)).toBe("workspace 'workspace:7' was not moved: the target window closed mid-arrival");
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

  it('refuses a Workspace whose Wall never registered, rather than orphaning its Sessions', async () => {
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    // The Wall is what walks the member Surfaces; without one, dropping the
    // Workspace would leave its PTYs running with nothing holding them.
    const detail = request('workspace.close', { workspace: 'workspace:2', force: true });
    await handleWorkspaceControl(detail);
    expect(answer(detail)).toBe("workspace 'workspace:2' is still mounting");
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(2);
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

/** A Wall that answers `surface.list` with these Surfaces. */
function listing(surfaces: Array<Record<string, unknown>>) {
  return vi.fn((detail: DorControlRequest) => {
    detail.respond({
      ok: true,
      result: { surfaces, workspaceRef: 'workspace:x', windowRef: 'window:1' },
    });
  });
}

/** Terminal rows as a Wall reports them, `focused` on the first. Stable ids are
 *  unique Window-wide, so each Wall's rows carry its own prefix. */
function terminalRows(prefix: string, refs: string[]): Array<Record<string, unknown>> {
  return refs.map((ref, index) => ({ ref, id: `${prefix}-${ref}`, kind: 'terminal', focused: index === 0 }));
}

describe('surface.list --all', () => {
  it('tags every row with its Workspace and carries the directory', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    handleFor(first, { handleDorControl: listing(terminalRows('a', ['surface:1'])) });
    const second = listing(terminalRows('b', ['surface:1', 'surface:2']));
    handleFor('ws-2', { handleDorControl: second });

    const detail = request('surface.list', { scope: 'all' });
    await listAllWorkspaceSurfaces(detail);

    const result = answer(detail) as { surfaces: Array<{ ref: string; workspaceRef: string }>; workspaces: unknown[] };
    expect(result.surfaces.map((surface) => [surface.workspaceRef, surface.ref])).toEqual([
      ['workspace:1', 'surface:1'],
      ['workspace:2', 'surface:1'],
      ['workspace:2', 'surface:2'],
    ]);
    expect(result.workspaces).toHaveLength(2);
    // Each Wall is asked for its own Workspace: the caller's container target
    // is cleared, and a Wall has no scope of its own to read.
    expect(second.mock.calls[0][0].params).toEqual({ scope: 'all', includePorts: false, workspace: undefined });
  });

  it('marks only the active Workspace selection focused', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    // Every Wall marks its own selection; the Window has one focus, and it is
    // in the Workspace the user is looking at.
    createWorkspace({ id: 'ws-2', name: 'build', activate: true });
    handleFor(first, { handleDorControl: listing(terminalRows('a', ['surface:1', 'surface:2'])) });
    handleFor('ws-2', { handleDorControl: listing(terminalRows('b', ['surface:1'])) });

    const detail = request('surface.list', { scope: 'all' });
    await listAllWorkspaceSurfaces(detail);

    const result = answer(detail) as { surfaces: Array<{ ref: string; workspaceRef: string; focused: boolean }> };
    expect(result.surfaces.map((surface) => [surface.workspaceRef, surface.ref, surface.focused])).toEqual([
      ['workspace:1', 'surface:1', false],
      ['workspace:1', 'surface:2', false],
      ['workspace:2', 'surface:1', true],
    ]);
  });

  it('scans every Workspace terminal in one batched call, never per Wall', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    const port = (value: number): OpenPort => ({ family: 'IPv4', address: '127.0.0.1', port: value, pid: 1 });
    const getOpenPortsMany = vi.fn(async (ids: string[]) => Object.fromEntries(
      ids.map((id, index) => [id, [port(5000 + index)]]),
    ));
    const getOpenPorts = vi.fn(async () => []);
    setPlatform({ getOpenPorts, getOpenPortsMany } as unknown as PlatformAdapter);
    const firstWall = listing(terminalRows('a', ['surface:1']));
    handleFor(first, { handleDorControl: firstWall });
    handleFor('ws-2', { handleDorControl: listing(terminalRows('b', ['surface:1', 'surface:2'])) });

    const detail = request('surface.list', { scope: 'all', includePorts: true });
    await listAllWorkspaceSurfaces(detail);

    // One scan for the whole Window, not one per Workspace and not one per row.
    expect(getOpenPortsMany).toHaveBeenCalledTimes(1);
    expect(getOpenPortsMany).toHaveBeenCalledWith(['a-surface:1', 'b-surface:1', 'b-surface:2']);
    expect(getOpenPorts).not.toHaveBeenCalled();
    // The Walls are asked for rows only: a forwarded `includePorts` would be N
    // scans again.
    expect(firstWall.mock.calls[0][0].params).toMatchObject({ includePorts: false });
    const result = answer(detail) as { surfaces: Array<{ ports: Array<{ port: number }> }> };
    expect(result.surfaces.map((surface) => surface.ports[0].port)).toEqual([5000, 5001, 5002]);
  });

  it('fails the listing when a Workspace Wall never registers', async () => {
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    handleFor(getWorkspacesSnapshot().workspaces[0].id, { handleDorControl: listing([]) });
    // No Wall for `ws-2`: a Workspace missing from the answer would read as a
    // Workspace holding nothing, so the whole listing fails instead.
    const detail = request('surface.list', { scope: 'all' });
    await listAllWorkspaceSurfaces(detail);
    expect(answer(detail)).toBe("workspace 'workspace:2' is still mounting");
  });

  it('fails the whole listing when one Workspace cannot answer', async () => {
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    handleFor(getWorkspacesSnapshot().workspaces[0].id, { handleDorControl: listing([]) });
    handleFor('ws-2', { handleDorControl: () => { throw new Error('boom'); } });

    const detail = request('surface.list', { scope: 'all' });
    await listAllWorkspaceSurfaces(detail);
    expect(answer(detail)).toBe('workspace:2: boom');
  });
});
