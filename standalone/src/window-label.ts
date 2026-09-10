/**
 * Which window this webview is, resolved once at boot.
 *
 * The Tauri label is a Window's persistence identity (`docs/specs/glossary.md`)
 * and the only window that runs the periodic update check is `main`
 * (`docs/specs/auto-update.md`), so several modules need the answer
 * synchronously after boot. The browser-dev harness has no windows at all and
 * answers `main`.
 */

import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

export const MAIN_WINDOW_LABEL = 'main';

let label = MAIN_WINDOW_LABEL;

/** Read the host's answer. Idempotent; called once from `bootstrap()`. */
export async function resolveWindowLabel(): Promise<string> {
  if (import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST) return label;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    label = getCurrentWindow().label;
  } catch (err) {
    console.error('[dormouse] could not resolve the window label; assuming main', err);
  }
  return label;
}

export function currentWindowLabel(): string {
  return label;
}

/** The window the quit walk tears down last while it is open, and the only one
 *  that runs the periodic update check. Installing is not gated on it: the walk
 *  ends with the most recently focused window when `main` has been closed. */
export function isMainWindow(): boolean {
  return label === MAIN_WINDOW_LABEL;
}

/** @internal Set the label directly (tests). */
export function _setWindowLabelForTesting(next: string): void {
  label = next;
}

/**
 * Listen for an event **addressed to this window**.
 *
 * Always this, never the bare `listen`: a listener registered with the default
 * `Any` target receives every event in the process, including the ones Rust
 * addressed to another window (`match_any_or_filter` in Tauri's event
 * listener). Every window would then take every other window's terminal
 * output, its `pty:list`, its Workspace arrivals and its teardown order — the
 * routing in `standalone/src-tauri/src/routing.rs` would be decoration.
 *
 * A broadcast still arrives: Rust emits those to `EventTarget::Any`, which is
 * delivered with no filter at all.
 */
export function listenToWindow<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, handler, { target: currentWindowLabel() });
}
