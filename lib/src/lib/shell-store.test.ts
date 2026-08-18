/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageStub } from './test-local-storage';
import { getDefaultShellOpts } from './shell-defaults';
import {
  clearPersistedShellSelection,
  getShellsSnapshot,
  resetShellStore,
  seedShellStore,
  selectShell,
} from './shell-store';

/** The one place the storage key is spelled out: it is a persistence contract,
 *  so a rename must be deliberate. Everything else goes through the store. */
const SELECTED_KEY = 'dormouse:selected-shell';

const ZSH = { name: 'zsh', path: '/bin/zsh' };
const BASH = { name: 'bash', path: '/bin/bash', args: ['-l'] };
const SHELLS = [ZSH, BASH];
/** Detected on the machine that saved the selection, missing on this one. */
const FISH = { name: 'fish', path: '/opt/homebrew/bin/fish' };
const WSL_PATH = 'C:\\Windows\\System32\\wsl.exe';
const UBUNTU = { name: 'Ubuntu', path: WSL_PATH, args: ['-d', 'Ubuntu'] };
const DEBIAN = { name: 'Debian', path: WSL_PATH, args: ['-d', 'Debian'] };

describe('shell store', () => {
  /** Every `dormouse:new-terminal` detail dispatched during a test. The store
   *  dispatches on `window`, which is how the Wall hears it. */
  let spawns: unknown[] = [];
  const onSpawn = (event: Event) => spawns.push((event as CustomEvent).detail);

  beforeEach(() => {
    installLocalStorageStub();
    spawns = [];
    window.addEventListener('dormouse:new-terminal', onSpawn);
  });

  afterEach(() => {
    window.removeEventListener('dormouse:new-terminal', onSpawn);
    // Module state, so it outlives the test that wrote it. Reset unpublishes the
    // default shell too, so there is nothing else to undo.
    resetShellStore();
    vi.unstubAllGlobals();
  });

  it('restores the saved selection by path and arguments', () => {
    // A previous run's selection, written the only way the app writes it.
    seedShellStore(SHELLS);
    selectShell(BASH);
    resetShellStore();

    seedShellStore(SHELLS);

    expect(getShellsSnapshot().selected).toEqual(BASH);
    expect(getDefaultShellOpts()).toEqual({ shell: BASH.path, args: BASH.args });
  });

  it('falls back to the first shell when the saved path is gone, without overwriting it', () => {
    // The saved shell is mid-reinstall, or this machine never had it.
    seedShellStore([ZSH, FISH]);
    selectShell(FISH);

    seedShellStore(SHELLS);

    expect(getShellsSnapshot().selected).toEqual(ZSH);
    expect(getDefaultShellOpts()).toEqual({ shell: ZSH.path, args: undefined });

    // Seeding must not write the key back: the selection recovers on its own
    // once the shell reappears.
    seedShellStore([ZSH, FISH]);
    expect(getShellsSnapshot().selected).toEqual(FISH);
  });

  it('persists a selection, republishes the default, and asks for a terminal', () => {
    seedShellStore(SHELLS);

    selectShell(BASH);

    // JSON-encoded, because the store persists through `local-json-store.ts`.
    expect(JSON.parse(localStorage.getItem(SELECTED_KEY)!)).toEqual({
      path: BASH.path,
      args: BASH.args,
    });
    expect(getShellsSnapshot().selected).toEqual(BASH);
    expect(getDefaultShellOpts()).toEqual({ shell: BASH.path, args: BASH.args });
    expect(spawns).toEqual([
      {
        shell: BASH.path,
        args: BASH.args,
        name: BASH.name,
        // The untouched-pane swap plus its "Switched to bash" notice.
        replaceUntouched: true,
        announce: true,
      },
    ]);
  });

  it('distinguishes and restores shells that share an executable path', () => {
    seedShellStore([UBUNTU, DEBIAN]);

    selectShell(DEBIAN);

    expect(getShellsSnapshot().selected).toEqual(DEBIAN);
    expect(getDefaultShellOpts()).toEqual({ shell: WSL_PATH, args: DEBIAN.args });
    expect(spawns).toEqual([
      {
        shell: WSL_PATH,
        args: DEBIAN.args,
        name: DEBIAN.name,
        replaceUntouched: true,
        announce: true,
      },
    ]);

    resetShellStore();
    seedShellStore([UBUNTU, DEBIAN]);
    expect(getShellsSnapshot().selected).toEqual(DEBIAN);
  });

  it('restores a legacy path-only selection', () => {
    localStorage.setItem(SELECTED_KEY, JSON.stringify(BASH.path));

    seedShellStore(SHELLS);

    expect(getShellsSnapshot().selected).toEqual(BASH);
  });

  it('unpublishes the default shell when the store is emptied', () => {
    seedShellStore(SHELLS);

    resetShellStore();

    expect(getShellsSnapshot().shells).toEqual([]);
    // A teardown that left this published leaked the shell into the next test.
    expect(getDefaultShellOpts()).toBeNull();
  });

  it('ignores re-selecting the shell already in use', () => {
    seedShellStore(SHELLS);
    clearPersistedShellSelection();

    // Same path and arguments, different object: reference identity must not
    // be the test.
    selectShell({ ...ZSH });

    expect(spawns).toEqual([]);
    expect(localStorage.getItem(SELECTED_KEY)).toBeNull();
  });
});
