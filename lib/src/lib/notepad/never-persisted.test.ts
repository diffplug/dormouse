/**
 * @vitest-environment jsdom
 *
 * Live notes are absent from every existing session-persistence format
 * (docs/specs/notepad.md). This is the guard for that rule rather than a test of
 * any one module: it drives the real save path with notes on a pane and on a
 * Door, and asserts the note text reaches none of the blobs — the persisted
 * Session, the Lath layout inside it, the key/value round trip a host stores,
 * or the standalone Window wrapper. The volatile mirror is the single exception,
 * and it is host memory, never disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../platform';
import { setWorkspacesEnabled } from '../feature-flags';
import { saveSession } from '../session-save';
import { readPersistedSession, type PersistedDoor } from '../session-types';
import { saveSessionState, storedValueForSession } from '../window-persistence';
import { addPlainNote, addTerminalNote, buildVolatileSnapshot, clearAllNotepads } from './notepad-store';

/** Distinctive enough that a substring hit anywhere is a real leak. */
const SECRET = 'AKIA-NOTE-SECRET-9f3';

const DOOR: PersistedDoor = { id: 'door-b', title: 'zsh', component: 'terminal' };

const LATH_LAYOUT = {
  version: 1 as const,
  tree: { root: { kind: 'leaf' as const, id: 'pane-a' } },
  leafMeta: {
    'pane-a': { component: 'terminal', tabComponent: 'terminal', title: 'Pane A' },
    'door-b': { component: 'terminal', tabComponent: 'terminal', title: 'zsh' },
  },
};

let adapter: FakePtyAdapter;

beforeEach(() => {
  clearAllNotepads();
  adapter = new FakePtyAdapter();
  setPlatform(adapter);
});

afterEach(() => {
  clearAllNotepads();
  setWorkspacesEnabled(false);
});

describe('live notes are never persisted', () => {
  it('keeps note text out of every session blob a host stores', async () => {
    addPlainNote('pane-a', SECRET);
    addTerminalNote('pane-a', [{ text: `${SECRET} rich`, bold: true }]);
    addPlainNote('door-b', `${SECRET} minimized`);

    await saveSession(
      adapter,
      [{ id: 'pane-a', title: 'Pane A' }],
      [DOOR],
      LATH_LAYOUT,
      { 'pane-a': 'surface:1', 'door-b': 'surface:2' },
      3,
    );

    // The save really happened — otherwise "no note text" would be vacuous.
    const saved = readPersistedSession(adapter.getState());
    expect(saved?.panes.map((pane) => pane.id).sort()).toEqual(['door-b', 'pane-a']);
    expect(JSON.stringify(saved)).not.toContain(SECRET);

    // The key/value round trip below the save (localStorage, the Tauri-backed
    // session store) carries only what the projection produced.
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveSessionState(storage, 'dormouse.session', saved);
    expect(store.get('dormouse.session')).not.toContain(SECRET);

    // The standalone Window wrapper (workspaces flag on) re-nests the same
    // Session, so it inherits the property rather than reintroducing notes.
    setWorkspacesEnabled(true);
    expect(JSON.stringify(storedValueForSession(null, saved))).not.toContain(SECRET);

    // The one place the notes do live outside the store: host memory, cleared on
    // restart and never written to disk.
    expect(JSON.stringify(buildVolatileSnapshot())).toContain(SECRET);
  });
});
