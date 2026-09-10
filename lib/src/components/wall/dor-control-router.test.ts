/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDorControlRouter, resolveDorControlRoute } from './dor-control-router';
import { registerWallHandle, resetWallHandles, type WallHandle } from './wall-handles';
import type { DorControlRequest } from './use-dor-control';
import { createWorkspace, getWorkspacesSnapshot, resetWorkspaces, setActiveWorkspace } from '../../lib/workspace-store';

const disposers: Array<() => void> = [];

function handleFor(workspaceId: string, ownedSurfaceIds: string[] = []): WallHandle & { handleDorControl: ReturnType<typeof vi.fn> } {
  const handle = {
    workspaceId,
    surfaceIds: () => [...ownedSurfaceIds],
    ownsSurface: (id: string) => ownedSurfaceIds.includes(id),
    hasTouchedSurfaces: () => false,
    runningCount: () => 0,
    serialize: async () => ({ version: 3 as const, panes: [], doors: [] }),
    flushPersistence: async () => {},
    focusSelected: () => {},
    closeAll: async () => null,
    handleDorControl: vi.fn(),
  };
  disposers.push(registerWallHandle(handle));
  return handle;
}

function request(overrides: Partial<DorControlRequest> = {}): DorControlRequest & { respond: ReturnType<typeof vi.fn> } {
  return {
    requestId: 'r1',
    method: 'surface.list',
    respond: vi.fn(),
    ...overrides,
  } as DorControlRequest & { respond: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  resetWallHandles();
  resetWorkspaces();
});

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
});

describe('dor control routing', () => {
  it('delivers to the Wall that owns the caller, not the active one', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    const second = createWorkspace({ id: 'ws-2' }).id; // becomes active
    const owner = handleFor(first, ['pane-a']);
    handleFor(second, ['pane-b']);
    expect(resolveDorControlRoute(request({ surfaceId: 'pane-a' }))).toEqual({ kind: 'handle', handle: owner });
  });

  it('falls back to the active Workspace for an unknown caller', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    const second = createWorkspace({ id: 'ws-2' }).id;
    handleFor(first);
    const active = handleFor(second);
    expect(resolveDorControlRoute(request({ surfaceId: 'gone' }))).toEqual({ kind: 'handle', handle: active });
    expect(resolveDorControlRoute(request())).toEqual({ kind: 'handle', handle: active });
    setActiveWorkspace(first);
    expect(resolveDorControlRoute(request()).kind).toBe('handle');
    expect((resolveDorControlRoute(request()) as { handle: WallHandle }).handle.workspaceId).toBe(first);
  });

  it('routes an explicit workspace target positionally, over the caller', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2' });
    const target = handleFor('ws-2');
    handleFor(first, ['pane-a']);
    for (const value of ['workspace:2', '2']) {
      expect(resolveDorControlRoute(request({ surfaceId: 'pane-a', params: { workspace: value } })))
        .toEqual({ kind: 'handle', handle: target });
    }
  });

  it('errors on a workspace or window target this Window does not have', () => {
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    expect(resolveDorControlRoute(request({ params: { workspace: 'workspace:9' } })))
      .toEqual({ kind: 'error', message: "unknown workspace target 'workspace:9'" });
    expect(resolveDorControlRoute(request({ params: { window: 'window:2' } })))
      .toEqual({ kind: 'error', message: "unknown window target 'window:2'" });
    // The only Window this build addresses still resolves, in both spellings.
    expect(resolveDorControlRoute(request({ params: { window: 'window:1' } })).kind).toBe('handle');
    expect(resolveDorControlRoute(request({ params: { window: '1' } })).kind).toBe('handle');
  });

  it('does nothing when no Wall is mounted', () => {
    expect(resolveDorControlRoute(request())).toEqual({ kind: 'none' });
  });

  it('shares one window listener across every Wall that holds it', () => {
    const handle = handleFor(getWorkspacesSnapshot().workspaces[0].id);
    const releaseA = installDorControlRouter();
    const releaseB = installDorControlRouter();
    const detail = request();
    const dispatch = () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));

    dispatch();
    expect(handle.handleDorControl).toHaveBeenCalledTimes(1);

    // One release of two leaves the listener installed; the second removes it.
    releaseA();
    releaseA(); // idempotent — must not double-decrement
    dispatch();
    expect(handle.handleDorControl).toHaveBeenCalledTimes(2);
    releaseB();
    dispatch();
    expect(handle.handleDorControl).toHaveBeenCalledTimes(2);
  });

  it('answers a bad container target instead of handing it to a Wall', () => {
    const handle = handleFor(getWorkspacesSnapshot().workspaces[0].id);
    const release = installDorControlRouter();
    const detail = request({ params: { workspace: 'workspace:9' } });
    window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
    expect(handle.handleDorControl).not.toHaveBeenCalled();
    expect(detail.respond).toHaveBeenCalledWith({ ok: false, error: "unknown workspace target 'workspace:9'" });
    release();
  });
});
