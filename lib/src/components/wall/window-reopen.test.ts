import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, resetWorkspaces, getWorkspacesSnapshot, setWorkspacePinned } from '../../lib/workspace-store';
import type { PersistedSession } from '../../lib/session-types';
import { registerWallHandle, resetWallHandles, stubWallHandle } from './wall-handles';
import { windowNeedsCloseConfirmation, windowReopenSnapshot } from './window-reopen';
import { resetSurfaceIdPool } from '../../lib/surface-ids';
import { _resetPendingKillsForTesting, addPendingKill } from '../../lib/pending-kills';
import { applyTerminalSemanticEvents, removeTerminalPaneState } from '../../lib/terminal-state-store';

const session = (id: string): PersistedSession => ({
  version: 3,
  panes: [{ id, cwd: '/repo', title: 'shell', untouched: true }],
  surfaceRefs: { [id]: 'surface:1' },
  surfaceRefsNext: 2,
});

beforeEach(() => {
  resetWorkspaces();
  resetWallHandles();
  resetSurfaceIdPool();
});

afterEach(() => {
  resetWallHandles();
  resetWorkspaces();
});

describe('closing one window of several', () => {
  function twoWorkspaces(confirming: string | null): { first: string } {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    createWorkspace({ id: 'ws-2', name: 'docs', activate: true });
    for (const id of [first, 'ws-2']) {
      registerWallHandle(stubWallHandle(id, {
        needsCloseConfirmation: () => id === confirming,
        serializeReported: () => session(`pane-${id}`),
      }));
    }
    return { first };
  }

  it('asks when a Workspace\'s Wall has not mounted to say what it holds', () => {
    createWorkspace({ id: 'ws-2', name: 'docs', activate: false });
    registerWallHandle(stubWallHandle(getWorkspacesSnapshot().workspaces[0].id, { needsCloseConfirmation: () => false }));
    expect(windowNeedsCloseConfirmation()).toBe(true);
  });

  it('asks when a pending kill still runs a command', () => {
    twoWorkspaces(null);
    addPendingKill({ kind: 'surface', id: 'gone', workspaceId: 'ws-2', title: 'build', label: 'Terminal' }, { restore: () => {}, finalize: () => {} });
    try {
      expect(windowNeedsCloseConfirmation()).toBe(false);
      applyTerminalSemanticEvents('gone', [{ type: 'commandStart' }]);
      expect(windowNeedsCloseConfirmation()).toBe(true);
    } finally {
      _resetPendingKillsForTesting();
      removeTerminalPaneState('gone');
    }
  });

  it('asks, and leaves no record, when any Workspace would ask', () => {
    twoWorkspaces('ws-2');
    expect(windowNeedsCloseConfirmation()).toBe(true);
    expect(windowReopenSnapshot()).toBeNull();
  });

  it('records every Workspace in strip order with fresh ids, its active one still active', () => {
    const { first } = twoWorkspaces(null);
    expect(windowNeedsCloseConfirmation()).toBe(false);
    const snapshot = windowReopenSnapshot()!;
    expect(snapshot.workspaces.map(workspace => workspace.name)).toEqual([getWorkspacesSnapshot().workspaces[0].name, 'docs']);
    const ids = snapshot.workspaces.map(workspace => workspace.id);
    expect(ids).not.toContain(first);
    expect(ids).not.toContain('ws-2');
    expect(snapshot.activeWorkspaceId).toBe(ids[1]);
    const [pane] = snapshot.workspaces[1].session.panes;
    expect(pane).toMatchObject({ cwd: '/repo', title: 'shell', untouched: true });
    // Minted as any new Surface is, in strip order.
    expect(snapshot.workspaces.map(workspace => workspace.session.panes[0].id)).toEqual(['surface-1', 'surface-2']);
    expect(snapshot.workspaces[1].session.surfaceRefs).toBeUndefined();
  });

  it('keeps a pin, which a reopened window restores', () => {
    twoWorkspaces(null);
    setWorkspacePinned('ws-2', true);
    const snapshot = windowReopenSnapshot()!;
    expect(snapshot.workspaces.map(workspace => workspace.pinned)).toEqual([undefined, true]);
    expect(snapshot.workspaces[0]).not.toHaveProperty('pinned');
  });
});
