/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDorControlRouter, resolveDorControlRoute } from './dor-control-router';
import { registerWallHandle, resetWallHandles, stubWallHandle, type WallHandle } from './wall-handles';
import type { DorControlRequest } from './use-dor-control';
import {
  createWorkspace,
  currentWindowRef,
  getWorkspacesSnapshot,
  resetWorkspaces,
  setActiveWorkspace,
  setWindowLabel,
} from '../../lib/workspace-store';

const disposers: Array<() => void> = [];

function handleFor(workspaceId: string, ownedSurfaceIds: string[] = []): WallHandle & { handleDorControl: ReturnType<typeof vi.fn> } {
  const handle = stubWallHandle(workspaceId, {
    surfaceIds: () => [...ownedSurfaceIds],
    ownsSurface: (id: string) => ownedSurfaceIds.includes(id),
    handleDorControl: vi.fn(),
  }) as WallHandle & { handleDorControl: ReturnType<typeof vi.fn> };
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

  it('routes an explicit workspace target by name', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2', name: 'build' });
    const target = handleFor('ws-2');
    handleFor(first, ['pane-a']);
    for (const value of ['workspace:build', 'build']) {
      expect(resolveDorControlRoute(request({ surfaceId: 'pane-a', params: { workspace: value } })))
        .toEqual({ kind: 'handle', handle: target });
    }
    createWorkspace({ id: 'ws-3', name: 'build' });
    handleFor('ws-3');
    expect(resolveDorControlRoute(request({ params: { workspace: 'build' } })))
      .toEqual({
        kind: 'error',
        message: 'workspace target \'build\' matched multiple Workspaces: workspace:2 "build", workspace:3 "build"',
      });
  });

  it('routes a stable-id target to the Workspace holding it, over the caller', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2' });
    const caller = handleFor(first, ['pane-a']);
    const owner = handleFor('ws-2', ['pane-b']);
    for (const surface of ['pane-b', 'surface:pane-b']) {
      expect(resolveDorControlRoute(request({ surfaceId: 'pane-a', params: { surface } })))
        .toEqual({ kind: 'handle', handle: owner });
    }
    // A Workspace-scoped `surface:N`, `surface:self` and a title stay with the
    // caller: every Workspace has a `surface:1`.
    for (const surface of ['surface:1', 'surface:self', 'title:pane-b']) {
      expect(resolveDorControlRoute(request({ surfaceId: 'pane-a', params: { surface } })))
        .toEqual({ kind: 'handle', handle: caller });
    }
  });

  it('answers the container verbs and --all at the Window, with no Wall involved', () => {
    handleFor(getWorkspacesSnapshot().workspaces[0].id, ['pane-a']);
    for (const method of ['workspace.list', 'workspace.new', 'workspace.close']) {
      expect(resolveDorControlRoute(request({ method, surfaceId: 'pane-a' }))).toEqual({ kind: 'window' });
    }
    expect(resolveDorControlRoute(request({ method: 'surface.list', params: { scope: 'all' } })))
      .toEqual({ kind: 'window' });
    expect(resolveDorControlRoute(request({ method: 'surface.list', params: { scope: 'workspace' } })).kind)
      .toBe('handle');
  });

  it('errors on a workspace or window target this Window does not have', () => {
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    expect(resolveDorControlRoute(request({ params: { workspace: 'workspace:9' } })))
      .toEqual({ kind: 'error', message: "unknown workspace target 'workspace:9'" });
    expect(resolveDorControlRoute(request({ params: { window: 'window:2' } })))
      .toEqual({ kind: 'error', message: "unknown window target 'window:2'" });
    // A Window that never names itself is `window:1`, in both spellings.
    expect(resolveDorControlRoute(request({ params: { window: 'window:1' } })).kind).toBe('handle');
    expect(resolveDorControlRoute(request({ params: { window: '1' } })).kind).toBe('handle');
  });

  it('answers to the label the host gave it, and to no other Window', () => {
    // A host with several Windows names each one, so `dor list` reports a ref a
    // caller can hand straight back (docs/specs/dor-cli.md -> "Handle Model").
    handleFor(getWorkspacesSnapshot().workspaces[0].id);
    setWindowLabel('ws-3');
    expect(currentWindowRef()).toBe('window:ws-3');
    expect(resolveDorControlRoute(request({ params: { window: 'window:ws-3' } })).kind).toBe('handle');
    expect(resolveDorControlRoute(request({ params: { window: 'ws-3' } })).kind).toBe('handle');
    // Another Window's ref is not this Window's to act on — including the one
    // this Window answered to before it was named.
    expect(resolveDorControlRoute(request({ params: { window: 'window:main' } })))
      .toEqual({ kind: 'error', message: "unknown window target 'window:main'" });
    expect(resolveDorControlRoute(request({ params: { window: 'window:1' } })).kind).toBe('error');
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

  it('answers a container target of the wrong type instead of throwing out of the listener', () => {
    const handle = handleFor(getWorkspacesSnapshot().workspaces[0].id);
    const release = installDorControlRouter();
    // Whatever crossed the control socket, not a validated string: a `.trim()`
    // on it would throw past `respond` and leave the caller blocked.
    for (const [params, error] of [
      [{ workspace: 2 }, "unknown workspace target '2'"],
      [{ workspace: { ref: 'x' } }, "unknown workspace target '[object Object]'"],
      [{ window: 1 }, "unknown window target '1'"],
    ] as const) {
      const detail = request({ params: params as never });
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
      expect(detail.respond).toHaveBeenCalledWith({ ok: false, error });
    }
    expect(handle.handleDorControl).not.toHaveBeenCalled();
    release();
  });

  it('answers a handler that throws or rejects, rather than letting the caller time out', async () => {
    const workspaceId = getWorkspacesSnapshot().workspaces[0].id;
    const handle = handleFor(workspaceId);
    const release = installDorControlRouter();

    handle.handleDorControl.mockImplementationOnce(() => { throw new Error('boom'); });
    const thrown = request();
    window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: thrown }));
    expect(thrown.respond).toHaveBeenCalledWith({ ok: false, error: 'boom' });

    handle.handleDorControl.mockImplementationOnce(() => Promise.reject(new Error('late boom')));
    const rejected = request();
    window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: rejected }));
    await Promise.resolve();
    expect(rejected.respond).toHaveBeenCalledWith({ ok: false, error: 'late boom' });
    release();
  });

  it('waits out the gap between createWorkspace and the new Wall registering', async () => {
    vi.useFakeTimers();
    try {
      const release = installDorControlRouter();
      // No Wall has registered yet — the request must not be dropped.
      const detail = request();
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
      const workspaceId = createWorkspace({ id: 'ws-2' }).id;
      const handle = handleFor(workspaceId);
      expect(handle.handleDorControl).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(handle.handleDorControl).toHaveBeenCalledWith(detail);
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after a bounded number of retries when nothing ever mounts', async () => {
    vi.useFakeTimers();
    try {
      const release = installDorControlRouter();
      const detail = request();
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
      await vi.advanceTimersByTimeAsync(10);
      // The retry chain is finite: registering afterwards is too late.
      const handle = handleFor(getWorkspacesSnapshot().workspaces[0].id);
      await vi.advanceTimersByTimeAsync(10);
      expect(handle.handleDorControl).not.toHaveBeenCalled();
      release();
    } finally {
      vi.useRealTimers();
    }
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
