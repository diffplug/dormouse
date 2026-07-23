/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePaneShortcuts } from './handle-pane-shortcuts';
import type { WallKeyboardCtx } from './types';

const terminalRegistryMocks = vi.hoisted(() => ({
  dismissOrToggleAlert: vi.fn(),
  getActivity: vi.fn(() => ({ status: 'WATCHING_DISABLED' })),
  isUntouched: vi.fn(),
  toggleSessionTodo: vi.fn(),
}));

vi.mock('../../../lib/terminal-registry', () => ({
  dismissOrToggleAlert: terminalRegistryMocks.dismissOrToggleAlert,
  getActivity: terminalRegistryMocks.getActivity,
  isUntouched: terminalRegistryMocks.isUntouched,
  toggleSessionTodo: terminalRegistryMocks.toggleSessionTodo,
}));

vi.mock('../../KillConfirm', () => ({
  randomKillChar: () => 'Q',
}));

// jsdom here ships no `CSS` global; the header lookup escapes ids via CSS.escape.
globalThis.CSS ??= {
  escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
} as unknown as typeof CSS;

function makeNav(overrides: Partial<WallKeyboardCtx['nav']> = {}): WallKeyboardCtx['nav'] {
  return {
    findInDirection: () => null,
    paneParams: () => undefined,
    hasPane: () => false,
    panes: () => [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<WallKeyboardCtx> = {}): WallKeyboardCtx {
  return {
    nav: makeNav(),
    swapWithNeighbor: vi.fn(),
    modeRef: { current: 'command' },
    selectedIdRef: { current: 'pane-a' },
    selectedTypeRef: { current: 'pane' },
    doorsRef: { current: [{ id: 'pane-a', title: 'Pane A' }] },
    dialogKeyboardActiveRef: { current: false },
    wallActionsRef: {
      current: {
        onSplitH: vi.fn(),
        onSplitV: vi.fn(),
        onZoom: vi.fn(),
      },
    },
    handleReattachRef: { current: vi.fn() },
    selectPane: vi.fn(),
    enterTerminalMode: vi.fn(),
    killPaneImmediately: vi.fn(),
    setConfirmKill: vi.fn(),
    setRenamingPaneId: vi.fn(),
    fireEvent: vi.fn(),
    ...overrides,
  } as unknown as WallKeyboardCtx;
}

function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}

function keydownMeta(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
}

describe('handlePaneShortcuts kill behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalRegistryMocks.isUntouched.mockReturnValue(false);
  });

  it('kills untouched panes immediately without staging confirmation', () => {
    terminalRegistryMocks.isUntouched.mockReturnValue(true);
    const ctx = makeCtx();
    const event = keydown('x');

    expect(handlePaneShortcuts(event, ctx, { current: null })).toBe(true);

    expect(ctx.killPaneImmediately).toHaveBeenCalledWith('pane-a');
    expect(ctx.setConfirmKill).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps confirmation for touched panes', () => {
    const ctx = makeCtx();

    expect(handlePaneShortcuts(keydown('x'), ctx, { current: null })).toBe(true);

    expect(ctx.killPaneImmediately).not.toHaveBeenCalled();
    expect(ctx.setConfirmKill).toHaveBeenCalledWith({ id: 'pane-a', char: 'Q' });
  });

  it('reattaches untouched doors into an immediate kill path', () => {
    terminalRegistryMocks.isUntouched.mockReturnValue(true);
    const reattach = vi.fn();
    const ctx = makeCtx({
      selectedTypeRef: { current: 'door' },
      handleReattachRef: { current: reattach },
    });

    expect(handlePaneShortcuts(keydown('x'), ctx, { current: null })).toBe(true);

    expect(reattach).toHaveBeenCalledWith(
      { id: 'pane-a', title: 'Pane A' },
      { enterPassthrough: false, afterRestore: 'kill-immediately' },
    );
  });

  it('reattaches touched doors into the confirmation path', () => {
    const reattach = vi.fn();
    const ctx = makeCtx({
      selectedTypeRef: { current: 'door' },
      handleReattachRef: { current: reattach },
    });

    expect(handlePaneShortcuts(keydown('x'), ctx, { current: null })).toBe(true);

    expect(reattach).toHaveBeenCalledWith(
      { id: 'pane-a', title: 'Pane A' },
      { enterPassthrough: false, afterRestore: 'confirm-kill' },
    );
  });
});

describe('handlePaneShortcuts Cmd-Arrow swap (nav seam)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('swaps with the nav-resolved neighbor, fires move, and keeps selection on the moved pane', () => {
    const ctx = makeCtx({
      nav: makeNav({ findInDirection: (_id, dir) => (dir === 'ArrowRight' ? 'pane-b' : null) }),
    });
    const navHistory = { current: null };

    expect(handlePaneShortcuts(keydownMeta('ArrowRight'), ctx, navHistory)).toBe(true);

    expect(ctx.swapWithNeighbor).toHaveBeenCalledWith('pane-a', 'pane-b');
    expect(ctx.fireEvent).toHaveBeenCalledWith({ type: 'move', fromId: 'pane-a', toId: 'pane-b' });
    expect(ctx.selectPane).toHaveBeenCalledWith('pane-a');
    // Selection stayed on pane-a, so the breadcrumb must record the swap
    // partner — recording pane-a would make the backtrack a self-swap no-op.
    expect(navHistory.current).toEqual({ direction: 'ArrowRight', fromId: 'pane-b' });
  });

  it('backtracks: the opposite Cmd-Arrow swaps back with the pane now in the old slot', () => {
    const ctx = makeCtx({
      nav: makeNav({
        // Spatial nav only resolves the first swap; the backtrack must come
        // from the breadcrumb, not findInDirection.
        findInDirection: (_id, dir) => (dir === 'ArrowRight' ? 'pane-b' : null),
        hasPane: (id) => id === 'pane-b',
      }),
    });
    const navHistory = { current: null };

    expect(handlePaneShortcuts(keydownMeta('ArrowRight'), ctx, navHistory)).toBe(true);
    expect(handlePaneShortcuts(keydownMeta('ArrowLeft'), ctx, navHistory)).toBe(true);

    expect(ctx.swapWithNeighbor).toHaveBeenNthCalledWith(2, 'pane-a', 'pane-b');
    expect(ctx.fireEvent).toHaveBeenNthCalledWith(2, { type: 'move', fromId: 'pane-a', toId: 'pane-b' });
  });

  it('does nothing when nav finds no neighbor in that direction', () => {
    const ctx = makeCtx({ nav: makeNav({ findInDirection: () => null }) });

    expect(handlePaneShortcuts(keydownMeta('ArrowLeft'), ctx, { current: null })).toBe(true);

    expect(ctx.swapWithNeighbor).not.toHaveBeenCalled();
    expect(ctx.selectPane).not.toHaveBeenCalled();
  });
});

describe('handlePaneShortcuts `>` header context menu', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { document.body.innerHTML = ''; });

  function makeHeaderEl(id: string): ReturnType<typeof vi.fn> {
    const el = document.createElement('div');
    el.setAttribute('data-pane-header-for', id);
    document.body.appendChild(el);
    const onContextMenu = vi.fn();
    el.addEventListener('contextmenu', onContextMenu);
    return onContextMenu;
  }

  it('dispatches contextmenu on the selected pane header element', () => {
    const onContextMenu = makeHeaderEl('pane-a');

    expect(handlePaneShortcuts(keydown('>'), makeCtx(), { current: null })).toBe(true);

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][0].type).toBe('contextmenu');
  });

  it('consumes `>` without throwing when no header element matches', () => {
    const ctx = makeCtx();
    expect(document.querySelector('[data-pane-header-for="pane-a"]')).toBeNull();
    expect(() => handlePaneShortcuts(keydown('>'), ctx, { current: null })).not.toThrow();
    expect(handlePaneShortcuts(keydown('>'), ctx, { current: null })).toBe(true);
  });

  it('does nothing when a door is selected', () => {
    const onContextMenu = makeHeaderEl('pane-a');
    const ctx = makeCtx({ selectedTypeRef: { current: 'door' } });

    expect(handlePaneShortcuts(keydown('>'), ctx, { current: null })).toBe(false);
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});
