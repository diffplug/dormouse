import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter, PtyInfo } from './platform/types';
import type { PersistedSession } from './session-types';

const terminalRegistryMocks = vi.hoisted(() => ({
  restoreBrowserSurfaceTodo: vi.fn(),
  resumeTerminal: vi.fn(),
  restoreTerminal: vi.fn(),
  getDefaultShellOpts: vi.fn(() => null),
}));

vi.mock('./terminal-registry', () => ({
  restoreBrowserSurfaceTodo: terminalRegistryMocks.restoreBrowserSurfaceTodo,
  resumeTerminal: terminalRegistryMocks.resumeTerminal,
  restoreTerminal: terminalRegistryMocks.restoreTerminal,
  getDefaultShellOpts: terminalRegistryMocks.getDefaultShellOpts,
}));

import { resumeOrRestore } from './reconnect';
import { addPlainNote, buildVolatileSnapshot, clearAllNotepads, getNotes } from './notepad/notepad-store';
import type { VolatileNotepadSnapshot } from './notepad/types';
import type { LathNode } from './lath/model';

/** A native Lath persisted layout over `ids` (row split; empty tree for none) —
 *  the shape every post-Lath save carries. */
function lathLayoutFor(...ids: string[]) {
  const nodes = ids.map((id): LathNode => ({ kind: 'leaf', id }));
  const root: LathNode | null =
    nodes.length === 0 ? null : nodes.length === 1 ? nodes[0] : { kind: 'split', dir: 'row', children: nodes.map((node) => ({ node, weight: 1 / nodes.length })) };
  return {
    version: 1 as const,
    tree: { root },
    leafMeta: Object.fromEntries(ids.map((id) => [id, { component: 'terminal', tabComponent: 'terminal', title: id }])),
  };
}

function createPlatform(ptys: PtyInfo[], savedState: PersistedSession | null): PlatformAdapter {
  const listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  const replayHandlers = new Set<(detail: { id: string; data: string }) => void>();

  return {
    init: async () => {},
    shutdown: () => {},
    getAvailableShells: vi.fn(async () => []),
    spawnPty: vi.fn(),
    writePty: vi.fn(),
    resizePty: vi.fn(),
    killPty: vi.fn(),
    getCwd: vi.fn(async () => null),
    readClipboardFilePaths: vi.fn(async () => null),
    readClipboardImageAsFilePath: vi.fn(async () => null),
    onPtyData: vi.fn(),
    offPtyData: vi.fn(),
    onPtyExit: vi.fn(),
    offPtyExit: vi.fn(),
    requestInit: vi.fn(() => {
      for (const handler of listHandlers) handler({ ptys });
      for (const pty of ptys) {
        for (const handler of replayHandlers) handler({ id: pty.id, data: `${pty.id}-replay` });
      }
    }),
    onPtyList: (handler) => { listHandlers.add(handler); },
    offPtyList: (handler) => { listHandlers.delete(handler); },
    onPtyReplay: (handler) => { replayHandlers.add(handler); },
    offPtyReplay: (handler) => { replayHandlers.delete(handler); },
    onRequestSessionFlush: vi.fn(),
    offRequestSessionFlush: vi.fn(),
    notifySessionFlushComplete: vi.fn(),
    alertRemove: vi.fn(),
    alertSetWatchedCommands: vi.fn(),
    alertSetCommandWatched: vi.fn(),
    alertDismiss: vi.fn(),
    alertAttend: vi.fn(),
    alertResize: vi.fn(),
    alertClearAttention: vi.fn(),
    alertToggleTodo: vi.fn(),
    alertMarkTodo: vi.fn(),
    alertClearTodo: vi.fn(),
    onAlertState: vi.fn(),
    onWatchedCommands: vi.fn(),
    saveState: vi.fn(),
    getState: vi.fn(() => savedState),
  };
}

describe('resumeOrRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores saved visible layout and minimized doors for matching live PTYs', async () => {
    const lathLayout = lathLayoutFor('pane-a', 'pane-b');
    const doors = [{
      id: 'pane-c',
      title: 'Pane C',
    }];
    const saved: PersistedSession = {
      version: 3,
      lathLayout,
      doors,
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null },
        { id: 'pane-b', title: 'Pane B', cwd: null },
        { id: 'pane-c', title: 'Pane C', cwd: null },
      ],
    };

    const result = await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
      { id: 'pane-b', alive: true },
      { id: 'pane-c', alive: true },
    ], saved));

    expect(result).toEqual({
      paneIds: ['pane-a', 'pane-b'],
      doors,
      lathLayout,
    });
    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('pane-c', 'pane-c-replay', {
      alive: true,
      exitCode: undefined,
      title: 'Pane C',
    });
  });

  it('restores workspace-scoped dor surface refs when resuming live PTYs', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-a'),
      surfaceRefs: { 'pane-a': 'surface:1', 'closed-pane': 'surface:2' },
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null },
      ],
    };

    const result = await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
    ], saved));

    expect(result.surfaceRefs).toEqual({ 'pane-a': 'surface:1', 'closed-pane': 'surface:2' });
  });

  it('seeds saved visible pane titles when resuming live PTYs', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-a'),
      panes: [
        { id: 'pane-a', title: 'Production API', cwd: null },
      ],
    };

    await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
    ], saved));

    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('pane-a', 'pane-a-replay', {
      alive: true,
      exitCode: undefined,
      title: 'Production API',
    });
  });

  it('restores the launch shell reported by a live PTY', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-a'),
      panes: [
        { id: 'pane-a', title: 'PowerShell', cwd: null },
      ],
    };

    await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true, shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    ], saved));

    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('pane-a', 'pane-a-replay', {
      alive: true,
      exitCode: undefined,
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      title: 'PowerShell',
    });
  });

  it('seeds saved untouched state when resuming live PTYs', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-a'),
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null, untouched: true },
      ],
    };

    await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
    ], saved));

    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('pane-a', 'pane-a-replay', {
      alive: true,
      exitCode: undefined,
      title: 'Pane A',
      untouched: true,
    });
  });

  it('defaults missing saved untouched state to touched when resuming live PTYs', async () => {
    const saved = {
      version: 3 as const,
      lathLayout: lathLayoutFor('pane-a'),
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null },
      ],
    };

    await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
    ], saved as PersistedSession));

    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('pane-a', 'pane-a-replay', {
      alive: true,
      exitCode: undefined,
      title: 'Pane A',
    });
  });

  it('seeds saved minimized door titles when resuming live PTYs', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor(),
      doors: [{
        id: 'pane-a',
        title: 'Renamed Door',
      }],
      panes: [
        { id: 'pane-a', title: 'Renamed Door', cwd: null },
      ],
    };

    await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
    ], saved));

    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('pane-a', 'pane-a-replay', {
      alive: true,
      exitCode: undefined,
      title: 'Renamed Door',
    });
  });

  it('does not reuse a saved layout when live PTYs do not match saved panes', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-a', 'pane-b'),
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null },
        { id: 'pane-b', title: 'Pane B', cwd: null },
      ],
    };

    const result = await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
      { id: 'pane-b', alive: true },
      { id: 'extra-pane', alive: true },
    ], saved));

    expect(result).toEqual({
      paneIds: ['pane-a', 'pane-b', 'extra-pane'],
      doors: [],
    });
  });

  it('returns the live resume plan when every live session is minimized', async () => {
    const doors = [{
      id: 'pane-a',
      title: 'Pane A',
    }, {
      id: 'pane-b',
      title: 'Pane B',
    }];
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor(),
      doors,
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null },
        { id: 'pane-b', title: 'Pane B', cwd: null },
        { id: 'stale-pane', title: 'Stale Pane', cwd: null },
      ],
    };

    const result = await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
      { id: 'pane-b', alive: true },
    ], saved));

    expect(result).toEqual({
      paneIds: [],
      doors,
      lathLayout: lathLayoutFor(),
    });
    expect(terminalRegistryMocks.restoreTerminal).not.toHaveBeenCalled();
  });

  it('ignores stale saved panes when the saved layout still matches live visible panes', async () => {
    const lathLayout = lathLayoutFor('pane-a', 'pane-b');
    const saved: PersistedSession = {
      version: 3,
      lathLayout,
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null },
        { id: 'pane-b', title: 'Pane B', cwd: null },
        { id: 'stale-pane', title: 'Stale Pane', cwd: null },
      ],
    };

    const result = await resumeOrRestore(createPlatform([
      { id: 'pane-a', alive: true },
      { id: 'pane-b', alive: true },
    ], saved));

    expect(result).toEqual({
      paneIds: ['pane-a', 'pane-b'],
      doors: [],
      lathLayout,
    });
  });

  it('keeps the saved layout and a visible browser pane when only terminals have live PTYs', async () => {
    const lathLayout = lathLayoutFor('pane-term', 'pane-web');
    const saved: PersistedSession = {
      version: 3,
      lathLayout,
      panes: [
        { id: 'pane-term', title: 'Terminal', cwd: null },
        { id: 'pane-web', title: 'localhost', cwd: null, surfaceType: 'browser' },
      ],
    };

    const result = await resumeOrRestore(createPlatform([
      { id: 'pane-term', alive: true },
    ], saved));

    expect(result).toEqual({
      paneIds: ['pane-term', 'pane-web'],
      doors: [],
      lathLayout,
    });
    // The browser pane has no PTY and is never resumed as a terminal.
    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledTimes(1);
    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('pane-term', 'pane-term-replay', expect.anything());
  });

  it('restores browser surface TODO from the persisted alert during live resume', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-term', 'pane-web'),
      panes: [
        { id: 'pane-term', title: 'Terminal', cwd: null },
        {
          id: 'pane-web',
          title: 'localhost',
          cwd: null,
          surfaceType: 'browser',
          alert: { status: 'WATCHING_DISABLED', watchingEnabled: false, todo: true, notification: null },
        },
      ],
    };

    await resumeOrRestore(createPlatform([
      { id: 'pane-term', alive: true },
    ], saved));

    // Resume delegates the browser pane to restoreBrowserSurfaceTodo, which owns
    // routing the persisted TODO into the local activity store (verified against
    // the real store in terminal-registry.alert.test.ts).
    expect(terminalRegistryMocks.restoreBrowserSurfaceTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pane-web',
        surfaceType: 'browser',
        alert: expect.objectContaining({ todo: true }),
      }),
    );
  });

  it('drops visible browser panes from terminal fallback when the saved layout is rejected', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-term', 'stale-term', 'pane-web'),
      panes: [
        { id: 'pane-term', title: 'Terminal', cwd: null },
        { id: 'stale-term', title: 'Stale terminal', cwd: null },
        { id: 'pane-web', title: 'localhost', cwd: null, surfaceType: 'browser' },
      ],
    };

    const result = await resumeOrRestore(createPlatform([
      { id: 'pane-term', alive: true },
    ], saved));

    expect(result).toEqual({
      paneIds: ['pane-term'],
      doors: [],
      lathLayout: undefined,
    });
  });

  it('keeps a minimized browser door alive across resume despite having no PTY', async () => {
    const lathLayout = lathLayoutFor('pane-term');
    const doors = [{
      id: 'door-web',
      title: 'localhost',
      component: 'browser',
      params: { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173' },
    }];
    const saved: PersistedSession = {
      version: 3,
      lathLayout,
      doors,
      panes: [
        { id: 'pane-term', title: 'Terminal', cwd: null },
        { id: 'door-web', title: 'localhost', cwd: null, surfaceType: 'browser' },
      ],
    };

    const result = await resumeOrRestore(createPlatform([
      { id: 'pane-term', alive: true },
    ], saved));

    expect(result).toEqual({
      paneIds: ['pane-term'],
      doors,
      lathLayout,
    });
  });
});

/**
 * The mirror the VS Code extension host boots a re-resolved webview with. It
 * hydrates a live resume and nothing else (docs/specs/notepad.md → "Live
 * resume"): a cold restore is a different Session over PTYs that no longer
 * exist, so notes must not reappear there.
 */
describe('notepad hydration', () => {
  const snapshot: VolatileNotepadSnapshot = {
    surfaces: [
      {
        surfaceId: 'pane-a',
        surfaceTitle: 'pnpm dev',
        surfaceKind: 'terminal',
        cwd: null,
        notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'mirrored' } }],
      },
      {
        surfaceId: 'door-b',
        surfaceTitle: 'zsh',
        surfaceKind: 'terminal',
        cwd: null,
        notes: [{ id: 'n2', createdAt: 2, content: { kind: 'plain', text: 'minimized too' } }],
      },
    ],
    stagedDeletions: {},
  };

  /** Attach an archive port that only ever answers `loadVolatile` — the one
   *  member this path touches. */
  function withMirror(platform: PlatformAdapter): ReturnType<typeof vi.fn> {
    const loadVolatile = vi.fn(() => snapshot);
    (platform as { notepadArchive?: unknown }).notepadArchive = { loadVolatile };
    return loadVolatile;
  }

  beforeEach(() => {
    clearAllNotepads();
  });

  it('restores mirrored notes for every live Surface on a resume, doors included', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-a'),
      doors: [{ id: 'door-b', title: 'zsh' }],
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null },
        { id: 'door-b', title: 'zsh', cwd: null },
      ],
    };
    const platform = createPlatform([
      { id: 'pane-a', alive: true },
      { id: 'door-b', alive: true },
    ], saved);
    const loadVolatile = withMirror(platform);

    await resumeOrRestore(platform);

    expect(loadVolatile).toHaveBeenCalledTimes(1);
    expect(getNotes('pane-a').map((note) => note.content)).toEqual([{ kind: 'plain', text: 'mirrored' }]);
    expect(getNotes('door-b').map((note) => note.content)).toEqual([{ kind: 'plain', text: 'minimized too' }]);
  });

  it('restores mirrored notes on a resume with no saved plan to match', async () => {
    const platform = createPlatform([{ id: 'pane-a', alive: true }], null);
    withMirror(platform);

    await resumeOrRestore(platform);

    expect(getNotes('pane-a')).toHaveLength(1);
  });

  it('never reads the mirror on a cold restore', async () => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('pane-a'),
      panes: [{ id: 'pane-a', title: 'Pane A', cwd: null }],
    };
    // No live PTYs: `resumeOrRestore` falls through to the saved session.
    const platform = createPlatform([], saved);
    const loadVolatile = withMirror(platform);

    const result = await resumeOrRestore(platform);

    expect(result.paneIds).toEqual(['pane-a']);
    expect(loadVolatile).not.toHaveBeenCalled();
    expect(getNotes('pane-a')).toEqual([]);
  });
});

describe('browser-only notepad resume', () => {
  beforeEach(() => { clearAllNotepads(); });
  it.each([true, false])('hydrates browser notes only with a same-host mirror (present: %s)', async (sameHost) => {
    const saved: PersistedSession = {
      version: 3,
      lathLayout: lathLayoutFor('web'),
      doors: [{ id: 'door-web', title: 'Browser door', component: 'browser' }],
      panes: [
        { id: 'web', title: 'Browser', cwd: null, surfaceType: 'browser' },
        { id: 'door-web', title: 'Browser door', cwd: null, surfaceType: 'browser' },
      ],
    };
    const snapshot: VolatileNotepadSnapshot = {
      surfaces: ['web', 'door-web'].map((id) => ({
        surfaceId: id, surfaceTitle: id, surfaceKind: 'browser', cwd: null,
        notes: [{ id: `${id}-note`, createdAt: 1, content: { kind: 'plain', text: `keep ${id}` } }],
      })),
      stagedDeletions: {},
    };
    const platform = createPlatform([], saved);
    const loadVolatile = vi.fn(() => sameHost ? snapshot : null);
    (platform as { notepadArchive?: unknown }).notepadArchive = { loadVolatile };
    const result = await resumeOrRestore(platform);
    expect(result.paneIds).toEqual(['web']);
    expect(result.doors?.map((door) => door.id)).toEqual(['door-web']);
    expect(loadVolatile).toHaveBeenCalledTimes(1);
    for (const surface of snapshot.surfaces) {
      expect(getNotes(surface.surfaceId)).toEqual(sameHost ? surface.notes : []);
    }
    addPlainNote('web', 'new note');
    expect(buildVolatileSnapshot().surfaces.find((surface) => surface.surfaceId === 'web')?.notes)
      .toHaveLength(sameHost ? 2 : 1);
    expect(platform.spawnPty).not.toHaveBeenCalled();
  });
});
