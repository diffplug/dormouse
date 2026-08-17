import { describe, expect, it } from 'vitest';
import { readPersistedSession, withRecoveryCommands, type PersistedPane } from './session-types';

const session = (panes: Array<Partial<PersistedPane> & { id: string }>) => ({
  version: 3 as const,
  panes: panes.map((pane) => ({
    cwd: null,
    title: pane.id,
    resumeCommand: null,
    untouched: false,
    ...pane,
  })),
});

describe('withRecoveryCommands', () => {
  it('takes the recovery command from the host, everything else from the webview', () => {
    // The regression this exists for: VS Code persists the webview's own
    // vscode.setState() copy across a window reload, and that copy's last write
    // predates the teardown that captured the command — so preferring it
    // wholesale silently dropped every resume on exactly the reload it exists for.
    const webview = session([{ id: 'pane-a', cwd: '/live/cwd', title: 'Fresh title' }]);
    const host = session([{ id: 'pane-a', cwd: '/stale', title: 'Stale', resumeCommand: 'claude --resume abc' }]);

    const merged = readPersistedSession(withRecoveryCommands(webview, host))!;

    expect(merged.panes[0]).toMatchObject({
      cwd: '/live/cwd',
      title: 'Fresh title',
      resumeCommand: 'claude --resume abc',
    });
  });

  it('leaves the webview snapshot alone when the host captured nothing', () => {
    const webview = session([{ id: 'pane-a', cwd: '/live' }]);
    expect(withRecoveryCommands(webview, session([{ id: 'pane-a' }]))).toBe(webview);
  });

  it('only overlays panes the host actually captured', () => {
    const webview = session([{ id: 'pane-a' }, { id: 'pane-b' }]);
    const host = session([{ id: 'pane-a', resumeCommand: 'codex resume 01JC' }, { id: 'pane-b' }]);

    const merged = readPersistedSession(withRecoveryCommands(webview, host))!;

    expect(merged.panes[0].resumeCommand).toBe('codex resume 01JC');
    expect(merged.panes[1].resumeCommand).toBeNull();
  });

  it('falls back to the host snapshot when there is no readable webview copy', () => {
    const host = session([{ id: 'pane-a', resumeCommand: 'claude --continue' }]);
    expect(withRecoveryCommands(null, host)).toBe(host);
  });

  it('reads a JSON-stringified host blob, which is how VS Code hands state back', () => {
    const webview = session([{ id: 'pane-a' }]);
    const host = JSON.stringify(session([{ id: 'pane-a', resumeCommand: 'claude --resume xyz' }]));

    const merged = readPersistedSession(withRecoveryCommands(webview, host))!;

    expect(merged.panes[0].resumeCommand).toBe('claude --resume xyz');
  });
});
