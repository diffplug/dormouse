/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { handlePaneNavigation } from './handle-pane-navigation';
import { handlePaneShortcuts } from './handle-pane-shortcuts';
import type { WallKeyboardCtx } from './types';

function context(): WallKeyboardCtx {
  return {
    workspaceId: 'ws-a',
    nav: { findInDirection: vi.fn(() => null), hasPane: () => true, panes: () => ['pane-a', 'pane-b'] },
    selectedIdRef: { current: 'pane-b' },
    selectedTypeRef: { current: 'pane' },
    doorsRef: { current: [{ id: 'door-a' }] },
    selectPane: vi.fn(), selectDoor: vi.fn(),
  } as unknown as WallKeyboardCtx;
}

describe('workspace row navigation', () => {
  it('keeps Up at a top-edge pane out of the Workspace strip', () => {
    const ctx = context();
    handlePaneNavigation(new KeyboardEvent('keydown', { key: 'ArrowUp' }), ctx, { current: null });
    expect(ctx.selectedTypeRef.current).toBe('pane');
    expect(ctx.selectPane).not.toHaveBeenCalled();
    expect(ctx.selectDoor).not.toHaveBeenCalled();
  });

  it('does not navigate a Workspace tab selection with arrows', () => {
    const ctx = context();
    ctx.selectedTypeRef.current = 'workspace';
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      handlePaneNavigation(new KeyboardEvent('keydown', { key }), ctx, { current: null });
    }
    expect(ctx.selectPane).not.toHaveBeenCalled();
    expect(ctx.selectDoor).not.toHaveBeenCalled();
  });

  it('prefers a pane above', () => {
    const ctx = context();
    vi.mocked(ctx.nav.findInDirection).mockReturnValue('pane-a');
    handlePaneNavigation(new KeyboardEvent('keydown', { key: 'ArrowUp' }), ctx, { current: null });
    expect(ctx.selectPane).toHaveBeenCalledWith('pane-a');
  });

  it('does not dispatch pane actions against a Workspace tab selection', () => {
    const ctx = context();
    ctx.selectedTypeRef.current = 'workspace';
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
