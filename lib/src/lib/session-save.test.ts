import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter } from './platform/types';
import { PERSISTED_SCROLLBACK_MAX_CHARS } from './scrollback-trim';
import type { PersistedSession } from './session-types';

const terminalRegistryMocks = vi.hoisted(() => ({
  getActivity: vi.fn(),
  getLivePersistedAlertState: vi.fn(),
  getTerminalPaneState: vi.fn(),
  isUntouched: vi.fn(),
  resolveTerminalSessionId: vi.fn(),
}));

vi.mock('./terminal-registry', () => ({
  getActivity: terminalRegistryMocks.getActivity,
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
    terminalRegistryMocks.getActivity.mockReturnValue({
      status: 'WATCHING_DISABLED',
      watchingEnabled: false,
      todo: false,
      notification: null,
    });
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

    await saveSession(platform, [{ id: 'pane-a', title: 'Pane A' }]);

    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
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

    await saveSession(platform, [{ id: 'pane-a', title: 'Pane A' }]);

    expect(platform.getScrollback).toHaveBeenCalledWith('pane-b');
    expect(platform.getCwd).toHaveBeenCalledWith('pane-b');
    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
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

    await saveSession(platform, [], [{
      id: 'pane-a',
      title: 'npm test',
    }]);

    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
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

    await saveSession(platform, [], [{
      id: 'pane-a',
      title: 'npm test',
    }]);

    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
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

    await saveSession(platform, [{ id: 'pane-a', title: 'Pane A' }]);

    expect(platform.saveState).toHaveBeenCalledWith({
      version: 3,
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

    await saveSession(platform, [
      { id: 'pane-term', title: 'Terminal', surfaceType: 'terminal' },
      { id: 'pane-web', title: 'localhost', surfaceType: 'browser' },
    ]);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    const term = saved.panes.find((p) => p.id === 'pane-term')!;
    const web = saved.panes.find((p) => p.id === 'pane-web')!;
    expect('surfaceType' in term).toBe(false);
    expect(web.surfaceType).toBe('browser');
    expect(platform.getScrollback).toHaveBeenCalledWith('pane-term');
    expect(platform.getCwd).toHaveBeenCalledWith('pane-term');
    expect(platform.getScrollback).not.toHaveBeenCalledWith('pane-web');
    expect(platform.getCwd).not.toHaveBeenCalledWith('pane-web');
  });

  it('records surfaceType browser for a minimized browser door', async () => {
    const platform = createPlatform(null);

    await saveSession(platform, [], [{
      id: 'door-web',
      title: 'localhost',
      component: 'browser',
      params: { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173' },
    }]);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    expect(saved.panes.find((p) => p.id === 'door-web')!.surfaceType).toBe('browser');
    expect(platform.getScrollback).not.toHaveBeenCalledWith('door-web');
    expect(platform.getCwd).not.toHaveBeenCalledWith('door-web');
  });

  it('trims persisted scrollback that exceeds the 100k cap, keeping the tail and detecting resume commands', async () => {
    const platform = createPlatform(null);
    // ~165k chars of noise, then a resume command printed at the very end.
    const bigScrollback = 'noise line\n'.repeat(15_000) + 'claude --resume sess_abc\n';
    expect(bigScrollback.length).toBeGreaterThan(PERSISTED_SCROLLBACK_MAX_CHARS);
    vi.mocked(platform.getScrollback).mockResolvedValue(bigScrollback);

    await saveSession(platform, [{ id: 'pane-a', title: 'Pane A' }]);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    const pane = saved.panes.find((p) => p.id === 'pane-a')!;
    expect(pane.scrollback!.length).toBeLessThanOrEqual(PERSISTED_SCROLLBACK_MAX_CHARS);
    // The persisted content is the tail of the live buffer.
    expect(bigScrollback.endsWith(pane.scrollback!)).toBe(true);
    expect(pane.scrollback!.endsWith('claude --resume sess_abc\n')).toBe(true);
    // Resume detection still works because the pattern lives at the tail.
    expect(pane.resumeCommand).toBe('claude --resume sess_abc');
  });

  it('writes the Lath layout and never a legacy dockview `layout` key', async () => {
    const platform = createPlatform(null);
    const lathLayout = { version: 1, tree: { root: { kind: 'leaf', id: 'pane-a' } }, leafMeta: {} };

    await saveSession(platform, [{ id: 'pane-a', title: 'Pane A' }], [], lathLayout);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    expect('layout' in saved).toBe(false);
    expect(saved.lathLayout).toEqual(lathLayout);
  });

  it('omits lathLayout entirely when not supplied', async () => {
    const platform = createPlatform(null);

    await saveSession(platform, [{ id: 'pane-a', title: 'Pane A' }]);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    expect('lathLayout' in saved).toBe(false);
    expect('layout' in saved).toBe(false);
  });

  it('persists a door restore token through to the saved blob', async () => {
    const platform = createPlatform(null);
    const token = { leafId: 'door-a', weight: 0.5, siblingId: 'pane-b', edge: 'right', index: 0, fingerprint: null };

    await saveSession(platform, [], [{
      id: 'door-a',
      title: 'npm test',
      token,
    }]);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    expect(saved.doors?.[0]?.token).toEqual(token);
  });

  it('persists local browser surface TODO state in the browser pane alert field', async () => {
    const platform = createPlatform(null);
    terminalRegistryMocks.getActivity.mockReturnValue({
      status: 'WATCHING_DISABLED',
      watchingEnabled: false,
      todo: true,
      notification: null,
    });

    await saveSession(platform, [
      { id: 'pane-web', title: 'localhost', surfaceType: 'browser' },
    ]);

    const saved = vi.mocked(platform.saveState).mock.calls[0]![0] as PersistedSession;
    expect(saved.panes.find((p) => p.id === 'pane-web')!.alert).toEqual({
      status: 'WATCHING_DISABLED',
      watchingEnabled: false,
      todo: true,
      notification: null,
    });
  });
});
