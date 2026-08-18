import { setDefaultShellOpts } from './shell-defaults';

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

/** One detected shell. The canonical shape every adapter's
 *  `getAvailableShells()` returns. */
export interface ShellEntry {
  name: string;
  path: string;
  args?: string[];
}

export interface ShellsState {
  shells: ShellEntry[];
  selected: ShellEntry | undefined;
}

function getStorage(): Storage | null {
  const storage = globalThis.localStorage;
  if (
    typeof storage?.getItem !== 'function' ||
    typeof storage?.setItem !== 'function' ||
    typeof storage?.removeItem !== 'function'
  ) {
    return null;
  }
  return storage;
}

function emptyState(): ShellsState {
  return { shells: [], selected: undefined };
}

let state: ShellsState = emptyState();
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
 */
export function seedShellStore(shells: ShellEntry[]): void {
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

/** Empty the store (tests / Storybook — module state outlives components). */
export function resetShellStore(): void {
  emit(emptyState());
}
