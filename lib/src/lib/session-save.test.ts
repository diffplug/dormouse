import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter } from './platform/types';
import type { PersistedSession } from './session-types';

const terminalRegistryMocks = vi.hoisted(() => ({
  getLivePersistedAlertState: vi.fn(),
  getTerminalPaneState: vi.fn(),
  isUntouched: vi.fn(),
  resolveTerminalSessionId: vi.fn(),
}));

vi.mock('./terminal-registry', () => ({
  getLivePersistedAlertState: terminalRegistryMocks.getLivePersistedAlertState,
  getTerminalPaneState: terminalRegistryMocks.getTerminalPaneState,
  isUntouched: terminalRegistryMocks.isUntouched,
  resolveTerminalSessionId: terminalRegistryMocks.resolveTerminalSessionId,
}));

import { saveSession } from './session-save';
import { UNNAMED_PANEL_TITLE } from './terminal-state';

function createPlatform(savedState: PersistedSession | null): PlatformAdapter {
  let persistedState: unknown = savedState;

  return {
    init: async () => {},
    shutdown: () => {},
    spawnPty: () => {},
    writePty: () => {},
    resizePty: () => {},
    killPty: () => {},
    getAvailableShells: vi.fn(async () => []),
    getCwd: vi.fn(async () => '/tmp/live'),
    getScrollback: vi.fn(async () => 'echo hello\n'),
    readClipboardFilePaths: vi.fn(async () => null),
    readClipboardImageAsFilePath: vi.fn(async () => null),
    onPtyData: () => {},
    offPtyData: () => {},
    onPtyExit: () => {},
    offPtyExit: () => {},
    requestInit: () => {},
    onPtyList: () => {},
    offPtyList: () => {},
    onPtyReplay: () => {},
    offPtyReplay: () => {},
    onRequestSessionFlush: () => {},
    offRequestSessionFlush: () => {},
    notifySessionFlushComplete: () => {},
    alertRemove: () => {},
    alertToggle: () => {},
    alertDisable: () => {},
    alertDismiss: () => {},
    alertDismissOrToggle: () => {},
    alertAttend: () => {},
    alertResize: () => {},
    alertClearAttention: () => {},
    alertToggleTodo: () => {},
    alertMarkTodo: () => {},
    alertClearTodo: () => {},
    onAlertState: () => {},
    offAlertState: () => {},
    saveState: vi.fn((state: unknown) => {
      persistedState = state;
    }),
    getState: vi.fn(() => persistedState),
  };
}

describe('saveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalRegistryMocks.resolveTerminalSessionId.mockImplementation((id: string) => id);
    terminalRegistryMocks.getLivePersistedAlertState.mockReturnValue(null);
    terminalRegistryMocks.getTerminalPaneState.mockReturnValue({ titleCandidates: {} });
    terminalRegistryMocks.isUntouched.mockReturnValue(false);
  });

  it('persists the live alert state even when the previous snapshot was empty', async () => {
    const platform = createPlatform({
      version: 3,
      layout: null,
      panes: [{ id: 'pane-a', title: 'Pane A', cwd: null, scrollback: null, resumeCommand: null, alert: null }],
    });

    terminalRegistryMocks.getLivePersistedAlertState.mockReturnValue({ status: 'NOTHING_TO_SHOW', todo: true });

    await saveSession(platform, { root: true }, [{ id: 'pane-a', title: 'Pane A' }]);

    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
      layout: { root: true },
      doors: [],
      panes: [
        expect.objectContaining({
          id: 'pane-a',
          alert: { status: 'NOTHING_TO_SHOW', todo: true },
        }),
      ],
    });
  });

  it('reads PTY data from the swapped terminal session id but persists the pane id', async () => {
    const platform = createPlatform(null);
    terminalRegistryMocks.resolveTerminalSessionId.mockReturnValue('pane-b');

    await saveSession(platform, { root: true }, [{ id: 'pane-a', title: 'Pane A' }]);

    expect(platform.getScrollback).toHaveBeenCalledWith('pane-b');
    expect(platform.getCwd).toHaveBeenCalledWith('pane-b');
    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
      layout: { root: true },
      doors: [],
      panes: [
        expect.objectContaining({
          id: 'pane-a',
          cwd: '/tmp/live',
          scrollback: 'echo hello\n',
        }),
      ],
    });
  });

  it('does not persist a derived minimized door label as a user title', async () => {
    const platform = createPlatform(null);

    await saveSession(platform, { root: true }, [], [{
      id: 'pane-a',
      title: 'npm test',
      neighborId: null,
      direction: 'right',
      remainingPaneIds: [],
      layoutAtMinimize: null,
      layoutAtMinimizeSignature: 'empty',
    }]);

    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
      layout: { root: true },
      doors: [
        expect.objectContaining({
          id: 'pane-a',
          title: UNNAMED_PANEL_TITLE,
        }),
      ],
      panes: [
        expect.objectContaining({
          id: 'pane-a',
          title: UNNAMED_PANEL_TITLE,
        }),
      ],
    });
  });

  it('persists a minimized door title when it is user-pinned semantic state', async () => {
    const platform = createPlatform(null);
    terminalRegistryMocks.getTerminalPaneState.mockReturnValue({
      titleCandidates: {
        user: { title: 'Production API', source: 'user', updatedAt: 1 },
      },
    });

    await saveSession(platform, { root: true }, [], [{
      id: 'pane-a',
      title: 'npm test',
      neighborId: null,
      direction: 'right',
      remainingPaneIds: [],
      layoutAtMinimize: null,
      layoutAtMinimizeSignature: 'empty',
    }]);

    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
      layout: { root: true },
      doors: [
        expect.objectContaining({
          id: 'pane-a',
          title: 'Production API',
        }),
      ],
      panes: [
        expect.objectContaining({
          id: 'pane-a',
          title: 'Production API',
        }),
      ],
    });
  });

  it('persists untouched state from the live registry entry', async () => {
    const platform = createPlatform(null);
    terminalRegistryMocks.isUntouched.mockReturnValue(true);

    await saveSession(platform, { root: true }, [{ id: 'pane-a', title: 'Pane A' }]);

    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
      layout: { root: true },
      doors: [],
      panes: [
        expect.objectContaining({
          id: 'pane-a',
          untouched: true,
        }),
      ],
    });
  });

  it('records surfaceType only for browser surfaces, leaving terminal panes unmarked', async () => {
    const platform = createPlatform(null);

    await saveSession(platform, { root: true }, [
      { id: 'pane-term', title: 'Terminal', surfaceType: 'terminal' },
      { id: 'pane-web', title: 'localhost', surfaceType: 'browser' },
    ]);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    const term = saved.panes.find((p) => p.id === 'pane-term')!;
    const web = saved.panes.find((p) => p.id === 'pane-web')!;
    expect('surfaceType' in term).toBe(false);
    expect(web.surfaceType).toBe('browser');
  });

  it('records surfaceType browser for a minimized browser door', async () => {
    const platform = createPlatform(null);

    await saveSession(platform, { root: true }, [], [{
      id: 'door-web',
      title: 'localhost',
      component: 'browser',
      params: { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173' },
      neighborId: null,
      direction: 'right',
      remainingPaneIds: [],
      layoutAtMinimize: null,
      layoutAtMinimizeSignature: 'empty',
    }]);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    expect(saved.panes.find((p) => p.id === 'door-web')!.surfaceType).toBe('browser');
  });
});
