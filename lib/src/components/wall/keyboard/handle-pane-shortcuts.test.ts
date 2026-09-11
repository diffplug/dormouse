/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { handlePaneShortcuts } from './handle-pane-shortcuts';
import { useWallKeyboard } from '../use-wall-keyboard';
import type { WallKeyboardCtx } from './types';

const terminalRegistryMocks = vi.hoisted(() => ({
  dismissOrToggleAlert: vi.fn(),
  getActivity: vi.fn(() => ({ status: 'WATCHING_DISABLED' })),
  toggleSessionTodo: vi.fn(),
}));

vi.mock('../../../lib/terminal-registry', () => ({
  dismissOrToggleAlert: terminalRegistryMocks.dismissOrToggleAlert,
  getActivity: terminalRegistryMocks.getActivity,
  toggleSessionTodo: terminalRegistryMocks.toggleSessionTodo,
}));

vi.mock('./handle-mouse-selection-keys', () => ({ handleMouseSelectionKeys: () => false }));

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
    activeRef: { current: true },
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
    requestKill: vi.fn(),
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
  beforeEach(() => vi.clearAllMocks());

  it.each(['x', 'k'])('hands the %s gesture to the Wall kill request', (key) => {
    const ctx = makeCtx();
    const event = keydown(key);

    expect(handlePaneShortcuts(event, ctx, { current: null })).toBe(true);

    expect(ctx.requestKill).toHaveBeenCalledWith('pane-a');
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('comma rename eligibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the terminal pane title editor', () => {
    const ctx = makeCtx();
    expect(handlePaneShortcuts(keydown(','), ctx, { current: null })).toBe(true);
    expect(ctx.setRenamingPaneId).toHaveBeenCalledWith('pane-a');
  });

  it.each([
    { name: 'terminal Door', selectedType: 'door', params: {} },
    { name: 'browser pane', selectedType: 'pane', params: { surfaceType: 'browser' } },
    { name: 'render-mode browser pane', selectedType: 'pane', params: { renderMode: 'iframe' } },
  ] as const)('keeps command dispatch live after comma on a $name', async ({ selectedType, params }) => {
    const renamingRef = { current: null as string | null };
    const ctx = makeCtx({
      selectedTypeRef: { current: selectedType },
      nav: makeNav({ paneParams: () => params }),
      renamingRef,
      confirmKillRef: { current: null },
      setRenamingPaneId: vi.fn((id) => { renamingRef.current = id as string; }),
    });
    function Harness() {
      useWallKeyboard(ctx);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Harness)));
    try {
      const comma = keydown(',');
      window.dispatchEvent(comma);
      expect(comma.defaultPrevented).toBe(true);
      expect(ctx.setRenamingPaneId).not.toHaveBeenCalled();

      window.dispatchEvent(keydown('Enter'));
      if (selectedType === 'door') {
        expect(ctx.handleReattachRef.current).toHaveBeenCalled();
      } else {
        expect(ctx.enterTerminalMode).toHaveBeenCalledWith('pane-a');
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe('handlePaneShortcuts Cmd-Arrow swap (nav seam)', () => {
  it.each(['metaKey', 'ctrlKey'] as const)('does not swap a selected Door through a stale breadcrumb (%s)', (modifier) => {
    const ctx = makeCtx({
      selectedTypeRef: { current: 'door' },
      nav: makeNav({ hasPane: () => true }),
    });
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft', [modifier]: true, bubbles: true, cancelable: true,
    });
    const history = { current: { direction: 'ArrowRight' as const, fromId: 'pane-b' } };

    expect(handlePaneShortcuts(event, ctx, history)).toBe(true);

    expect(event.defaultPrevented).toBe(true);
    expect(ctx.swapWithNeighbor).not.toHaveBeenCalled();
    expect(ctx.selectPane).not.toHaveBeenCalled();
    expect(ctx.fireEvent).not.toHaveBeenCalled();
  });

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
