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

import { collectLivePtys, resumeOrRestore, resumeOrRestoreFrom } from './reconnect';
import { addPlainNote, buildVolatileSnapshot, clearAllNotepads, getNotes } from './notepad/notepad-store';
import type { VolatileNotepadSnapshot } from './notepad/types';
import { getHelper, forgetHelper } from './helper-terminal';
import { setPlatform } from './platform';
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

  it('restores helpers outside the primary layout and disarms autorun', async () => {
    const layout = lathLayoutFor('parent');
    const helper = { parentId: 'parent', command: 'git status' };
    const result = await resumeOrRestore(createPlatform([{ id: 'parent', alive: true }, { id: 'helper', alive: true, helper }], {
      version: 3, lathLayout: layout, panes: [{ id: 'parent', title: 'Parent', cwd: null }],
    }));
    expect(result.paneIds).toEqual(['parent']); expect(result.lathLayout).toEqual(layout);
    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('helper', 'helper-replay', { alive: true, exitCode: undefined, helper });
    expect(getHelper('parent')?.status).toBe('preserved'); forgetHelper('parent');
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

describe('resumeOrRestoreFrom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const savedFor = (...ids: string[]): PersistedSession => ({
    version: 3,
    lathLayout: lathLayoutFor(...ids),
    panes: ids.map((id) => ({ id, title: id, cwd: null, untouched: false })),
  });

  /** One `collectLivePtys` for the whole Window, exactly as `main.tsx` boots. */
  async function live(ptys: PtyInfo[], savedState: PersistedSession | null = null) {
    const platform = createPlatform(ptys, savedState);
    return { platform, live: await collectLivePtys(platform) };
  }

  it('gives each Workspace only the live PTYs its own saved record names', async () => {
    const { platform, live: collected } = await live([
      { id: 'a1', alive: true },
      { id: 'b1', alive: true },
    ]);

    const a = resumeOrRestoreFrom(platform, collected, {
      savedSession: savedFor('a1'),
      ptyIds: new Set(['a1']),
    });
    const b = resumeOrRestoreFrom(platform, collected, {
      savedSession: savedFor('b1'),
      ptyIds: new Set(['b1']),
    });

    expect(a.paneIds).toEqual(['a1']);
    expect(b.paneIds).toEqual(['b1']);
    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('a1', 'a1-replay', expect.anything());
    expect(terminalRegistryMocks.resumeTerminal).toHaveBeenCalledWith('b1', 'b1-replay', expect.anything());
  });

  it('keeps a helper with the Workspace that holds its source', async () => {
    const helper = { parentId: 'a1', command: 'git status' };
    const { platform, live: collected } = await live([
      { id: 'a1', alive: true },
      { id: 'a-helper', alive: true, helper },
      { id: 'b1', alive: true },
    ]);

    const a = resumeOrRestoreFrom(platform, collected, {
      savedSession: savedFor('a1'),
      ptyIds: new Set(['a1', 'a-helper']),
    });
    expect(a.paneIds).toEqual(['a1']);
    expect(getHelper('a1')?.status).toBe('preserved');
    forgetHelper('a1');

    // The same helper handed to a Workspace WITHOUT its source is an ordinary
    // pane there: `ptyById` is the slice, so the parent lookup misses and the
    // orphan is adopted rather than restored as a helper.
    vi.clearAllMocks();
    setPlatform(platform);
    const b = resumeOrRestoreFrom(platform, collected, {
      savedSession: null,
      ptyIds: new Set(['b1', 'a-helper']),
    });
    expect(b.paneIds).toEqual(['a-helper', 'b1']);
    expect(getHelper('a1')).toBeUndefined();
  });

  it('claims a live PTY no saved Workspace names for the plan that asks', async () => {
    const { platform, live: collected } = await live([
      { id: 'a1', alive: true },
      { id: 'stray', alive: true },
    ]);

    const inactive = resumeOrRestoreFrom(platform, collected, {
      savedSession: savedFor('b1'),
      ptyIds: new Set(['b1']),
    });
    // No live PTY of its own: a cold restore of its saved panes.
    expect(inactive.paneIds).toEqual(['b1']);

    const active = resumeOrRestoreFrom(platform, collected, {
      savedSession: savedFor('a1'),
      ptyIds: new Set(['a1']),
      claimUnowned: new Set(['stray']),
    });
    // An adopted id has no saved layout slot, so the plan degrades to the flat
    // live list rather than restoring a layout that cannot hold it.
    expect(active.paneIds).toEqual(['a1', 'stray']);
    expect(active.lathLayout).toBeUndefined();
  });

  it('plans against the record it is handed, not the platform slot', async () => {
    const { platform, live: collected } = await live([], savedFor('slot-pane'));

    expect(resumeOrRestoreFrom(platform, collected, { savedSession: savedFor('given') }).paneIds)
      .toEqual(['given']);
    // `null` is "this Workspace has no record", never "read the slot".
    expect(resumeOrRestoreFrom(platform, collected, { savedSession: null }).paneIds).toEqual([]);
    // Omitted still reads the slot, which is what the single-Wall hosts take.
    expect(resumeOrRestoreFrom(platform, collected, {}).paneIds).toEqual(['slot-pane']);
  });

  it('takes the host record on the cold-restore branch', async () => {
    const { platform, live: collected } = await live([]);
    platform.getRecoveryCommands = vi.fn(() => ({ 'a1': 'claude --resume abc' }));

    resumeOrRestoreFrom(platform, collected, { savedSession: savedFor('a1') });
    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith(
      'a1', expect.objectContaining({ resumeCommand: 'claude --resume abc' }),
    );
  });
});

/**
 * One webview can have two collections outstanding at once — a boot and a
 * Workspace arriving from another Window, or two arrivals — and every listener
 * sees every answer. The token is what keeps each on its own
 * (`docs/specs/transport.md` → "Reconnection").
 */
describe('collectLivePtys addressing', () => {
  /** A host that answers each `requestInit` with only the PTYs named for that
   *  token, echoing it exactly as the sidecar's `list` does. */
  function addressedPlatform() {
    const listHandlers = new Set<(detail: { ptys: PtyInfo[]; requestId?: string }) => void>();
    const replayHandlers = new Set<(detail: { id: string; data: string; requestId?: string }) => void>();
    const asked: string[] = [];
    const platform = {
      requestInit: (requestId?: string) => {
        asked.push(requestId ?? '(none)');
      },
      onPtyList: (handler: (detail: { ptys: PtyInfo[]; requestId?: string }) => void) => { listHandlers.add(handler); },
      offPtyList: (handler: (detail: { ptys: PtyInfo[]; requestId?: string }) => void) => { listHandlers.delete(handler); },
      onPtyReplay: (handler: (detail: { id: string; data: string; requestId?: string }) => void) => { replayHandlers.add(handler); },
      offPtyReplay: (handler: (detail: { id: string; data: string; requestId?: string }) => void) => { replayHandlers.delete(handler); },
    } as unknown as PlatformAdapter;
    const answer = (requestId: string, ids: string[] = []) => {
      const ptys = ids.map((id) => ({ id, alive: true }) as PtyInfo);
      for (const handler of [...listHandlers]) handler({ ptys, requestId });
      for (const id of ids) {
        for (const handler of [...replayHandlers]) handler({ id, data: `${id}-replay`, requestId });
      }
    };
    return { platform, asked, answer };
  }

  it('gives two concurrent arrivals their own PTYs', async () => {
    const { platform, asked, answer } = addressedPlatform();
    const first = collectLivePtys(platform, { accept: (id) => id === 'a', timeoutMs: 1000 });
    const second = collectLivePtys(platform, { accept: (id) => id === 'b', timeoutMs: 1000 });
    await Promise.resolve();
    const [firstToken, secondToken] = asked;
    expect(firstToken).not.toBe(secondToken);

    // The second arrival's list reaches the first collector too. Filtered by
    // `accept` it is empty, and taken as this collector's own answer it would
    // read as "the host holds none" — a cold restore over live shells.
    answer(secondToken!, ['b']);
    answer(firstToken!, ['a']);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ timedOut: false });
    expect(b).toMatchObject({ timedOut: false });
    expect(a.ptys.map((pty) => pty.id)).toEqual(['a']);
    expect(b.ptys.map((pty) => pty.id)).toEqual(['b']);
    // Each resumes over its own replay, never the other's.
    expect([...a.replay.keys()]).toEqual(['a']);
    expect([...b.replay.keys()]).toEqual(['b']);
  });

  it('tells an empty answer apart from no answer at all', async () => {
    vi.useFakeTimers();
    try {
      const { platform, asked, answer } = addressedPlatform();
      const empty = collectLivePtys(platform, { timeoutMs: 100 });
      await Promise.resolve();
      answer(asked[0]!);
      const settled = await empty;
      // The host answered, and it holds nothing.
      expect(settled).toMatchObject({ ptys: [], timedOut: false });

      const silent = collectLivePtys(platform, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(200);
      // Nothing came back, so nothing is known: a caller that cold-restores
      // here starts fresh shells over PTYs that are still running.
      expect(await silent).toMatchObject({ ptys: [], timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumeOrRestore buys the retry only for a saved terminal pane', async () => {
    vi.useFakeTimers();
    try {
      // Nothing saved, and a host that never answers: the retry protects live
      // shells a cold restore would start over, and there are none to protect,
      // so first paint is not held for its whole budget.
      const fresh = addressedPlatform();
      (fresh.platform as { getState: () => unknown }).getState = () => null;
      const booted = resumeOrRestore(fresh.platform);
      await vi.advanceTimersByTimeAsync(600);
      expect(await booted).toEqual({ paneIds: [] });
      expect(fresh.asked).toHaveLength(1);

      // A saved terminal pane is exactly what the retry protects: ask again.
      const saved = addressedPlatform();
      (saved.platform as { getState: () => unknown }).getState = () => ({
        version: 3,
        panes: [{ id: 'a', title: 'a', cwd: '/tmp', untouched: false, alert: null }],
      });
      const restoring = resumeOrRestore(saved.platform);
      await vi.advanceTimersByTimeAsync(600);
      expect(saved.asked).toHaveLength(2);
      saved.answer(saved.asked[1]!, ['a']);
      expect((await restoring).paneIds).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks a second time before believing silence, and resumes on the late answer', async () => {
    vi.useFakeTimers();
    try {
      const { platform, asked, answer } = addressedPlatform();
      const collecting = collectLivePtys(platform, { timeoutMs: 100, retryTimeoutMs: 3000 });
      // The first wait runs out with nothing back: a boot that believed it here
      // would cold-restore, starting a second set of shells over live ones.
      await vi.advanceTimersByTimeAsync(200);
      expect(asked).toHaveLength(2);

      // The host is just slow. Its answer to the second ask is what resumes.
      answer(asked[1]!, ['a']);
      const collected = await collecting;
      expect(collected.timedOut).toBe(false);
      expect(collected.ptys.map((pty) => pty.id)).toEqual(['a']);
      expect([...collected.replay.keys()]).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks once when told to, and once more only on silence', async () => {
    vi.useFakeTimers();
    try {
      const { platform, asked, answer } = addressedPlatform();
      const answered = collectLivePtys(platform, { timeoutMs: 100, retryTimeoutMs: 3000 });
      await Promise.resolve();
      answer(asked[0]!);
      expect(await answered).toMatchObject({ ptys: [], timedOut: false });
      // An answered ask is never repeated.
      expect(asked).toHaveLength(1);

      // No `retryTimeoutMs`: one ask, and the silence stands.
      const once = collectLivePtys(platform, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(200);
      expect(await once).toMatchObject({ timedOut: true });
      expect(asked).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an answer from a host that echoes no token', async () => {
    // VS Code, Pocket and the website each serve one webview, so their answers
    // carry none and there is nothing to tell apart.
    const listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
    const platform = {
      requestInit: () => {
        for (const handler of [...listHandlers]) handler({ ptys: [{ id: 'a', alive: true } as PtyInfo] });
      },
      onPtyList: (handler: (detail: { ptys: PtyInfo[] }) => void) => { listHandlers.add(handler); },
      offPtyList: (handler: (detail: { ptys: PtyInfo[] }) => void) => { listHandlers.delete(handler); },
      onPtyReplay: () => {},
      offPtyReplay: () => {},
    } as unknown as PlatformAdapter;
    const collected = await collectLivePtys(platform, { timeoutMs: 1000 });
    expect(collected.ptys.map((pty) => pty.id)).toEqual(['a']);
    expect(collected.timedOut).toBe(false);
  });
});
