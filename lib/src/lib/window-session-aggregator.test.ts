import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetWorkspaceSession,
  getWindowSnapshot,
  installWindowSessionWriter,
  publishWorkspaceSession,
  resetWindowSessionAggregator,
} from './window-session-aggregator';
import type { PersistedSession } from './session-types';
import {
  createWorkspace,
  moveWorkspace,
  resetWorkspaces,
  setActiveWorkspace,
  getWorkspacesSnapshot,
} from './workspace-store';

function session(paneId: string): PersistedSession {
  return { version: 3, panes: [{ id: paneId, title: paneId, cwd: null, untouched: true, alert: null }], doors: [] };
}

beforeEach(() => {
  resetWindowSessionAggregator();
  resetWorkspaces();
});

describe('window session aggregator', () => {
  it('orders Workspaces by the store and carries the active id', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    const second = createWorkspace({ name: 'Second' }).id;
    publishWorkspaceSession(first, session('a'));
    publishWorkspaceSession(second, session('b'));

    expect(getWindowSnapshot()).toMatchObject({
      version: 1,
      activeWorkspaceId: second,
      workspaces: [{ id: first }, { id: second, name: 'Second' }],
    });

    moveWorkspace(second, 0);
    expect(getWindowSnapshot().workspaces.map((ws) => ws.id)).toEqual([second, first]);
    setActiveWorkspace(first);
    expect(getWindowSnapshot().activeWorkspaceId).toBe(first);
  });

  it('drops a Workspace that has published nothing rather than writing it empty', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ name: 'Second' });
    publishWorkspaceSession(first, session('a'));
    expect(getWindowSnapshot().workspaces.map((ws) => ws.id)).toEqual([first]);
  });

  it('forgets a Workspace session', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    publishWorkspaceSession(first, session('a'));
    forgetWorkspaceSession(first);
    expect(getWindowSnapshot().workspaces).toEqual([]);
  });

  it('hands each snapshot to the installed writer until it is uninstalled', () => {
    const write = vi.fn();
    const uninstall = installWindowSessionWriter(write);
    const first = getWorkspacesSnapshot().workspaces[0].id;
    publishWorkspaceSession(first, session('a'));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].workspaces).toHaveLength(1);
    forgetWorkspaceSession(first);
    expect(write).toHaveBeenCalledTimes(2);
    forgetWorkspaceSession(first);
    expect(write).toHaveBeenCalledTimes(2);
    uninstall();
    publishWorkspaceSession(first, session('a'));
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('ships with no writer installed', () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    expect(() => publishWorkspaceSession(first, session('a'))).not.toThrow();
  });
});
