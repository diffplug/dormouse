/**
 * Theme boot for the Pocket shell. The whole app — auth screens included —
 * runs on the shared `--vscode-*` token system (lib/src/theme.css;
 * docs/specs/theme.md), so the theme must be restored before first paint,
 * before any `--vscode-*` vars exist on body.
 *
 * The theme restoration never runs at module import time on purpose: Storybook
 * imports these modules and manages its own themes.
 */

import {
  applyTheme,
  getAppliedThemeSnapshot,
  getBundledThemes,
  restoreActiveTheme,
  setDefaultThemeId,
  useRestoredTheme,
  type DormouseTheme,
} from '../../lib/themes';

/** Same default theme the website playground restores, unless the user picked one. */
export const POCKET_THEME_ID = 'vscode.theme-kimbie-dark.kimbie-dark';

export function restorePocketTheme(): void {
  // Reached straight from `main.tsx` as well as through `useRestoredTheme`, so
  // it declares the fallback rather than assuming the hook ran first.
  setDefaultThemeId(POCKET_THEME_ID);
  const theme = restoreActiveTheme();
  if (theme) syncDocumentChrome(theme);
}

/**
 * Pocket's default theme for a page that keeps nothing — the one-time page
 * (`docs/specs/one-time.md` -> "Phone page"): applied and synced as
 * {@link restorePocketTheme} does it, but from the bundled set alone, with no
 * stored pick read and no active theme written back.
 */
export function applyPocketTheme(): void {
  const theme = getBundledThemes().find(({ id }) => id === POCKET_THEME_ID);
  if (!theme || typeof document === 'undefined') return;
  applyTheme(theme);
  syncDocumentChrome(theme);
}

/**
 * Browser chrome outside the body: the form-control palette and the address-bar
 * / status-bar tint follow the applied theme.
 */
function syncDocumentChrome(theme: DormouseTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.colorScheme = theme.type;
  const appBg = getAppliedThemeSnapshot()?.resolvedVars['--vscode-sideBar-background'];
  const meta = document.querySelector('meta[name="theme-color"]');
  if (appBg && meta) meta.setAttribute('content', appBg);
}

/** Restore the theme before first paint and after commit; `restore` picks how. */
export function usePocketTheme(restore: () => void = restorePocketTheme) {
  useRestoredTheme(POCKET_THEME_ID, restore);
}
