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
  return { workspaceId, selectedTypeRef: { current: 'pane' } } as unknown as WallKeyboardCtx;
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

  it('leaves every other key alone, the removed Workspace keys included', () => {
    createWorkspace({ id: 'ws-2', activate: false });
    const before = getWorkspacesSnapshot();
    for (const key of ['0', 'c', 'n', 'p', '&', '$', 'x', 'k', ',', 'z', 'Enter', '|', '12']) {
      const event = keydown(key);
      expect(handleWorkspaceShortcuts(event, ctx)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(getWorkspacesSnapshot()).toBe(before);
    expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
    expect(getWorkspaceUiSnapshot().pendingClose).toBeNull();
  });

  it.each(['active', 'inactive'])('renames the selected %s Workspace without activating it', target => {
    const active = getActiveWorkspaceId();
    const inactive = createWorkspace({ id: 'ws-2', activate: false }).id;
    const selected = target === 'active' ? active : inactive;
    ctx.selectedTypeRef = { current: 'workspace' };
    ctx.selectedIdRef = { current: selected };
    const event = keydown(',');
    expect(handleWorkspaceShortcuts(event, ctx)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(getWorkspaceUiSnapshot().renamingId).toBe(selected);
    expect(getActiveWorkspaceId()).toBe(active);
  });

  it('leaves modified comma and comma on + unbound', () => {
    ctx.selectedTypeRef = { current: 'workspace' };
    ctx.selectedIdRef = { current: getActiveWorkspaceId() };
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(handleWorkspaceShortcuts(keydown(',', modifier), ctx)).toBe(false);
    }
    ctx.selectedTypeRef.current = 'workspace-new';
    expect(handleWorkspaceShortcuts(keydown(','), ctx)).toBe(false);
    expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
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
