import { setDefaultShellOpts, type ShellEntry } from './shell-defaults';
import { getStorage } from './safe-storage';

/**
 * The Window's detected shells and which one is selected, for the Settings
 * dialog's Shell row (`ShellPicker`). Selection is persisted under
 * `dormouse:selected-shell` (the path, not the name — names collide across
 * install locations).
 *
 * Only standalone seeds this store, and only from `main.tsx` *before* the Wall
 * mounts, so the first restored pane already spawns with the persisted shell
 * (`getDefaultShellOpts` readers run at mount). VS Code keeps its own native
 * QuickPick and pushes `setDefaultShellOpts` directly, so it never seeds here
 * and its Shell row is hidden by `hostOwnsShells`; hosts that detect no shells
 * (remote/Pocket) leave the store empty and the row hidden.
 */

const SELECTED_KEY = 'dormouse:selected-shell';

/** Lives in `shell-defaults.ts` — the dependency-free module the Node-side
 *  `PlatformAdapter` contract can also import — and is re-exported here so
 *  UI-side callers have one shell import. */
export type { ShellEntry } from './shell-defaults';

export interface ShellsState {
  shells: ShellEntry[];
  selected: ShellEntry | undefined;
}

let state: ShellsState = { shells: [], selected: undefined };
const listeners = new Set<() => void>();

function emit(next: ShellsState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeToShells(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot reference (changes only on mutation) for `useSyncExternalStore`. */
export function getShellsSnapshot(): ShellsState {
  return state;
}

/** Publish the selection so every spawn path without an explicit shell (splits,
 *  restores, `dor`) uses it. */
function publishSelected(selected: ShellEntry | undefined): void {
  setDefaultShellOpts(selected ? { shell: selected.path, args: selected.args } : null);
}

/**
 * Install the detected shells and restore the persisted selection, falling back
 * to the first detected shell when the saved path is gone.
 *
 * Seeding deliberately does **not** write the key back: a shell that is
 * temporarily missing (a version bump mid-reinstall) recovers its selection
 * once it returns, rather than being silently replaced by the fallback. Only
 * `selectShell` writes.
 *
 * An empty list empties the store, which is what `resetShellStore` is. Emptying
 * an already-empty store is skipped outright: Storybook resets every story, and
 * a notification with nothing behind it only churns subscribers.
 */
export function seedShellStore(shells: ShellEntry[]): void {
  if (shells.length === 0 && state.shells.length === 0) return;
  const savedPath = getStorage()?.getItem(SELECTED_KEY) ?? null;
  const selected = shells.find((shell) => shell.path === savedPath) ?? shells[0];
  publishSelected(selected);
  emit({ shells: [...shells], selected });
}

/**
 * Choose a shell: persist it, publish it as the default, and ask the Wall for a
 * terminal running it. `replaceUntouched` swaps an untouched pane in place
 * instead of splitting, and `announce` shows the "Switched to X" notice — the
 * same contract the VS Code QuickPick path uses (`docs/specs/layout.md`).
 *
 * The store dispatches rather than the picker so the behavior is reachable
 * without a rendered dialog.
 */
export function selectShell(shell: ShellEntry): void {
  if (shell.path === state.selected?.path) return;
  getStorage()?.setItem(SELECTED_KEY, shell.path);
  publishSelected(shell);
  emit({ ...state, selected: shell });
  window.dispatchEvent(
    new CustomEvent('dormouse:new-terminal', {
      detail: {
        shell: shell.path,
        args: shell.args,
        name: shell.name,
        replaceUntouched: true,
        announce: true,
      },
    }),
  );
}

/**
 * Empty the store (tests / Storybook — module state outlives components).
 *
 * Seeding nothing *is* emptying, so there is one code path: it also unpublishes
 * the default shell, which a teardown that only cleared the store used to leak
 * into the next test.
 */
export function resetShellStore(): void {
  seedShellStore([]);
}
