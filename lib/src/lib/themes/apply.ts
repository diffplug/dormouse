import type { DormouseTheme } from './types';
import { getAllThemes, getStoredActiveThemeId, setActiveThemeId } from './store';
import { completeThemeVars } from './vscode-color-resolver';
import { flattenSelectionAlpha } from './flatten-alpha';
import { rememberThemePaint } from './boot-paint';

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

function withHostTypography(vars: Record<string, string>): Record<string, string> {
  return { ...HOST_TYPOGRAPHY_VARS, ...vars };
}

/** The values `applyTheme` would paint for a theme, resolved without touching
 *  the document: imported theme JSON usually omits VSCode registry defaults, and
 *  Dormouse uses VSCode's overlay selection colors as solid fills. The picker
 *  previews a candidate through this so a preview cannot drift from the app. */
export function resolveThemeVars(theme: DormouseTheme): Record<string, string> {
  const vars = completeThemeVars(withHostTypography(theme.vars), theme.type);
  flattenSelectionAlpha(vars);
  return vars;
}

function hasVisibleTheme(snapshot: AppliedThemeSnapshot): boolean {
  const body = document.body;
  const expectedClass = snapshot.theme.type === 'light' ? 'vscode-light' : 'vscode-dark';
  if (!body.classList.contains(expectedClass)) return false;
  if (body.style.colorScheme !== snapshot.theme.type) return false;

  for (const [name, value] of Object.entries(snapshot.resolvedVars)) {
    if (body.style.getPropertyValue(name).trim() !== value) return false;
  }
  return true;
}

/** Writes a resolved theme onto a body: what `applyTheme` does to the page,
 *  without its bookkeeping, so a story frame can paint its own document. */
export function paintThemeOnto(body: HTMLElement, theme: DormouseTheme, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) {
    body.style.setProperty(name, value);
  }

  if (theme.type === 'light') {
    body.classList.add('vscode-light');
    body.classList.remove('vscode-dark');
  } else {
    body.classList.add('vscode-dark');
    body.classList.remove('vscode-light');
  }

  // Keep native-control polarity with the resolved theme, not the OS preference.
  body.style.colorScheme = theme.type === 'light' ? 'light' : 'dark';
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

  // Materialized so theme.css can read --vscode-* directly without fallbacks.
  const providedVars = withHostTypography(theme.vars);
  const vars = resolveThemeVars(theme);
  appliedThemeSnapshot = { theme, providedVars, resolvedVars: vars };
  paintThemeOnto(document.body, theme, vars);
  rememberThemePaint();

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
