import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, installWorkspaceIdPool, resetWorkspaceIdPool, resetWorkspaces, getWorkspacesSnapshot, setWorkspacePinned } from '../../lib/workspace-store';
import type { PersistedSession, PersistedWindow } from '../../lib/session-types';
import { registerWallHandle, resetWallHandles, stubWallHandle } from './wall-handles';
import { windowNeedsCloseConfirmation, windowReopenSnapshot, withFreshWindowIds } from './window-reopen';
import { installSurfaceIdPool, resetSurfaceIdPool } from '../../lib/surface-ids';
import { _resetPendingKillsForTesting, addPendingKill } from '../../lib/pending-kills';
import { applyTerminalSemanticEvents, removeTerminalPaneState } from '../../lib/terminal-state-store';

const session = (id: string): PersistedSession => ({
  version: 4,
  panes: [{ id, cwd: '/repo', title: 'shell', untouched: true }],
});

beforeEach(() => {
  resetWorkspaces();
  resetWallHandles();
  resetSurfaceIdPool();
  resetWorkspaceIdPool();
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

  it('asks, and leaves no record, when any Workspace would ask', async () => {
    twoWorkspaces('ws-2');
    expect(windowNeedsCloseConfirmation()).toBe(true);
    expect(windowReopenSnapshot()).toBeNull();
  });

  it('records every Workspace in strip order under its own ids, marked for Reopen, reserving none', async () => {
    const reserveSurfaces = vi.fn(async (count: number) => Array.from({ length: count }, (_, i) => `surface-${100 + i}`));
    const reserveWorkspaces = vi.fn(async (count: number) => Array.from({ length: count }, (_, i) => `workspace-${100 + i}`));
    await installSurfaceIdPool(reserveSurfaces, 0);
    await installWorkspaceIdPool(reserveWorkspaces);
    reserveSurfaces.mockClear();
    reserveWorkspaces.mockClear();
    const { first } = twoWorkspaces(null);
    expect(windowNeedsCloseConfirmation()).toBe(false);
    const snapshot = windowReopenSnapshot()!;
    // The close waits on no host round trip.
    expect(reserveSurfaces).not.toHaveBeenCalled();
    expect(reserveWorkspaces).not.toHaveBeenCalled();
    expect(snapshot.reopened).toBe(true);
    expect(snapshot.workspaces.map(workspace => [workspace.id, workspace.name])).toEqual([[first, getWorkspacesSnapshot().workspaces[0].name], ['ws-2', 'docs']]);
    expect(snapshot.activeWorkspaceId).toBe('ws-2');
    expect(snapshot.workspaces[1].session.panes[0]).toMatchObject({ id: 'pane-ws-2', cwd: '/repo', title: 'shell', untouched: true });
  });

  it('keeps a pin, which a reopened window restores', async () => {
    twoWorkspaces(null);
    setWorkspacePinned('ws-2', true);
    const snapshot = windowReopenSnapshot()!;
    expect(snapshot.workspaces.map(workspace => workspace.pinned)).toEqual([undefined, true]);
    expect(snapshot.workspaces[0]).not.toHaveProperty('pinned');
  });
});

describe('reopening a closed window', () => {
  /** A host counter, clamping a block to 64 as Rust does. */
  const counting = (prefix: string, start: number) => {
    let next = start;
    return async (count: number) => Array.from({ length: Math.min(count, 64) }, () => `${prefix}-${next++}`);
  };
  const closed = (workspaces: number, panes: number): PersistedWindow => ({
    version: 2,
    workspaces: Array.from({ length: workspaces }, (_, w) => ({
      id: `workspace-${w + 2}`,
      name: `W${w}`,
      nameIsAuto: false,
      ...(w === 0 ? { pinned: true } : {}),
      session: {
        version: 4,
        panes: Array.from({ length: panes }, (_, p) => ({ id: `surface-${w * panes + p + 1}`, cwd: null, title: '', untouched: true })),
      },
    })),
    activeWorkspaceId: `workspace-${workspaces + 1}`,
    reopened: true,
  });

  it('gives every Workspace and Surface a fresh number, more than the pools hold, keeping the active one and pins', async () => {
    await installSurfaceIdPool(counting('surface', 1000), 0);
    await installWorkspaceIdPool(counting('workspace', 50));
    const saved = closed(6, 12);
    const fresh = await withFreshWindowIds(saved);
    expect(fresh).not.toHaveProperty('reopened');
    const workspaceIds = fresh.workspaces.map(workspace => workspace.id);
    expect(workspaceIds.every(id => /^workspace-\d+$/.test(id) && !saved.workspaces.some(old => old.id === id))).toBe(true);
    expect(fresh.activeWorkspaceId).toBe(workspaceIds[5]);
    expect(fresh.workspaces.map(workspace => workspace.pinned)).toEqual([true, undefined, undefined, undefined, undefined, undefined]);
    const surfaces = fresh.workspaces.flatMap(workspace => workspace.session.panes.map(pane => pane.id));
    expect(surfaces).toHaveLength(72);
    expect(new Set(surfaces).size).toBe(72);
    expect(surfaces.every(id => /^surface-\d+$/.test(id) && Number(id.slice('surface-'.length)) >= 1000)).toBe(true);
  });
});
