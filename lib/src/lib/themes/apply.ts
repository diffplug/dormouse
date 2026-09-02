import type { DormouseTheme } from './types';
import { getAllThemes, getStoredActiveThemeId, setActiveThemeId } from './store';
import { completeThemeVars } from './vscode-color-resolver';
import { flattenSelectionAlpha } from './flatten-alpha';

let appliedThemeSnapshot: AppliedThemeSnapshot | null = null;

const activeThemeListeners = new Set<() => void>();

/** Notify only when the applied theme id changes. Consumers needing initial
 * state must seed it separately; see docs/specs/theme.md. */
export function subscribeToActiveTheme(listener: () => void): () => void {
  activeThemeListeners.add(listener);
  return () => activeThemeListeners.delete(listener);
}

export interface AppliedThemeSnapshot {
  theme: DormouseTheme;
  providedVars: Record<string, string>;
  resolvedVars: Record<string, string>;
}

const HOST_TYPOGRAPHY_VARS: Record<string, string> = {
  '--vscode-font-size': '13px',
  '--vscode-editor-font-size': '13px',
  '--vscode-font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  '--vscode-editor-font-family':
    "'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
};

function hasVisibleTheme(snapshot: AppliedThemeSnapshot): boolean {
  const body = document.body;
  const expectedClass = snapshot.theme.type === 'light' ? 'vscode-light' : 'vscode-dark';
  if (!body.classList.contains(expectedClass)) return false;

  for (const [name, value] of Object.entries(snapshot.resolvedVars)) {
    if (body.style.getPropertyValue(name).trim() !== value) return false;
  }
  return true;
}

export function applyTheme(theme: DormouseTheme): void {
  if (typeof document === 'undefined') return;
  if (theme === appliedThemeSnapshot?.theme && hasVisibleTheme(appliedThemeSnapshot)) return;

  // Hydration may reapply a fresh object for the same installed theme; compare ids.
  const previousThemeId = appliedThemeSnapshot?.theme.id ?? null;

  if (appliedThemeSnapshot && theme !== appliedThemeSnapshot.theme) {
    for (const name of Object.keys(appliedThemeSnapshot.resolvedVars)) {
      document.body.style.removeProperty(name);
    }
  }

  // Imported theme JSON usually omits VSCode registry defaults; materialize
  // them here so theme.css can read --vscode-* directly without fallbacks.
  const providedVars = { ...HOST_TYPOGRAPHY_VARS, ...theme.vars };
  const vars = completeThemeVars(providedVars, theme.type);
  // Dormouse uses VSCode's overlay selection colors as solid fills.
  flattenSelectionAlpha(vars);
  appliedThemeSnapshot = { theme, providedVars, resolvedVars: vars };
  for (const [name, value] of Object.entries(vars)) {
    document.body.style.setProperty(name, value);
  }

  if (theme.type === 'light') {
    document.body.classList.add('vscode-light');
    document.body.classList.remove('vscode-dark');
  } else {
    document.body.classList.add('vscode-dark');
    document.body.classList.remove('vscode-light');
  }

  // Keep native-control polarity with the resolved theme, not the OS preference.
  document.body.style.colorScheme = theme.type === 'light' ? 'light' : 'dark';

  if (previousThemeId !== theme.id) {
    for (const listener of activeThemeListeners) listener();
  }
}

let defaultThemeId: string | null = null;

/** Set the module-wide fallback used by every restore path. */
export function setDefaultThemeId(id: string | null): void {
  defaultThemeId = id;
}

/** Apply the persisted active theme. When nothing is persisted yet — or the
 *  persisted theme no longer resolves — fall back to `setDefaultThemeId`'s
 *  value if it names a known theme, otherwise to the first bundled theme.
 *  Idempotent and safe to call before render so the first paint already has
 *  --vscode-* set on body. Returns the theme that was applied, or null when no
 *  themes are available (e.g. SSR). */
export function restoreActiveTheme(): DormouseTheme | null {
  const all = getAllThemes();
  const find = (id: string | null | undefined) => (id ? all.find((t) => t.id === id) : undefined);
  const theme = find(getStoredActiveThemeId()) ?? find(defaultThemeId) ?? all[0];
  if (!theme) return null;
  setActiveThemeId(theme.id);
  applyTheme(theme);
  return theme;
}

export function getAppliedThemeSnapshot(): AppliedThemeSnapshot | null {
  return appliedThemeSnapshot;
}
