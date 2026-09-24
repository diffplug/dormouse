import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WATCHED_COMMANDS } from './coding-agents';

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertSetWatchedCommands: vi.fn(), alertSetCommandWatched: vi.fn() }),
}));

const KEY = 'dormouse:watched-commands';
let saved: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  saved = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('fresh watch preferences', () => {
  it('seeds absent preferences from the agent registry', async () => {
    const store = await import('./watched-commands');
    expect(store.getWatchedCommands()).toEqual(DEFAULT_WATCHED_COMMANDS);
  });

  it.each(['[]', '["npm test"]', 'invalid', '{}', ''])('preserves saved preferences: %s', async (raw) => {
    saved.set(KEY, raw);
    const store = await import('./watched-commands');
    expect(store.getWatchedCommands()).toEqual(raw === '["npm test"]' ? ['npm test'] : []);
  });

  it('persists removing every default through a reload', async () => {
    const store = await import('./watched-commands');
    for (const command of DEFAULT_WATCHED_COMMANDS) store.setCommandWatched(command, false);
    vi.resetModules();
    expect((await import('./watched-commands')).getWatchedCommands()).toEqual([]);
  });

  it('replaces fresh defaults with the authoritative host preferences', async () => {
    const store = await import('./watched-commands');
    store.applyWatchedCommandsFromHost(['npm test']);
    vi.resetModules();
    expect((await import('./watched-commands')).getWatchedCommands()).toEqual(['npm test']);
  });
});
