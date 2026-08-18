import { setDefaultShellOpts, type ShellEntry } from './shell-defaults';
import { getStorage, loadJson, saveJson } from './local-json-store';

/**
 * The Window's detected shells and which one is selected, for the Settings
 * dialog's Shell row (`ShellPicker`). Selection is persisted under
 * `dormouse:selected-shell` as the executable path plus ordered arguments.
 * Names are display-only, while paths alone collide for WSL distributions and
 * Windows Developer shells.
 *
 * Only standalone seeds this store, and only from `main.tsx` *before* the Wall
 * mounts, so the first restored pane already spawns with the persisted shell
 * (`getDefaultShellOpts` readers run at mount). VS Code keeps its own native
 * QuickPick and pushes `setDefaultShellOpts` directly, so it never seeds here
 * and its Shell row is hidden by `hostOwnsShells`; hosts that detect no shells
 * (remote/Pocket) leave the store empty and the row hidden.
 */

const SELECTED_KEY = 'dormouse:selected-shell';

const isString = (value: unknown): value is string => typeof value === 'string';

interface PersistedShellIdentity {
  path: string;
  args: string[];
}

type StoredShellSelection = PersistedShellIdentity | string;

/** Accept the current identity object and the legacy path-only string. */
function isStoredShellSelection(value: unknown): value is StoredShellSelection {
  if (isString(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PersistedShellIdentity>;
  return isString(candidate.path)
    && Array.isArray(candidate.args)
    && candidate.args.every(isString);
}

type ShellIdentity = Pick<ShellEntry, 'path' | 'args'>;

/** Paths are not unique on Windows: arguments distinguish WSL distributions
 *  and Developer shells that share one executable. */
export function shellIdentityEquals(
  left: ShellIdentity | undefined,
  right: ShellIdentity | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.path !== right.path) return false;
  const leftArgs = left.args ?? [];
  const rightArgs = right.args ?? [];
  return leftArgs.length === rightArgs.length
    && leftArgs.every((arg, index) => arg === rightArgs[index]);
}

/** Stable identity for keyed rendering; see `shellIdentityEquals`. */
export function shellIdentityKey(shell: ShellIdentity): string {
  return JSON.stringify([shell.path, shell.args ?? []]);
}

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
 * to the first detected shell when the saved identity is gone.
 *
 * Seeding deliberately does **not** write the key back: a shell that is
 * temporarily missing (a version bump mid-reinstall) recovers its selection
 * once it returns, rather than being silently replaced by the fallback. Only
 * `selectShell` writes.
 *
 * An empty list empties the store, which is what `resetShellStore` is — it
 * unpublishes the default and touches storage not at all, since there is no
 * selection to restore. Emptying an already-empty store is skipped outright:
 * Storybook resets every story, and a notification with nothing behind it only
 * churns subscribers.
 */
export function seedShellStore(shells: ShellEntry[]): void {
  if (shells.length === 0) {
    if (state.shells.length === 0) return;
    publishSelected(undefined);
    emit({ shells: [], selected: undefined });
    return;
  }
  const saved = loadJson<StoredShellSelection, null>(
    SELECTED_KEY,
    null,
    isStoredShellSelection,
  );
  // Path-only values were written before arguments became part of identity.
  const selected = (typeof saved === 'string'
    ? shells.find((shell) => shell.path === saved)
    : shells.find((shell) => shellIdentityEquals(shell, saved ?? undefined)))
    ?? shells[0];
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
  if (shellIdentityEquals(shell, state.selected)) return;
  saveJson(SELECTED_KEY, { path: shell.path, args: shell.args ?? [] });
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

/**
 * Forget the persisted selection, so the next seed starts from nothing.
 *
 * Storybook's only caller: `localStorage` is shared by every story, so a story
 * that names its shells would otherwise inherit whichever one an earlier story
 * selected. Emptying the store (above) deliberately leaves the key alone.
 */
export function clearPersistedShellSelection(): void {
  getStorage()?.removeItem(SELECTED_KEY);
}
