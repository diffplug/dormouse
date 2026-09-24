/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWorkspaceShortcuts } from './handle-workspace-shortcuts';
import { registerWallHandle, resetWallHandles, stubWallHandle } from '../wall-handles';
import { getWorkspaceUiSnapshot, resetWorkspaceUi } from '../../../lib/workspace-ui-store';
import {
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  resetWorkspaces,
  setActiveWorkspace,
} from '../../../lib/workspace-store';
import type { WallKeyboardCtx } from './types';

const KEYS = ['n', 'p', '&', '$', '1', '5', '9'];

function ctxWith(workspaceId?: string): WallKeyboardCtx {
  return { activeRef: { current: true }, selectedTypeRef: { current: 'pane' }, workspaceId } as unknown as WallKeyboardCtx;
}

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, ...init });
}

function ids(): string[] {
  return getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id);
}

let ctx: WallKeyboardCtx;

beforeEach(() => {
  resetWorkspaces();
  resetWorkspaceUi();
  resetWallHandles();
  ctx = ctxWith(getActiveWorkspaceId());
});

describe('handleWorkspaceShortcuts', () => {
  it('leaves every key unbound on a Wall with no Workspace — the bare-Wall guard', () => {
    const bare = ctxWith();
    for (const key of KEYS) {
      const event = keydown(key);
      expect(handleWorkspaceShortcuts(event, bare)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(ids()).toHaveLength(1);
  });

  it('never creates a Workspace from a bare `c`', () => {
    const event = keydown('c');
    expect(handleWorkspaceShortcuts(event, ctx)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(ids()).toHaveLength(1);
  });

  it('cycles and selects by position through the store', () => {
    const first = getActiveWorkspaceId();
    const second = createWorkspace().id;
    expect(getActiveWorkspaceId()).toBe(second);

    handleWorkspaceShortcuts(keydown('n'), ctx); // wraps at the end
    expect(getActiveWorkspaceId()).toBe(first);
    handleWorkspaceShortcuts(keydown('p'), ctx); // and at the start
    expect(getActiveWorkspaceId()).toBe(second);

    handleWorkspaceShortcuts(keydown('1'), ctx);
    expect(getActiveWorkspaceId()).toBe(first);
    // Out of range is a consumed no-op rather than a wrap.
    expect(handleWorkspaceShortcuts(keydown('9'), ctx)).toBe(true);
    expect(getActiveWorkspaceId()).toBe(first);
  });

  it('opens the strip rename editor and close flow on the ACTIVE Workspace', async () => {
    vi.useFakeTimers();
    try {
      const [first] = ids();
      createWorkspace({ id: 'ws-2' });
      handleWorkspaceShortcuts(keydown('$'), ctx);
      expect(getWorkspaceUiSnapshot().renamingId).toBe('ws-2');

      // No Wall has registered yet — `&` right after creating — so the close waits
      // for it rather than being refused unseen; nothing in the Wall is
      // touched, so it then goes straight through. Closing the final Workspace
      // replaces it with a fresh identity.
      handleWorkspaceShortcuts(keydown('&'), ctx);
      expect(ids()).toEqual([first, 'ws-2']);
      registerWallHandle(stubWallHandle(first));
      registerWallHandle(stubWallHandle('ws-2'));
      await vi.advanceTimersByTimeAsync(0);
      expect(ids()).toEqual([first]);
      handleWorkspaceShortcuts(keydown('&'), ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(ids()).toHaveLength(1);
      expect(ids()).not.toContain(first);
      expect(getActiveWorkspaceId()).toBe(ids()[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('activates a highlighted tab whose Wall is still registering, then selects it', async () => {
    vi.useFakeTimers();
    try {
      const first = getActiveWorkspaceId();
      createWorkspace({ id: 'ws-2', activate: false });
      createWorkspace({ id: 'ws-3', activate: false });
      const selected: string[] = [];
      const onTab = (id: string) => ({ ...ctx, selectedTypeRef: { current: 'workspace' }, selectedIdRef: { current: id } }) as unknown as WallKeyboardCtx;

      const enter = keydown('Enter');
      expect(handleWorkspaceShortcuts(enter, onTab('ws-2'))).toBe(true);
      expect(enter.defaultPrevented).toBe(true);
      // Activation does not wait on the Wall, as a click does not.
      expect(getActiveWorkspaceId()).toBe('ws-2');
      registerWallHandle(stubWallHandle('ws-2', { selectWorkspaceTab: () => { selected.push('ws-2'); } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(selected).toEqual(['ws-2']);

      // A user who moves on before the Wall registers is not pulled back.
      handleWorkspaceShortcuts(keydown('Enter'), onTab('ws-3'));
      expect(getActiveWorkspaceId()).toBe('ws-3');
      setActiveWorkspace(first);
      registerWallHandle(stubWallHandle('ws-3', { selectWorkspaceTab: () => { selected.push('ws-3'); } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveWorkspaceId()).toBe(first);
      expect(selected).toEqual(['ws-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims the key it handles and leaves every other one alone', () => {
    const handled = keydown('n');
    handleWorkspaceShortcuts(handled, ctx);
    expect(handled.defaultPrevented).toBe(true);

    for (const key of ['0', 'c', 'x', 'k', ',', 'z', 'Enter', '|']) {
      expect(handleWorkspaceShortcuts(keydown(key), ctx)).toBe(false);
    }
  });

  it('ignores a modified key, so a host or clipboard chord passes through', () => {
    const before = getActiveWorkspaceId();
    createWorkspace({ activate: false });
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(handleWorkspaceShortcuts(keydown('n', init), ctx)).toBe(false);
    }
    expect(getActiveWorkspaceId()).toBe(before);
  });
});
