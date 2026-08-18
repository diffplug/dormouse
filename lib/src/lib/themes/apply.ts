import type { DormouseTheme } from './types';
import { getAllThemes, getStoredActiveThemeId, setActiveThemeId } from './store';
import { completeThemeVars } from './vscode-color-resolver';
import { flattenSelectionAlpha } from './flatten-alpha';

let appliedThemeSnapshot: AppliedThemeSnapshot | null = null;

const activeThemeListeners = new Set<() => void>();

/**
 * Notified whenever a *different* theme is applied — the boot-time
 * `restoreActiveTheme()` of an already-applied theme is a no-op here, and so is
 * re-selecting the active theme in the picker.
 *
 * Deliberately not `onTerminalThemeChange()` (`terminal-theme.ts`), which
 * watches resolved xterm palette JSON through a `MutationObserver` and fires on
 * the first mutation after it starts. Consumers here want "the user picked a
 * theme", so pair this with a seed read of `getActiveThemeId()`.
 */
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

  // Captured before the write: a hydration re-apply of the *same* theme still
  // runs the body writes below, and must not be reported as a theme change.
  // Compared by id, not identity — `getInstalledThemes()` re-parses its JSON on
  // every call, so an installed theme is a fresh object each time and an
  // identity check would report every restore as a change.
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
  // Theme authors give list.*SelectionBackground alpha because VSCode renders
  // it as an overlay on the sidebar. Dormouse uses it as a solid AppBar /
  // tab fill, so flatten the alpha over sideBar.background here — otherwise
  // whatever sits behind the surface bleeds through (Selenized Dark's bright
  // cyan AppBar, for instance).
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

  // Match the resolved polarity so native controls (form inputs, scrollbars,
  // autofill) render in the theme's light/dark UA chrome rather than following
  // the OS preference. Owned here so every non-VSCode host (standalone, website,
  // Pocket) inherits it from one place instead of guessing in each HTML shell.
  document.body.style.colorScheme = theme.type === 'light' ? 'light' : 'dark';

  if (previousThemeId !== theme.id) {
    for (const listener of activeThemeListeners) listener();
  }
}

let defaultThemeId: string | null = null;

/**
 * The host's preferred theme for when nothing is persisted yet — and the one
 * `restoreActiveTheme()` falls back to when the active theme stops resolving,
 * which is what uninstalling the active theme does.
 *
 * Module state, in the shape of `lib/src/lib/shell-defaults.ts`, rather than a
 * prop threaded down to each caller. Every path that re-resolves the active
 * theme has to agree on the fallback — the picker's uninstall, the store
 * dialog's Remove, a host's boot restore — and they sit at unrelated depths, so
 * a prop reaches some and misses others. Declared once by whoever boots the
 * app (`useRestoredTheme`, or a host's own entry point).
 */
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
