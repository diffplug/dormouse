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

  it('asks again for a path the host left out of its answer', async () => {
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
    expect(gitInfo).toHaveBeenNthCalledWith(2, ['/p/b']);
    expect(name()).toBe('b @ main');
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
