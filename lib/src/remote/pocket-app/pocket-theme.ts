/**
 * Theme boot for the Pocket shell. The whole app — auth screens included —
 * runs on the shared `--vscode-*` token system (lib/src/theme.css;
 * docs/specs/theme.md), so the theme must be restored before first paint,
 * before any `--vscode-*` vars exist on body.
 *
 * The theme restoration never runs at module import time on purpose: Storybook
 * imports these modules and manages its own themes.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { getAppliedThemeSnapshot, restoreActiveTheme } from '../../lib/themes';

/** Same default theme the website playground restores, unless the user picked one. */
export const POCKET_THEME_ID = 'vscode.theme-kimbie-dark.kimbie-dark';

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restorePocketTheme();
    restoredRef.current = true;
  }
  // Repeat after hydration so the wall/auth views read real theme variables
  // even if React reconciled away render-time body styles.
  useBrowserLayoutEffect(() => {
    restorePocketTheme();
  }, []);
}
