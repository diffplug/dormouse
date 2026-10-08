import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSISTED_SESSION_VERSION,
  PERSISTED_WINDOW_VERSION,
  readPersistedSession,
  readPersistedWindow,
} from './session-types';

const panes = [{ id: 'surface-1', title: 'A', cwd: null, untouched: false }];

describe('persisted format versions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('matches the format the standalone Rust host keeps and discards by', () => {
    // standalone/src-tauri/src/lib.rs pins the same file.
    const pinned = JSON.parse(readFileSync(new URL('../../../standalone/scripts/persisted-format.json', import.meta.url), 'utf8'));
    expect(pinned).toEqual({ window: PERSISTED_WINDOW_VERSION, session: PERSISTED_SESSION_VERSION });
  });

  it('reads only the current Session version, discarding any other quietly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(readPersistedSession({ version: 4, panes })?.panes.map((pane) => pane.id)).toEqual(['surface-1']);
    // VS Code hands state back JSON-stringified.
    expect(readPersistedSession(JSON.stringify({ version: 4, panes }))?.panes).toEqual(panes);
    expect(readPersistedSession({ version: 3, panes })).toBeNull();
    expect(readPersistedSession(JSON.stringify({ version: 5, panes }))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('reads only the current Window version, discarding any other quietly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const window = { activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'W', nameIsAuto: false, session: { version: 4, panes } }] };
    expect(readPersistedWindow({ ...window, version: 2 })?.workspaces).toHaveLength(1);
    expect(readPersistedWindow({ ...window, version: 1 })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('keeps the mark a window close leaves for Reopen, and adds none', () => {
    const window = { version: 2, activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'W', nameIsAuto: false, session: { version: 4, panes } }] };
    expect(readPersistedWindow({ ...window, reopened: true })?.reopened).toBe(true);
    expect(readPersistedWindow(window)).not.toHaveProperty('reopened');
  });

  it('rejects a current Session with a pane missing `untouched`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readPersistedSession({ version: 4, panes: [{ id: 'surface-1', title: 'A', cwd: null }] })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still warns on a blob with no version at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readPersistedSession({ panes })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
