/** VSCode theme color maps for Storybook theme switcher.
 * Derived from bundled themes and put through the same resolver + selection
 * alpha flattening as applyTheme(), so isolated stories see the materialized
 * --vscode-* set the app sees (docs/specs/theme.md).
 */
import _bundled from '../src/lib/themes/bundled.json';
import type { DormouseTheme } from '../src/lib/themes/types';
import { flattenSelectionAlpha } from '../src/lib/themes/flatten-alpha';
import { completeThemeVars } from '../src/lib/themes/vscode-color-resolver';

const bundled = _bundled as unknown as DormouseTheme[];

const STORYBOOK_HOST_TYPOGRAPHY_VARS: Record<string, string> = {
  '--vscode-font-size': '13px',
  '--vscode-editor-font-size': '13px',
  '--vscode-font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  '--vscode-editor-font-family':
    "'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
};

export const VSCODE_THEMES: Record<string, Record<string, string>> = {};
export const VSCODE_THEME_TYPES: Record<string, DormouseTheme['type']> = {};
for (const theme of bundled) {
  VSCODE_THEME_TYPES[theme.label] = theme.type;
  const vars = completeThemeVars(
    { ...STORYBOOK_HOST_TYPOGRAPHY_VARS, ...theme.vars },
    theme.type,
  );
  flattenSelectionAlpha(vars);
  VSCODE_THEMES[theme.label] = vars;
}
