import { useCallback, useState } from 'react';
import {
  applyTheme,
  getAllThemes,
  getAppliedThemeSnapshot,
  getBundledThemes,
  removeInstalledTheme,
  restoreActiveTheme,
  setActiveThemeId,
  type DormouseTheme,
} from '../../lib/themes';
import { useBrowserLayoutEffect } from '../../lib/use-browser-layout-effect';

/**
 * The theme list and the pick every picker placement shares. Without `persist`
 * (the one-time page, which keeps nothing) only bundled themes are offered and
 * a pick holds for this page alone.
 */
export function useThemeChoice(persist = true) {
  // The server and first client render must agree. Installed themes and the
  // active id come from browser storage, so reading either here leaves React
  // with an attribute mismatch it deliberately will not patch during hydration.
  // `getBundledThemes` is the same module array every call, so both initializers
  // are stable without a ref to latch them.
  const [themes, setThemes] = useState(getBundledThemes);
  const [activeId, setActiveId] = useState(() => themes[0]?.id ?? '');

  const refresh = useCallback(() => {
    if (!persist) {
      const applied = getAppliedThemeSnapshot()?.theme.id;
      if (applied) setActiveId(applied);
      return;
    }
    setThemes(getAllThemes());
    const theme = restoreActiveTheme();
    if (theme) setActiveId(theme.id);
  }, [persist]);

  // Hosts restore the visible body theme at boot. The picker separately
  // reconciles its stored rows and selected value after hydration so its first
  // markup stays deterministic without leaving its label or swatch stale.
  useBrowserLayoutEffect(refresh, [refresh]);

  const select = (id: string): DormouseTheme | undefined => {
    const theme = themes.find((candidate) => candidate.id === id);
    if (!theme) return undefined;
    if (persist) setActiveThemeId(id);
    setActiveId(id);
    applyTheme(theme);
    return theme;
  };

  const uninstall = (theme: DormouseTheme) => {
    if (!persist || theme.origin.kind !== 'installed') return;
    removeInstalledTheme(theme.id);
    // Re-resolves the active theme through the host default, which is what
    // uninstalling the *active* theme needs; a no-op re-apply otherwise.
    refresh();
  };

  return { themes, activeId, select, uninstall, refresh };
}
