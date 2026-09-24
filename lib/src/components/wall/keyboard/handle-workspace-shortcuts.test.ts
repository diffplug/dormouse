/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWorkspaceShortcuts } from './handle-workspace-shortcuts';
import { getWorkspaceUiSnapshot, resetWorkspaceUi } from '../../../lib/workspace-ui-store';
import {
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  resetWorkspaces,
} from '../../../lib/workspace-store';
import type { WallKeyboardCtx } from './types';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

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

  it.each(['pane', 'workspace', 'workspace-new'] as const)('leaves removed Workspace keys inert with a %s selection', kind => {
    createWorkspace({ id: 'ws-2', activate: false });
    ctx.selectedTypeRef.current = kind;
    ctx.selectedIdRef = { current: 'ws-2' };
    const before = getWorkspacesSnapshot();
    for (const key of ['c', 'n', 'p', '&', '$', 'x', 'Enter']) {
      const event = keydown(key);
      expect(handleWorkspaceShortcuts(event, ctx)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(getWorkspacesSnapshot()).toBe(before);
    expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
    expect(getWorkspaceUiSnapshot().pendingClose).toBeNull();
  });

  it('selects each position 1–9 through the store', () => {
    for (let i = 2; i <= 9; i++) createWorkspace({ id: `ws-${i}` });
    const ordered = ids();
    for (const key of KEYS) {
      const event = keydown(key);
      const stop = vi.spyOn(event, 'stopPropagation');
      expect(handleWorkspaceShortcuts(event, ctx)).toBe(true);
      expect(getActiveWorkspaceId()).toBe(ordered[Number(key) - 1]);
      expect(event.defaultPrevented).toBe(true);
      expect(stop).toHaveBeenCalledOnce();
    }
  });

  it('consumes an out-of-range position without switching', () => {
    const first = getActiveWorkspaceId();
    expect(handleWorkspaceShortcuts(keydown('9'), ctx)).toBe(true);
    expect(getActiveWorkspaceId()).toBe(first);
  });

  it('claims the key it handles and leaves every other one alone', () => {
    const handled = keydown('1');
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
      expect(handleWorkspaceShortcuts(keydown('2', init), ctx)).toBe(false);
    }
    expect(getActiveWorkspaceId()).toBe(before);
  });
});
