/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePaneNavigation } from './handle-pane-navigation';
import { handlePaneShortcuts } from './handle-pane-shortcuts';
import { setWorkspaces } from '../../../lib/workspace-store';
import type { NavHistoryRef, WallKeyboardCtx } from './types';

function context(): WallKeyboardCtx {
  const ctx = {
    workspaceId: 'ws-a',
    nav: { findInDirection: vi.fn(() => null), hasPane: () => true, panes: () => ['pane-a', 'pane-b'] },
    selectedIdRef: { current: 'pane-b' },
    selectedTypeRef: { current: 'pane' },
    doorsRef: { current: [{ id: 'door-a' }] },
    selectPane: vi.fn(), selectDoor: vi.fn(), returnToPane: vi.fn(),
  } as unknown as WallKeyboardCtx;
  ctx.selectWorkspace = vi.fn(id => {
    ctx.selectedIdRef.current = id ?? '+';
    ctx.selectedTypeRef.current = id === null ? 'workspace-new' : 'workspace';
  });
  return ctx;
}

beforeEach(() => setWorkspaces({ workspaces: [{ id: 'ws-a', name: 'App' }, { id: 'ws-b', name: 'Build' }], activeId: 'ws-a' }));

describe('workspace row navigation', () => {
  it('keeps Up at a top-edge pane out of the Workspace strip', () => {
    const ctx = context();
    handlePaneNavigation(new KeyboardEvent('keydown', { key: 'ArrowUp' }), ctx, { current: null });
    expect(ctx.selectWorkspace).not.toHaveBeenCalled();
    expect(ctx.selectPane).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'workspace-new'] as const)('does not navigate a %s selection with arrows', kind => {
    const ctx = context();
    ctx.selectedTypeRef.current = kind;
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      handlePaneNavigation(new KeyboardEvent('keydown', { key }), ctx, { current: null });
    }
    expect(ctx.selectWorkspace).not.toHaveBeenCalled();
    expect(ctx.selectPane).not.toHaveBeenCalled();
    expect(ctx.returnToPane).not.toHaveBeenCalled();
  });

  it('prefers a pane above, and leaves bare-Wall navigation unchanged', () => {
    const ctx = context();
    vi.mocked(ctx.nav.findInDirection).mockReturnValue('pane-a');
    handlePaneNavigation(new KeyboardEvent('keydown', { key: 'ArrowUp' }), ctx, { current: null });
    expect(ctx.selectPane).toHaveBeenCalledWith('pane-a');
    expect(ctx.selectWorkspace).not.toHaveBeenCalled();
    ctx.workspaceId = undefined;
    vi.mocked(ctx.nav.findInDirection).mockReturnValue(null);
    handlePaneNavigation(new KeyboardEvent('keydown', { key: 'ArrowUp' }), ctx, { current: null });
    expect(ctx.selectWorkspace).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'workspace-new'] as const)('does not dispatch pane actions against a %s selection', kind => {
    const ctx = context();
    ctx.selectedTypeRef.current = kind;
    // Independent of the production filter so an omitted binding fails here.
    // Context deliberately has no pane action callbacks: none may be reached.
    for (const key of ['Enter', '|', '%', '-', '"', 'k', 'x', ',', 'm', 'd', 't', 'a', 'z', '>']) {
      const event = new KeyboardEvent('keydown', { key, cancelable: true });
      expect(handlePaneShortcuts(event, ctx, { current: null })).toBe(true);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(handlePaneShortcuts(new KeyboardEvent('keydown', { key: 'ArrowLeft' }), ctx, { current: null })).toBe(false);
  });
});
