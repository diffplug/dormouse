/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registry, type TerminalEntry } from '../../lib/terminal-store';
import { installDorControlRouter, resolveDorControlRoute } from './dor-control-router';
import { _resetPendingKillsForTesting, addPendingKill } from '../../lib/pending-kills';
import { registerWallHandle, resetWallHandles, stubWallHandle, type WallHandle } from './wall-handles';
import type { DorControlRequest } from './use-dor-control';
import { getPlatformOrNull, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
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

/** Delivers through the installed router, as a host request arrives. */
function dispatch<T extends DorControlRequest>(detail: T): T {
  disposers.push(installDorControlRouter());
  window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
  return detail;
}

beforeEach(() => {
  resetWallHandles();
  resetWorkspaces();
});

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  _resetPendingKillsForTesting();
});

describe('dor control routing', () => {
  it('delivers to the Wall that owns the caller, not the active one', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    const second = createWorkspace({ id: 'ws-2' }).id; // becomes active
    const owner = handleFor(first, ['pane-a']);
    handleFor(second, ['pane-b']);
    expect(resolveDorControlRoute(request({ surfaceId: 'pane-a' }))).toEqual({ kind: 'handle', handle: owner });
  });

  it('passes the actual helper id to app restart', async () => {
    const previous = getPlatformOrNull();
    const restart = vi.fn(async () => true);
    setPlatform({ requestAppRestart: restart } as unknown as PlatformAdapter);
    try {
      const detail = dispatch(request({ method: 'app.restart', surfaceId: 'helper', helperParentId: 'parent' }));
      await Promise.resolve();
      expect(restart).toHaveBeenCalledExactlyOnceWith('helper');
      expect(detail.respond).toHaveBeenCalledWith({ ok: true, result: { relaunch: true } });
    } finally { setPlatform(previous!); }
  });

  it('routes helper callers through their source, lending only its placement', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    const owner = handleFor(first, ['parent']);
    handleFor(createWorkspace({ id: 'other' }).id, ['other-pane']);
    const detail = request({ surfaceId: 'helper', helperParentId: 'parent' });
    expect(resolveDorControlRoute(detail)).toEqual({ kind: 'handle', handle: owner });
    dispatch(detail);
    expect(owner.handleDorControl).toHaveBeenCalledWith(expect.objectContaining({
      surfaceId: undefined, helperParentId: 'parent', placementSurfaceId: 'parent',
    }));
  });

  it('keeps helper origin, without a placement, when explicitly routed to another Workspace', () => {
    const target = handleFor(getWorkspacesSnapshot().workspaces[0].id, ['destination']);
    const detail = dispatch(request({ surfaceId: 'foreign-helper', helperParentId: 'foreign-parent',
      params: { workspace: 'workspace:1' } }));
    expect(target.handleDorControl).toHaveBeenCalledWith(expect.objectContaining({
      surfaceId: undefined, helperParentId: 'foreign-parent', placementSurfaceId: undefined,
    }));
    const self = dispatch(request({ ...detail, method: 'surface.kill', params: { workspace: 'workspace:1', surface: 'surface:self' } }));
    expect(self.respond).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining('not public Surface targets') });
    expect(target.handleDorControl).toHaveBeenCalledTimes(1);
  });

  it('waits for a helper source to register, then refuses rather than using the active Workspace', async () => {
    vi.useFakeTimers();
    try {
      const unrelated = handleFor(getWorkspacesSnapshot().workspaces[0].id, ['unrelated']);
      const late = dispatch(request({ surfaceId: 'helper', helperParentId: 'late' }));
      const owner = handleFor(createWorkspace({ id: 'ws-late', activate: false }).id, ['late']);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.handleDorControl).toHaveBeenCalledTimes(1);
      const gone = dispatch(request({ surfaceId: 'helper', helperParentId: 'gone' }));
      await vi.advanceTimersByTimeAsync(10);
      expect(gone.respond).toHaveBeenCalledWith({ ok: false, error: 'The helper source Surface is no longer available' });
      expect(late.respond).not.toHaveBeenCalled();
      expect(unrelated.handleDorControl).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('captures in-process helper identity from the registry without aliasing self', () => {
    const owner = handleFor(getWorkspacesSnapshot().workspaces[0].id, ['parent']);
    registry.set('surface-9', { helper: { parentId: 'parent', command: '' } } as TerminalEntry);
    try {
      dispatch(request({ surfaceId: 'surface-9' }));
      expect(owner.handleDorControl).toHaveBeenCalledWith(expect.objectContaining({
        surfaceId: undefined, helperParentId: 'parent', placementSurfaceId: 'parent',
      }));
      for (const surface of ['surface-9', 'surface:9', 'surface:self']) {
        const detail = dispatch(request({ surfaceId: 'surface-9', params: { surface } }));
        expect(detail.respond).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining('not public Surface targets') });
      }
      expect(owner.handleDorControl).toHaveBeenCalledTimes(1);
    } finally { registry.delete('surface-9'); }
  });

  it('refuses a request a pending helper makes, though it names its open parent', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    handleFor(first, ['pane-a']);
    addPendingKill(
      { kind: 'helper', id: 'helper-1', workspaceId: first, surfaceId: 'pane-a', title: 'helper', label: 'Helper' },
      { restore: () => true, finalize: () => {} },
    );
    expect(resolveDorControlRoute(request({ method: 'surface.split', surfaceId: 'helper-1', helperParentId: 'pane-a' } as Partial<DorControlRequest>)))
      .toEqual({ kind: 'error', message: "surface 'helper-1' is a pending kill" });
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

  it('routes an id or ref target to the Workspace holding it, over the caller', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2' });
    const caller = handleFor(first, ['surface-1']);
    const owner = handleFor('ws-2', ['surface-2']);
    for (const surface of ['surface-2', 'surface:2']) {
      expect(resolveDorControlRoute(request({ surfaceId: 'surface-1', params: { surface } })))
        .toEqual({ kind: 'handle', handle: owner });
    }
    // `surface:self`, a title, and a refused bare number stay with the caller.
    for (const surface of ['surface:self', 'title:surface-2', '2']) {
      expect(resolveDorControlRoute(request({ surfaceId: 'surface-1', params: { surface } })))
        .toEqual({ kind: 'handle', handle: caller });
    }
  });

  it('answers the container verbs and --all at the Window, with no Wall involved', () => {
    handleFor(getWorkspacesSnapshot().workspaces[0].id, ['pane-a']);
    for (const method of ['workspace.list', 'workspace.new', 'workspace.close']) {
      expect(resolveDorControlRoute(request({ method, surfaceId: 'pane-a' })))
        .toEqual({ kind: 'window', container: true });
    }
    expect(resolveDorControlRoute(request({ method: 'surface.list', params: { scope: 'all' } })))
      .toEqual({ kind: 'window', container: false });
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

  it('names the active Workspace as still mounting when no Wall is mounted', () => {
    expect(resolveDorControlRoute(request())).toEqual({
      kind: 'none',
      message: "workspace 'workspace:1' is still mounting",
    });
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

  it('waits out the same gap for an explicit --workspace, then says it is still mounting', async () => {
    vi.useFakeTimers();
    try {
      handleFor(getWorkspacesSnapshot().workspaces[0].id, ['pane-a']);
      const release = installDorControlRouter();

      // `dor workspace new build && dor split --workspace build`: the Workspace
      // is in the store, its Wall is one effect away.
      createWorkspace({ id: 'ws-2', name: 'build', activate: false });
      const detail = request({ surfaceId: 'pane-a', params: { workspace: 'build' } });
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
      expect(detail.respond).not.toHaveBeenCalled();
      const target = handleFor('ws-2');
      await vi.advanceTimersByTimeAsync(0);
      expect(target.handleDorControl).toHaveBeenCalledTimes(1);
      expect(detail.respond).not.toHaveBeenCalled();

      // One that never registers is answered — not left as "no such Workspace",
      // which it is not, and not left unanswered, which blocks the caller.
      createWorkspace({ id: 'ws-3', name: 'agents', activate: false });
      const never = request({ params: { workspace: 'agents' } });
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: never }));
      await vi.advanceTimersByTimeAsync(10);
      expect(never.respond).toHaveBeenCalledWith({ ok: false, error: "workspace 'agents' is still mounting" });
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after a bounded number of retries when nothing ever mounts, and says so', async () => {
    vi.useFakeTimers();
    try {
      const release = installDorControlRouter();
      const detail = request();
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
      expect(detail.respond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      // Answered promptly, not left to the client's own deadline: `dor agent-browser`
      // makes this round trip on every managed invocation and must fail fast.
      expect(detail.respond).toHaveBeenCalledTimes(1);
      expect(detail.respond).toHaveBeenCalledWith({ ok: false, error: "workspace 'workspace:1' is still mounting" });
      // The retry chain is finite: registering afterwards is too late.
      const handle = handleFor(getWorkspacesSnapshot().workspaces[0].id);
      await vi.advanceTimersByTimeAsync(10);
      expect(handle.handleDorControl).not.toHaveBeenCalled();
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a caller the answering Wall does not hold', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2', name: 'build' });
    handleFor(first, ['pane-a']);
    const target = handleFor('ws-2', ['pane-b']);
    const release = installDorControlRouter();

    // `dor split --workspace build` from pane-a: the caller belongs to another
    // Workspace, so the answering Wall is handed no caller and falls back to
    // its own focused Surface.
    const foreign = request({ surfaceId: 'pane-a', params: { workspace: 'build' } });
    window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: foreign }));
    expect(target.handleDorControl).toHaveBeenCalledWith({ ...foreign, surfaceId: undefined });

    // A caller its own Wall holds arrives untouched.
    const own = request({ surfaceId: 'pane-b' });
    window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: own }));
    expect(target.handleDorControl).toHaveBeenLastCalledWith(own);
    release();
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

describe('dor tool reads', () => {
  const previous = getPlatformOrNull();
  afterEach(() => setPlatform(previous as PlatformAdapter));

  it('answers at the Window before resolving any Workspace or Surface', () => {
    const handle = handleFor(getWorkspacesSnapshot().workspaces[0].id, ['pane-a']);
    for (const params of [{}, { workspace: 'workspace:9' }, { surface: 'pane-a' }]) {
      expect(resolveDorControlRoute(request({ method: 'tool.list', surfaceId: 'pane-a', params: params as never })))
        .toEqual({ kind: 'tool' });
    }
    expect(handle.handleDorControl).not.toHaveBeenCalled();
  });

  it('relays the host listing, its error, and a missing cwd', async () => {
    const listing = { project: null, user: { path: '/config/dormouse.yml', found: true }, tools: [], warnings: [] };
    const adapter = {
      async toolControl(this: unknown, request: { op: string; cwd: string }) {
        // Called as a method: an adapter may need `this` (VSCodeAdapter does).
        if (this !== adapter) throw new Error('toolControl called detached');
        return request.cwd === '/broken'
          ? { status: 'error' as const, message: '/broken/dormouse.yml: bad' }
          : { status: 'list' as const, listing };
      },
    };
    const toolControl = vi.spyOn(adapter, 'toolControl');
    setPlatform(adapter as unknown as PlatformAdapter);
    const release = installDorControlRouter();
    const ask = async (params: Record<string, unknown>) => {
      const detail = request({ method: 'tool.list', params: params as never });
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
      await vi.waitFor(() => expect(detail.respond).toHaveBeenCalled());
      return detail.respond.mock.calls[0][0];
    };
    expect(await ask({ cwd: '/repo', global: true })).toEqual({ ok: true, result: listing });
    expect(toolControl).toHaveBeenCalledWith({ op: 'list', cwd: '/repo', global: true });
    expect(await ask({ cwd: '/broken' })).toEqual({ ok: false, error: '/broken/dormouse.yml: bad' });
    expect(await ask({})).toEqual({ ok: false, error: 'cwd is required' });
    release();
  });

  it('relays the open handlers for one target', async () => {
    const handlers = { target: '/repo/a.md', directory: false, handlers: [], config: '/config/dormouse.yml', warnings: [] };
    const toolControl = vi.fn(async () => ({ status: 'open-handlers' as const, handlers }));
    setPlatform({ toolControl } as unknown as PlatformAdapter);
    const release = installDorControlRouter();
    const ask = async (params: Record<string, unknown>) => {
      const detail = request({ method: 'tool.openHandlers', params: params as never });
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
      await vi.waitFor(() => expect(detail.respond).toHaveBeenCalled());
      return detail.respond.mock.calls[0][0];
    };
    expect(await ask({ cwd: '/repo', target: 'a.md', preview: true })).toEqual({ ok: true, result: handlers });
    expect(toolControl).toHaveBeenCalledWith({ op: 'open-handlers', target: 'a.md', cwd: '/repo', preview: true });
    expect(await ask({ cwd: '/repo' })).toEqual({ ok: false, error: 'cwd and target are required' });
    release();
  });
});

describe('dor app verbs', () => {
  const previous = getPlatformOrNull();
  afterEach(() => setPlatform(previous as PlatformAdapter));

  function withRestart(requestAppRestart?: (requester?: string) => Promise<boolean>): void {
    setPlatform({ requestAppRestart } as unknown as PlatformAdapter);
  }

  it('answers at the Window before resolving any Workspace, Surface, or Window param', () => {
    const handle = handleFor(getWorkspacesSnapshot().workspaces[0].id, ['pane-a']);
    for (const params of [{}, { window: 1 }, { workspace: 'workspace:9' }]) {
      expect(resolveDorControlRoute(request({ method: 'app.restart', surfaceId: 'pane-a', params: params as never })))
        .toEqual({ kind: 'app' });
    }
    expect(handle.handleDorControl).not.toHaveBeenCalled();
  });

  // The caller is the requester, so its own pane never counts as running work
  // in the restart's confirmation.
  it('requests the restart for the caller first, then answers with whether it will relaunch', async () => {
    let settle!: (relaunch: boolean) => void;
    const requestAppRestart = vi.fn((_requester?: string) => new Promise<boolean>((resolve) => { settle = resolve; }));
    withRestart(requestAppRestart);
    const release = installDorControlRouter();
    const detail = request({ method: 'app.restart', surfaceId: 'pane-a' });
    window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
    expect(requestAppRestart).toHaveBeenCalledExactlyOnceWith('pane-a');
    expect(detail.respond).not.toHaveBeenCalled();

    settle(false);
    await vi.waitFor(() => expect(detail.respond).toHaveBeenCalledWith({ ok: true, result: { relaunch: false } }));
    release();
  });

  it('passes the host refusal through as the error', async () => {
    // Tauri rejects an invoke with the command's error string, not an Error.
    withRestart(() => Promise.reject('Restart needs a packaged build'));
    const release = installDorControlRouter();
    const detail = request({ method: 'app.restart' });
    window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
    await vi.waitFor(() => expect(detail.respond).toHaveBeenCalledWith({ ok: false, error: 'Restart needs a packaged build' }));
    release();
  });

  it('refuses on a host that cannot restart itself', () => {
    withRestart(undefined);
    const release = installDorControlRouter();
    const detail = request({ method: 'app.restart' });
    window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail }));
    expect(detail.respond).toHaveBeenCalledWith({
      ok: false,
      error: 'dor app restart is available only in Dormouse Standalone',
    });
    release();
  });
});
