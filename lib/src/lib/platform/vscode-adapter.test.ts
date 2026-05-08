import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminalStateStoreMocks = vi.hoisted(() => ({
  applyTerminalSemanticEventsByPtyId: vi.fn(),
  removeTerminalPaneState: vi.fn(),
}));

vi.mock('../terminal-state-store', () => ({
  applyTerminalSemanticEventsByPtyId: terminalStateStoreMocks.applyTerminalSemanticEventsByPtyId,
  removeTerminalPaneState: terminalStateStoreMocks.removeTerminalPaneState,
}));

import { VSCodeAdapter } from './vscode-adapter';

describe('VSCodeAdapter PTY exit handling', () => {
  let windowTarget: EventTarget;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    windowTarget = new EventTarget();
    postMessage = vi.fn();
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps semantic pane state when a PTY exits naturally', () => {
    const adapter = new VSCodeAdapter();
    const exits: Array<{ id: string; exitCode: number }> = [];
    adapter.onPtyExit((detail) => exits.push(detail));

    windowTarget.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pty:exit', id: 'pane-1', exitCode: 7 },
    }));

    expect(exits).toEqual([{ id: 'pane-1', exitCode: 7 }]);
    expect(terminalStateStoreMocks.removeTerminalPaneState).not.toHaveBeenCalled();
  });

  it('lets lifecycle cleanup remove semantic pane state after explicitly killing a PTY', () => {
    const adapter = new VSCodeAdapter();

    adapter.killPty('pane-1');

    expect(terminalStateStoreMocks.removeTerminalPaneState).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'pty:kill', id: 'pane-1' });
  });
});
