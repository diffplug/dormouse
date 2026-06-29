import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter } from './platform/types';
import type { PersistedSession } from './session-types';

const terminalRegistryMocks = vi.hoisted(() => ({
  getDefaultShellOpts: vi.fn(),
  restoreTerminal: vi.fn(),
}));

vi.mock('./terminal-registry', () => ({
  getDefaultShellOpts: terminalRegistryMocks.getDefaultShellOpts,
  restoreTerminal: terminalRegistryMocks.restoreTerminal,
}));

import { restoreSession } from './session-restore';

function createPlatform(savedState: PersistedSession | null): PlatformAdapter {
  return {
    init: async () => {},
    shutdown: () => {},
    getAvailableShells: vi.fn(async () => []),
    spawnPty: vi.fn(),
    writePty: vi.fn(),
    resizePty: vi.fn(),
    killPty: vi.fn(),
    getCwd: vi.fn(async () => null),
    getScrollback: vi.fn(async () => null),
    readClipboardFilePaths: vi.fn(async () => null),
    readClipboardImageAsFilePath: vi.fn(async () => null),
    onPtyData: vi.fn(),
    offPtyData: vi.fn(),
    onPtyExit: vi.fn(),
    offPtyExit: vi.fn(),
    requestInit: vi.fn(),
    onPtyList: vi.fn(),
    offPtyList: vi.fn(),
    onPtyReplay: vi.fn(),
    offPtyReplay: vi.fn(),
    onRequestSessionFlush: vi.fn(),
    offRequestSessionFlush: vi.fn(),
    notifySessionFlushComplete: vi.fn(),
    alertRemove: vi.fn(),
    alertToggle: vi.fn(),
    alertDisable: vi.fn(),
    alertDismiss: vi.fn(),
    alertDismissOrToggle: vi.fn(),
    alertAttend: vi.fn(),
    alertResize: vi.fn(),
    alertClearAttention: vi.fn(),
    alertToggleTodo: vi.fn(),
    alertMarkTodo: vi.fn(),
    alertClearTodo: vi.fn(),
    onAlertState: vi.fn(),
    offAlertState: vi.fn(),
    saveState: vi.fn(),
    getState: vi.fn(() => savedState),
  };
}

describe('restoreSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns restored terminals with the configured default shell', () => {
    terminalRegistryMocks.getDefaultShellOpts.mockReturnValue({
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'],
    });
    const saved: PersistedSession = {
      version: 3,
      layout: { panels: { 'pane-a': {} } },
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: 'C:\\repo', scrollback: 'hello', resumeCommand: null },
      ],
    };

    restoreSession(createPlatform(saved));

    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith('pane-a', {
      cwd: 'C:\\repo',
      scrollback: 'hello',
      title: 'Pane A',
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'],
      untouched: false,
    });
  });

  it('seeds restored untouched state', () => {
    const saved: PersistedSession = {
      version: 3,
      layout: { panels: { 'pane-a': {} } },
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null, scrollback: null, resumeCommand: null, untouched: true },
      ],
    };

    restoreSession(createPlatform(saved));

    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith('pane-a', expect.objectContaining({
      untouched: true,
    }));
  });

  it('does not spawn a terminal for a browser surface, but keeps it in paneIds', () => {
    const saved: PersistedSession = {
      version: 3,
      layout: { panels: { 'pane-term': {}, 'pane-web': {} } },
      panes: [
        { id: 'pane-term', title: 'Terminal', cwd: null, scrollback: null, resumeCommand: null, untouched: false },
        { id: 'pane-web', title: 'localhost', cwd: null, scrollback: null, resumeCommand: null, untouched: false, surfaceType: 'browser' },
      ],
    };

    const result = restoreSession(createPlatform(saved));

    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledTimes(1);
    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith('pane-term', expect.objectContaining({ title: 'Terminal' }));
    // The browser pane stays in paneIds so the layout blob recreates and selects it.
    expect(result?.paneIds).toEqual(['pane-term', 'pane-web']);
  });
});
