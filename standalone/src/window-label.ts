/**
 * Which window this webview is, resolved once at boot.
 *
 * The Tauri label is a Window's persistence identity (`docs/specs/glossary.md`),
 * and `main` is the only window granted the updater permissions
 * (`docs/specs/auto-update.md`), so several modules need the answer
 * synchronously after boot. The browser-dev harness has no windows at all and
 * answers `main`.
 */

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

/** The window the quit walk tears down last, and the only one that may install
 *  an update or check for one. */
export function isMainWindow(): boolean {
  return label === MAIN_WINDOW_LABEL;
}

/** @internal Set the label directly (tests). */
export function _setWindowLabelForTesting(next: string): void {
  label = next;
}
