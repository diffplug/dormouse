/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePaneShortcuts } from './handle-pane-shortcuts';
import type { WallKeyboardCtx } from './types';

const terminalRegistryMocks = vi.hoisted(() => ({
  dismissOrToggleAlert: vi.fn(),
  getActivity: vi.fn(() => ({ status: 'ALERT_DISABLED' })),
  isUntouched: vi.fn(),
  swapTerminals: vi.fn(),
  toggleSessionTodo: vi.fn(),
}));

vi.mock('../../../lib/terminal-registry', () => ({
  dismissOrToggleAlert: terminalRegistryMocks.dismissOrToggleAlert,
  getActivity: terminalRegistryMocks.getActivity,
  isUntouched: terminalRegistryMocks.isUntouched,
  swapTerminals: terminalRegistryMocks.swapTerminals,
  toggleSessionTodo: terminalRegistryMocks.toggleSessionTodo,
}));

vi.mock('../../KillConfirm', () => ({
  randomKillChar: () => 'Q',
}));

function makeCtx(overrides: Partial<WallKeyboardCtx> = {}): WallKeyboardCtx {
  return {
    apiRef: { current: {} },
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
