import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWorkspaceAutoNaming, type GitInfoQuery } from './workspace-autoname-controller';
import { removeTerminalPaneState, resetTerminalPaneState } from './terminal-state-store';
import type { CwdState, TerminalPaneState } from './terminal-state';
import { createWorkspace, getWorkspace, renameWorkspace, resetWorkspaces } from './workspace-store';
import { resetWorkspaceSurfaces, setWorkspaceSurfaces } from './workspace-surfaces';
import { DEFAULT_WORKSPACE_ID } from './session-types';

function cwd(path: string, isRemote = false): CwdState {
  return { path, pathKind: 'posix', isRemote, source: 'osc633', updatedAt: 0 };
}

function pane(id: string, path: string, extra: Partial<TerminalPaneState> = {}): void {
  resetTerminalPaneState(id, { cwd: cwd(path), ...extra });
}

const name = () => getWorkspace(DEFAULT_WORKSPACE_ID)!.name;
const settle = () => vi.advanceTimersByTimeAsync(200);

describe('installWorkspaceAutoNaming', () => {
  let dispose: () => void = () => {};
  const paneIds = ['p1', 'p2', 'p3'];

  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkspaces();
    resetWorkspaceSurfaces();
  });

  afterEach(() => {
    dispose();
    for (const id of paneIds) removeTerminalPaneState(id);
    vi.useRealTimers();
  });

  it('names by directory on a host with no git lookup', async () => {
    pane('p1', '/tmp');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    dispose = installWorkspaceAutoNaming(undefined);
    await settle();
    expect(name()).toBe('tmp');
  });

  it('holds the current name until git answers, then names by repository', async () => {
    let answer!: (value: Record<string, { repo: string; branch: string } | null>) => void;
    const gitInfo = vi.fn<GitInfoQuery>(() => new Promise((resolve) => { answer = resolve; }));
    pane('p1', '/p/dormouse');
    pane('p2', '/tmp');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1', 'p2']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle();
    expect(name()).toBe('Workspace 1');
    expect(gitInfo).toHaveBeenCalledWith(['/p/dormouse', '/tmp']);

    answer({ '/p/dormouse': { repo: 'dormouse', branch: 'main' }, '/tmp': null });
    await settle();
    expect(name()).toBe('dormouse @ main');
  });

  it('asks again after a command finishes, since a checkout moves no cwd', async () => {
    const gitInfo = vi.fn<GitInfoQuery>()
      .mockResolvedValueOnce({ '/p/a': { repo: 'a', branch: 'main' } })
      .mockResolvedValueOnce({ '/p/a': { repo: 'a', branch: 'dev' } });
    pane('p1', '/p/a');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle();
    expect(name()).toBe('a @ main');

    pane('p1', '/p/a', {
      lastCommand: { id: 'c1', rawCommandLine: 'git switch dev', displayCommand: 'git switch dev', cwdAtStart: cwd('/p/a'), startedAt: 1, finishedAt: 2, source: 'osc633_boundaries' },
    });
    await settle();
    await settle();
    expect(name()).toBe('a @ dev');
  });

  it('holds the name for a path the host left out, then asks again after a delay', async () => {
    const gitInfo = vi.fn<GitInfoQuery>()
      .mockResolvedValueOnce({ '/p/a': { repo: 'a', branch: 'main' } })
      .mockResolvedValueOnce({ '/p/b': { repo: 'b', branch: 'main' } });
    pane('p1', '/p/a');
    pane('p2', '/p/b');
    pane('p3', '/p/b');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1', 'p2', 'p3']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle();
    await settle();
    expect(name()).toBe('Workspace 1');
    expect(gitInfo).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(gitInfo).toHaveBeenNthCalledWith(2, ['/p/b']);
    expect(name()).toBe('b @ main');
  });

  it('holds the name through a rejected lookup, then asks again after a delay', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gitInfo = vi.fn<GitInfoQuery>()
      .mockRejectedValueOnce(new Error('sidecar timed out'))
      .mockResolvedValueOnce({ '/p/a': { repo: 'a', branch: 'main' } });
    pane('p1', '/p/a');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle();
    await settle();
    expect(name()).toBe('Workspace 1');
    expect(gitInfo).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(gitInfo).toHaveBeenCalledTimes(2);
    expect(name()).toBe('a @ main');
  });

  it('keeps the last answer when a refresh goes unanswered', async () => {
    const gitInfo = vi.fn<GitInfoQuery>()
      .mockResolvedValueOnce({ '/p/a': { repo: 'a', branch: 'main' } })
      .mockResolvedValue({});
    pane('p1', '/p/a');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle();
    expect(name()).toBe('a @ main');

    pane('p1', '/p/a', {
      lastCommand: { id: 'c1', rawCommandLine: 'ls', displayCommand: 'ls', cwdAtStart: cwd('/p/a'), startedAt: 1, finishedAt: 2, source: 'osc633_boundaries' },
    });
    await settle();
    await settle();
    expect(gitInfo).toHaveBeenCalledTimes(2);
    expect(name()).toBe('a @ main');
  });

  it('backs off a path that never answers, doubling the delay', async () => {
    const gitInfo = vi.fn<GitInfoQuery>(async () => ({})); // a hung mount: always past the deadline
    pane('p1', '/p/a');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle();
    // Asked at ~0.1 s, then ~1 s, ~2 s, ~4 s and ~8 s after each miss.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(gitInfo.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(gitInfo.mock.calls.length).toBeLessThanOrEqual(5);
    expect(name()).toBe('Workspace 1');
  });

  it('retries every missed wave at its own deadline, not only the first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gitInfo = vi.fn<GitInfoQuery>()
      .mockRejectedValueOnce(new Error('cold sidecar'))
      .mockRejectedValueOnce(new Error('cold sidecar'))
      .mockResolvedValueOnce({ '/p/a': { repo: 'a', branch: 'main' } })
      .mockResolvedValueOnce({ '/p/b': { repo: 'b', branch: 'main' } });
    const other = createWorkspace({ id: 'ws-2', activate: false });
    pane('p1', '/p/a');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle(); // wave A misses
    await vi.advanceTimersByTimeAsync(400);
    pane('p2', '/p/b');
    setWorkspaceSurfaces(other.id, ['p2']);
    await settle(); // wave B misses later, with a later deadline
    expect(gitInfo).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(gitInfo).toHaveBeenCalledTimes(4);
    expect(name()).toBe('a @ main');
    expect(getWorkspace('ws-2')!.name).toBe('b @ main');
  });

  // An invariant, not a pin on one line: whichever path would arm a timer,
  // a lookup settling after dispose must not leave one running.
  it('no timer survives dispose, even when a lookup settles late', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reject!: (error: Error) => void;
    const gitInfo = vi.fn<GitInfoQuery>(() => new Promise((_, fail) => { reject = fail; }));
    pane('p1', '/p/a');
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle();
    dispose();
    reject(new Error('late'));
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never asks git about a remote cwd', async () => {
    const gitInfo = vi.fn<GitInfoQuery>(async () => ({}));
    resetTerminalPaneState('p1', { cwd: { ...cwd('/srv/app', true), host: 'prod-box', scheme: 'file' } });
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    dispose = installWorkspaceAutoNaming(gitInfo);
    await settle();
    expect(gitInfo).not.toHaveBeenCalled();
    expect(name()).toBe('prod-box:app');
  });

  it('leaves a user-named Workspace alone, and names only its own members', async () => {
    pane('p1', '/tmp');
    pane('p2', '/var');
    const other = createWorkspace({ id: 'ws-2', activate: false });
    setWorkspaceSurfaces(DEFAULT_WORKSPACE_ID, ['p1']);
    setWorkspaceSurfaces(other.id, ['p2']);
    renameWorkspace(DEFAULT_WORKSPACE_ID, 'mine');
    dispose = installWorkspaceAutoNaming(undefined);
    await settle();
    expect(name()).toBe('mine');
    expect(getWorkspace('ws-2')!.name).toBe('var');
  });
});
