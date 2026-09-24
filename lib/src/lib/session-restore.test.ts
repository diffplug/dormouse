import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter } from './platform/types';
import type { PersistedSession } from './session-types';

const terminalRegistryMocks = vi.hoisted(() => ({
  getDefaultShellOpts: vi.fn(),
  restoreBrowserSurfaceTodo: vi.fn(),
  restoreTerminal: vi.fn(),
}));

vi.mock('./terminal-registry', () => ({
  getDefaultShellOpts: terminalRegistryMocks.getDefaultShellOpts,
  restoreBrowserSurfaceTodo: terminalRegistryMocks.restoreBrowserSurfaceTodo,
  restoreTerminal: terminalRegistryMocks.restoreTerminal,
}));

import { restoreSession } from './session-restore';

function createPlatform(
  savedState: PersistedSession | null,
  recoveryCommands: Record<string, string> = {},
): PlatformAdapter {
  return {
    getRecoveryCommands: vi.fn(() => recoveryCommands),
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
    requestInit: vi.fn(),
    onPtyList: vi.fn(),
    offPtyList: vi.fn(),
    onPtyReplay: vi.fn(),
    offPtyReplay: vi.fn(),
    onRequestSessionFlush: vi.fn(),
    offRequestSessionFlush: vi.fn(),
    notifySessionFlushComplete: vi.fn(),
    alertSetWatchedCommands: vi.fn(),
    alertSetCommandWatched: vi.fn(),
    alertDismiss: vi.fn(),
    alertEngagement: vi.fn(),
    alertAcknowledge: vi.fn(),
    alertToggleTodo: vi.fn(),
    alertClearTodo: vi.fn(),
    onAlertState: vi.fn(),
    onWatchedCommands: vi.fn(),
    saveState: vi.fn(),
    getState: vi.fn(() => savedState),
  };
}

describe('restoreSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands each restored terminal its recovery command to auto-run', () => {
    // The command comes from the host's boot payload, keyed by pane id — never
    // from the persisted pane, which no longer carries one.
    const saved: PersistedSession = {
      version: 3,
      panes: [
        { id: 'pane-a', title: 'A', cwd: null, untouched: false },
        { id: 'pane-b', title: 'B', cwd: null, untouched: false },
      ],
    };

    restoreSession(createPlatform(saved, { 'pane-a': 'claude --resume abc' }));

    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith(
      'pane-a',
      expect.objectContaining({ resumeCommand: 'claude --resume abc' }),
    );
    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith(
      'pane-b',
      expect.objectContaining({ resumeCommand: null }),
    );
  });

  it('resumes nothing when the host captured nothing', () => {
    const saved: PersistedSession = {
      version: 3,
      panes: [{ id: 'pane-a', title: 'A', cwd: null, untouched: false }],
    };

    restoreSession(createPlatform(saved));

    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith(
      'pane-a',
      expect.objectContaining({ resumeCommand: null }),
    );
  });

  it('never replays a transcript — restore carries no scrollback at all', () => {
    const saved: PersistedSession = {
      version: 3,
      panes: [{ id: 'pane-a', title: 'A', cwd: null, untouched: false }],
    };

    restoreSession(createPlatform(saved));

    const opts = terminalRegistryMocks.restoreTerminal.mock.calls[0]![1] as Record<string, unknown>;
    expect('scrollback' in opts).toBe(false);
  });

  it('restores no terminal, and so no resume, for a browser surface', () => {
    const saved: PersistedSession = {
      version: 3,
      panes: [
        // Routing keys off surface kind, so a captured command for a browser pane
        // is simply never reached.
        { id: 'pane-web', title: 'localhost', cwd: null, untouched: false, surfaceType: 'browser' },
      ],
    };

    restoreSession(createPlatform(saved, { 'pane-web': 'claude --resume abc' }));

    expect(terminalRegistryMocks.restoreTerminal).not.toHaveBeenCalled();
  });

  it('spawns restored terminals with the configured default shell', () => {
    terminalRegistryMocks.getDefaultShellOpts.mockReturnValue({
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'],
    });
    const saved: PersistedSession = {
      version: 3,
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: 'C:\\repo' },
      ],
    };

    restoreSession(createPlatform(saved));

    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith('pane-a', {
      cwd: 'C:\\repo',
      title: 'Pane A',
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'],
      untouched: false,
      resumeCommand: null,
    });
  });

  it('seeds restored untouched state', () => {
    const saved: PersistedSession = {
      version: 3,
      panes: [
        { id: 'pane-a', title: 'Pane A', cwd: null, untouched: true },
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
      lathLayout: {
        version: 1,
        tree: { root: { kind: 'split', dir: 'row', children: [
          { node: { kind: 'leaf', id: 'pane-term' }, weight: 0.5 },
          { node: { kind: 'leaf', id: 'pane-web' }, weight: 0.5 },
        ] } },
        leafMeta: {
          'pane-term': { component: 'terminal', tabComponent: 'terminal', title: 'Terminal' },
          'pane-web': { component: 'browser', tabComponent: 'terminal', title: 'localhost', params: { renderMode: 'iframe', url: 'http://localhost:5173' } },
        },
      },
      panes: [
        { id: 'pane-term', title: 'Terminal', cwd: null, untouched: false },
        { id: 'pane-web', title: 'localhost', cwd: null, untouched: false, surfaceType: 'browser' },
      ],
    };

    const result = restoreSession(createPlatform(saved));

    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledTimes(1);
    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith('pane-term', expect.objectContaining({ title: 'Terminal' }));
    // The browser pane stays in paneIds so the layout blob recreates and selects it.
    expect(result?.paneIds).toEqual(['pane-term', 'pane-web']);
  });

  it('respawns a restored tool command with integration gating', () => {
    const saved: PersistedSession = {
      version: 3,
      panes: [{
        id: 'pane-tool',
        title: 'storybook',
        cwd: '/repo',
        untouched: true,
        surfaceType: 'tool',
        command: 'pnpm storybook',
        tool: { name: 'storybook', render: 'iframe', port: 'announced' },
      }],
    };

    restoreSession(createPlatform(saved, { 'pane-tool': 'claude --resume should-not-win' }));

    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith('pane-tool', expect.objectContaining({
      command: 'pnpm storybook',
      requireIntegration: true,
      resumeCommand: null,
    }));
  });

  it.each([
    { shell: '/bin/bash', oldCommand: "& 'program path' 'it''s.txt'", command: "'program path' 'it'\\''s.txt'" },
    { shell: 'pwsh.exe', oldCommand: "'program path' 'it'\\''s.txt'", command: "& 'program path' 'it''s.txt'" },
  ])('re-quotes a Tool from another shell for cold restore with $shell', ({ shell, oldCommand, command }) => {
    terminalRegistryMocks.getDefaultShellOpts.mockReturnValue({ shell });
    const argv = ['program path', "it's.txt"];
    for (const placement of ['layout', 'fallback', 'door']) {
      const saved: PersistedSession = {
        version: 3,
        panes: [{ id: 'tool', title: 'Viewer', cwd: '/repo', untouched: false, surfaceType: 'tool', command: oldCommand,
          tool: { render: 'iframe', port: 'announced', argv } }],
        ...(placement === 'layout' ? { lathLayout: {
          version: 1, tree: { root: { kind: 'leaf', id: 'tool' } },
          leafMeta: { tool: { component: 'tool', tabComponent: 'tool', title: 'Viewer', params: { surfaceType: 'tool', command: oldCommand, toolArgv: argv } } },
        } } : {}),
        ...(placement === 'door' ? { doors: [{ id: 'tool', title: 'Viewer', component: 'tool', params: { surfaceType: 'tool', command: oldCommand, toolArgv: argv } }] } : {}),
      };
      const before = JSON.stringify(saved);
      const result = restoreSession(createPlatform(saved));
      expect(terminalRegistryMocks.restoreTerminal).toHaveBeenLastCalledWith('tool', expect.objectContaining({ shell, command, requireIntegration: true }));
      const params = placement === 'door' ? result?.doors[0].params : result?.lathLayout?.leafMeta.tool.params;
      expect(params).toMatchObject({ command, toolArgv: argv });
      expect(JSON.stringify(saved)).toBe(before); // rebuilding must not change the durable record
    }
  });

  it('retains literal shell commands when the selected restore shell changes', () => {
    terminalRegistryMocks.getDefaultShellOpts.mockReturnValue({ shell: 'pwsh.exe' });
    const command = 'echo "$HOME" | cat';
    restoreSession(createPlatform({ version: 3, panes: [{ id: 'tool', title: 'Literal', cwd: '/repo', untouched: false, surfaceType: 'tool', command }] }));
    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith('tool', expect.objectContaining({ command, shell: 'pwsh.exe' }));
  });

  it.each(['\t', '\n', '\r', '\x1b'])('rejects control-bearing saved Tool argv before any terminal is restored (%j)', control => {
    const saved: PersistedSession = { version: 3, panes: [{ id: 'tool', title: 'Unsafe', cwd: '/repo', untouched: false, surfaceType: 'tool', command: 'safe fallback',
      tool: { render: 'iframe', port: 'announced', argv: ['program', `file${control}command`] } }] };
    expect(restoreSession(createPlatform(saved))).toBeNull();
    expect(restoreSession(createPlatform(null), { savedSession: saved })).toBeNull();
    expect(terminalRegistryMocks.restoreTerminal).not.toHaveBeenCalled();
  });

  it.each([undefined, { version: 1 }, {
    version: 1,
    tree: { root: { kind: 'leaf', id: 'stale-pane' } },
    leafMeta: { 'stale-pane': { component: 'terminal', tabComponent: 'terminal', title: 'Stale' } },
  }])('omits visible browsers from terminal fallback for an unusable layout: %j', (lathLayout) => {
    const doors = [{ id: 'door-web', title: 'Browser door', component: 'browser', params: { renderMode: 'iframe', url: 'http://localhost:5173' } }];
    const result = restoreSession(createPlatform({
      version: 3,
      lathLayout,
      doors,
      panes: [
        { id: 'pane-term', title: 'Terminal', cwd: null, untouched: false },
        { id: 'pane-web', title: 'Browser', cwd: null, untouched: false, surfaceType: 'browser' },
        { id: 'door-web', title: 'Browser door', cwd: null, untouched: false, surfaceType: 'browser' },
      ],
    }));

    expect(result).toMatchObject({ paneIds: ['pane-term'], lathLayout: undefined, doors });
    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledTimes(1);
    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith('pane-term', expect.anything());
  });

  it('passes the native lathLayout through untouched', () => {
    const lathLayout = {
      version: 1 as const,
      tree: { root: { kind: 'leaf' as const, id: 'pane-a' } },
      leafMeta: { 'pane-a': { component: 'terminal', tabComponent: 'terminal', title: 'A' } },
    };
    const saved: PersistedSession = {
      version: 3,
      lathLayout,
      panes: [
        { id: 'pane-a', title: 'A', cwd: null, untouched: false },
      ],
    };

    const result = restoreSession(createPlatform(saved));

    expect(result?.lathLayout).toEqual(lathLayout);
  });

  it('restores workspace-scoped dor surface refs and the next-ref counter', () => {
    const saved: PersistedSession = {
      version: 3,
      surfaceRefs: { 'pane-a': 'surface:1', 'closed-pane': 'surface:2' },
      surfaceRefsNext: 9,
      panes: [
        { id: 'pane-a', title: 'A', cwd: null, untouched: false },
      ],
    };

    const result = restoreSession(createPlatform(saved));

    expect(result?.surfaceRefs).toEqual({ 'pane-a': 'surface:1', 'closed-pane': 'surface:2' });
    expect(result?.surfaceRefsNext).toBe(9);
  });

  it('discards a malformed next-ref counter without rejecting the session', () => {
    const saved = {
      version: 3,
      surfaceRefs: { 'pane-a': 'surface:1' },
      surfaceRefsNext: 0,
      panes: [
        { id: 'pane-a', title: 'A', cwd: null, untouched: false },
      ],
    } as unknown as PersistedSession;

    const result = restoreSession(createPlatform(saved));

    expect(result?.surfaceRefs).toEqual({ 'pane-a': 'surface:1' });
    expect(result?.surfaceRefsNext).toBeUndefined();
  });

  it('discards malformed dor surface refs without rejecting the session', () => {
    const saved = {
      version: 3,
      surfaceRefs: { 'pane-a': 'pane:1', 'pane-b': 'surface:2' },
      panes: [
        { id: 'pane-a', title: 'A', cwd: null, untouched: false },
      ],
    } as unknown as PersistedSession;

    const result = restoreSession(createPlatform(saved));

    expect(result?.surfaceRefs).toEqual({ 'pane-b': 'surface:2' });
  });

  it('restores browser surface TODO from the persisted alert during cold restore', () => {
    const saved: PersistedSession = {
      version: 3,
      panes: [
        {
          id: 'pane-web',
          title: 'localhost',
          cwd: null,
          untouched: false,
          surfaceType: 'browser',
          alert: { status: 'WATCHING_DISABLED', watchingEnabled: false, todo: true, notification: null },
        },
      ],
    };

    restoreSession(createPlatform(saved));

    expect(terminalRegistryMocks.restoreTerminal).not.toHaveBeenCalled();
    // Cold restore delegates the browser pane to restoreBrowserSurfaceTodo, which
    // owns routing the persisted TODO into the local activity store (verified
    // against the real store in terminal-registry.alert.test.ts).
    expect(terminalRegistryMocks.restoreBrowserSurfaceTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pane-web',
        surfaceType: 'browser',
        alert: expect.objectContaining({ todo: true }),
      }),
    );
  });
});


it('recovers Tool metadata from pane rows when its layout is unusable', () => {
  const restored = restoreSession(createPlatform({ version: 3, panes: [
    { id: 'tool', title: 'Storybook', cwd: '/repo', untouched: false, surfaceType: 'tool', command: 'pnpm storybook', tool: { render: 'iframe', port: 'auto', name: 'storybook', key: ['storybook', '/repo'] } },
    { id: 'web', title: 'Web', cwd: null, untouched: false, surfaceType: 'browser' },
  ] }));
  expect(restored?.paneIds).toEqual(['tool']);
  expect(restored?.lathLayout?.leafMeta.tool).toMatchObject({ component: 'tool', tabComponent: 'tool', params: { command: 'pnpm storybook', toolRender: 'iframe', toolPort: 'auto', toolName: 'storybook' } });
  expect(restored?.lathLayout?.leafMeta.tool.params?.url).toBeUndefined();
});

describe('restoreSession alert seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const alert = { status: 'WATCHING_DISABLED' as const, todo: true, notification: null };

  /** What each restored terminal's spawn will carry as its persisted alert. */
  const spawnedAlerts = () => terminalRegistryMocks.restoreTerminal.mock.calls
    .map(([id, options]) => [id, (options as { alert?: unknown }).alert]);

  it('spawns a terminal pane with its persisted TODO and leaves browser panes to the todo restore', () => {
    const saved: PersistedSession = {
      version: 3,
      panes: [
        { id: 'shell', title: 'Shell', cwd: '/tmp', untouched: false, alert },
        { id: 'quiet', title: 'Quiet', cwd: '/tmp', untouched: false },
        { id: 'web', title: 'Web', cwd: null, untouched: false, surfaceType: 'browser', alert },
      ],
    };
    const platform = createPlatform(saved);

    restoreSession(platform);

    // Only the terminal pane that carried one, and only that pane's blob: the
    // host seeds it at the spawn.
    expect(spawnedAlerts()).toEqual([['shell', alert], ['quiet', undefined]]);
  });

  it('keeps a pane whose notification this build cannot read, seeding its TODO without the detail', () => {
    const saved = {
      version: 3,
      panes: [
        {
          id: 'newer',
          title: 'Newer',
          cwd: '/tmp',
          untouched: false,
          alert: { status: 'ALERT_RINGING', todo: true, notification: { source: 'FROM_A_NEWER_BUILD', title: 'x', body: null } },
        },
      ],
    } as unknown as PersistedSession;
    const platform = createPlatform(saved);

    expect(restoreSession(platform)?.paneIds).toEqual(['newer']);
    expect(spawnedAlerts()).toEqual([['newer', { status: 'ALERT_RINGING', todo: true, notification: null }]]);
  });

  it('restores the record it is handed with the commands it is handed', () => {
    const given: PersistedSession = {
      version: 3,
      panes: [{ id: 'given', title: 'Given', cwd: '/w', untouched: false }],
    };
    const platform = createPlatform(
      { version: 3, panes: [{ id: 'slot', title: 'Slot', cwd: null, untouched: false }] },
      { given: 'claude --resume xyz' },
    );

    const result = restoreSession(platform, { savedSession: given });

    expect(result?.paneIds).toEqual(['given']);
    expect(terminalRegistryMocks.restoreTerminal).toHaveBeenCalledWith(
      'given', expect.objectContaining({ cwd: '/w', resumeCommand: 'claude --resume xyz' }),
    );
    // An explicit `null` is "no record", never a fallback to the slot.
    expect(restoreSession(platform, { savedSession: null })).toBeNull();
  });
});
