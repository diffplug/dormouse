/**
 * Theme boot for the Pocket shell. The whole app — auth screens included —
 * runs on the shared `--vscode-*` token system (lib/src/theme.css;
 * docs/specs/theme.md), so the theme must be restored before first paint,
 * before any `--vscode-*` vars exist on body.
 *
 * The theme restoration never runs at module import time on purpose: Storybook
 * imports these modules and manages its own themes.
 */

import { getAppliedThemeSnapshot, restoreActiveTheme, useRestoredTheme } from '../../lib/themes';

/** Same default theme the website playground restores, unless the user picked one. */
export const POCKET_THEME_ID = 'vscode.theme-kimbie-dark.kimbie-dark';

export function restorePocketTheme(): void {
  const theme = restoreActiveTheme(POCKET_THEME_ID);
  if (!theme || typeof document === 'undefined') return;
  // Browser chrome outside the body: form-control palette and the
  // address-bar / status-bar tint follow the applied theme.
  document.documentElement.style.colorScheme = theme.type;
  const appBg = getAppliedThemeSnapshot()?.resolvedVars['--vscode-sideBar-background'];
  const meta = document.querySelector('meta[name="theme-color"]');
  if (appBg && meta) meta.setAttribute('content', appBg);
}

export function usePocketTheme() {
  useRestoredTheme(POCKET_THEME_ID, restorePocketTheme);
}
