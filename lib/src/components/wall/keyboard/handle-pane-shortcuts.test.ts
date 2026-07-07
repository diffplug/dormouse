/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeNav(overrides: Partial<WallKeyboardCtx['nav']> = {}): WallKeyboardCtx['nav'] {
  return {
    ready: () => true,
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
    paneElements: new Map(),
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

  it('swaps with the nav-resolved neighbor, fires move, and follows selection', () => {
    const ctx = makeCtx({
      nav: makeNav({ findInDirection: (_id, dir) => (dir === 'ArrowRight' ? 'pane-b' : null) }),
    });

    expect(handlePaneShortcuts(keydownMeta('ArrowRight'), ctx, { current: null })).toBe(true);

    expect(ctx.swapWithNeighbor).toHaveBeenCalledWith('pane-a', 'pane-b');
    expect(ctx.fireEvent).toHaveBeenCalledWith({ type: 'move', fromId: 'pane-a', toId: 'pane-b' });
    expect(ctx.selectPane).toHaveBeenCalledWith('pane-b');
  });

  it('does nothing when nav finds no neighbor in that direction', () => {
    const ctx = makeCtx({ nav: makeNav({ findInDirection: () => null }) });

    expect(handlePaneShortcuts(keydownMeta('ArrowLeft'), ctx, { current: null })).toBe(true);

    expect(ctx.swapWithNeighbor).not.toHaveBeenCalled();
    expect(ctx.selectPane).not.toHaveBeenCalled();
  });

  it('bails entirely when the engine is not ready', () => {
    const ctx = makeCtx({ nav: makeNav({ ready: () => false }) });

    expect(handlePaneShortcuts(keydown('x'), ctx, { current: null })).toBe(false);
    expect(ctx.killPaneImmediately).not.toHaveBeenCalled();
  });
});
