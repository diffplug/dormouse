/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageStub } from './test-local-storage';
import { getDefaultShellOpts, setDefaultShellOpts } from './shell-defaults';
import { getShellsSnapshot, resetShellStore, seedShellStore, selectShell } from './shell-store';

const SELECTED_KEY = 'dormouse:selected-shell';

const ZSH = { name: 'zsh', path: '/bin/zsh' };
const BASH = { name: 'bash', path: '/bin/bash', args: ['-l'] };
const SHELLS = [ZSH, BASH];

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
    // Module state, so it outlives the test that wrote it.
    resetShellStore();
    setDefaultShellOpts(null);
    vi.unstubAllGlobals();
  });

  it('restores the saved selection by path', () => {
    localStorage.setItem(SELECTED_KEY, BASH.path);

    seedShellStore(SHELLS);

    expect(getShellsSnapshot().selected).toEqual(BASH);
    expect(getDefaultShellOpts()).toEqual({ shell: BASH.path, args: BASH.args });
  });

  it('falls back to the first shell when the saved path is gone, without overwriting it', () => {
    // The saved shell is mid-reinstall, or this machine never had it.
    localStorage.setItem(SELECTED_KEY, '/opt/homebrew/bin/fish');

    seedShellStore(SHELLS);

    expect(getShellsSnapshot().selected).toEqual(ZSH);
    expect(getDefaultShellOpts()).toEqual({ shell: ZSH.path, args: undefined });
    // Seeding must not write the key back: the selection recovers on its own
    // once the shell reappears.
    expect(localStorage.getItem(SELECTED_KEY)).toBe('/opt/homebrew/bin/fish');
  });

  it('persists a selection, republishes the default, and asks for a terminal', () => {
    seedShellStore(SHELLS);

    selectShell(BASH);

    expect(localStorage.getItem(SELECTED_KEY)).toBe(BASH.path);
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

  it('ignores re-selecting the shell already in use', () => {
    seedShellStore(SHELLS);
    localStorage.removeItem(SELECTED_KEY);

    // Same path, different object: identity must not be the test.
    selectShell({ ...ZSH });

    expect(spawns).toEqual([]);
    expect(localStorage.getItem(SELECTED_KEY)).toBeNull();
  });
});
