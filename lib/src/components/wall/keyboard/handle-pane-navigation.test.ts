/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePaneNavigation } from './handle-pane-navigation';
import { handlePaneShortcuts } from './handle-pane-shortcuts';
import { getActiveWorkspaceId, setWorkspaces } from '../../../lib/workspace-store';
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
  it('moves from the top pane through tabs and + without activating, then returns to the pane', () => {
    const ctx = context();
    const history: NavHistoryRef = { current: null };
    const press = (key: string) => handlePaneNavigation(new KeyboardEvent('keydown', { key }), ctx, history);
    press('ArrowUp');
    expect(ctx.selectWorkspace).toHaveBeenLastCalledWith('ws-a');
    press('ArrowLeft');
    expect(ctx.selectedIdRef.current).toBe('ws-a');
    press('ArrowRight');
    expect(ctx.selectedIdRef.current).toBe('ws-b');
    press('ArrowRight');
    expect(ctx.selectedTypeRef.current).toBe('workspace-new');
    press('ArrowRight');
    expect(ctx.selectedTypeRef.current).toBe('workspace-new');
    press('ArrowLeft');
    expect(ctx.selectedIdRef.current).toBe('ws-b');
    expect(getActiveWorkspaceId()).toBe('ws-a');
    press('ArrowDown');
    expect(ctx.returnToPane).toHaveBeenCalledOnce();
    expect(history.current).toBeNull();
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
