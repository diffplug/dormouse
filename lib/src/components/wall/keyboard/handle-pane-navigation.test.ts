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
  it('leaves Alt+Arrow to its host instead of navigating the Wall', () => {
    const ctx = context();
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, cancelable: true });
    expect(handlePaneNavigation(event, ctx, { current: null })).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(ctx.selectWorkspace).not.toHaveBeenCalled();
    expect(ctx.nav.findInDirection).not.toHaveBeenCalled();
  });

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

  it('traverses unpinned tabs, then +, then the pinned group, stopping at either end', () => {
    setWorkspaces({ workspaces: [{ id: 'ws-a', name: 'App', nameIsAuto: false }, { id: 'ws-p', name: 'Notes', nameIsAuto: false, pinned: true }, { id: 'ws-b', name: 'Build', nameIsAuto: false }], activeId: 'ws-a' });
    const ctx = context();
    const press = (key: string) => handlePaneNavigation(new KeyboardEvent('keydown', { key }), ctx, { current: null });
    press('ArrowUp');
    const seen = [ctx.selectedIdRef.current];
    for (let i = 0; i < 4; i++) { press('ArrowRight'); seen.push(ctx.selectedIdRef.current); }
    expect(seen).toEqual(['ws-a', 'ws-b', '+', 'ws-p', 'ws-p']);
    press('ArrowLeft');
    expect(ctx.selectedTypeRef.current).toBe('workspace-new');
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

describe('pane backtracking', () => {
  const press = (ctx: WallKeyboardCtx, history: NavHistoryRef, key: string) => handlePaneNavigation(new KeyboardEvent('keydown', { key }), ctx, history);
  function panes(): WallKeyboardCtx {
    const ctx = context();
    ctx.selectedIdRef.current = 'pane-a';
    vi.mocked(ctx.selectPane).mockImplementation(id => { ctx.selectedIdRef.current = id; });
    // row[a, col[b, c]]: only spatial neighbors resolve.
    vi.mocked(ctx.nav.findInDirection).mockImplementation((id, dir) => (
      id === 'pane-a' && dir === 'ArrowRight' ? 'pane-b'
        : id === 'pane-b' && dir === 'ArrowDown' ? 'pane-c'
          : (id === 'pane-b' || id === 'pane-c') && dir === 'ArrowLeft' ? 'pane-a'
            : null));
    return ctx;
  }

  it('returns to the origin pane on the opposite arrow', () => {
    const ctx = panes();
    const history: NavHistoryRef = { current: null };
    press(ctx, history, 'ArrowRight');
    press(ctx, history, 'ArrowDown');
    press(ctx, history, 'ArrowUp');
    expect(ctx.selectedIdRef.current).toBe('pane-b');
  });

  it('drops the breadcrumb once the selection moved by other means', () => {
    const ctx = panes();
    const history: NavHistoryRef = { current: null };
    press(ctx, history, 'ArrowRight');
    press(ctx, history, 'ArrowDown');
    // A click selects pane-a, which has nothing above it but the tab strip.
    ctx.selectedIdRef.current = 'pane-a';
    press(ctx, history, 'ArrowUp');
    expect(ctx.nav.findInDirection).toHaveBeenLastCalledWith('pane-a', 'ArrowUp');
    expect(ctx.selectWorkspace).toHaveBeenCalledWith('ws-a');
  });
});
