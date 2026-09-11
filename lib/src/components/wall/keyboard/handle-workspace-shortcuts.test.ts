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
} from '../../../lib/workspace-store';
import type { WallKeyboardCtx } from './types';

const KEYS = ['c', 'n', 'p', '&', '$', '1', '5', '9'];

function ctxWith(workspaceId?: string): WallKeyboardCtx {
  return { activeRef: { current: true }, workspaceId } as unknown as WallKeyboardCtx;
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

  it('creates, cycles, and selects by position through the store', () => {
    const first = getActiveWorkspaceId();
    expect(handleWorkspaceShortcuts(keydown('c'), ctx)).toBe(true);
    expect(ids()).toHaveLength(2);
    const second = ids()[1];
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

      // No Wall has registered yet — `&` right after `c` — so the close waits
      // for it rather than being refused unseen; nothing in the Wall is
      // touched, so it then goes straight through — but the last Workspace
      // still cannot be closed.
      handleWorkspaceShortcuts(keydown('&'), ctx);
      expect(ids()).toEqual([first, 'ws-2']);
      registerWallHandle(stubWallHandle(first));
      registerWallHandle(stubWallHandle('ws-2'));
      await vi.advanceTimersByTimeAsync(0);
      expect(ids()).toEqual([first]);
      handleWorkspaceShortcuts(keydown('&'), ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(ids()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims the key it handles and leaves every other one alone', () => {
    const handled = keydown('c');
    handleWorkspaceShortcuts(handled, ctx);
    expect(handled.defaultPrevented).toBe(true);

    for (const key of ['0', 'x', 'k', ',', 'z', 'Enter', '|']) {
      expect(handleWorkspaceShortcuts(keydown(key), ctx)).toBe(false);
    }
  });

  it('ignores a modified key, so Cmd+C stays a clipboard chord', () => {
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(handleWorkspaceShortcuts(keydown('c', init), ctx)).toBe(false);
    }
    expect(ids()).toHaveLength(1);
  });
});
