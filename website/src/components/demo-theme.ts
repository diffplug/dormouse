import type { CSSProperties } from "react";
import { applyTheme, getBundledThemes } from "dormouse-lib/lib/themes";

/** The homepage's app demos (the Pocket phone, the VS Code window) wear one
 *  theme whatever the reader picked: they are pictures of the app, and they
 *  share `body`, where the terminal reads its colors. VS Code ships Kimbie Dark,
 *  so the VS Code window's chrome is that theme's too. Painting it does not
 *  become the reader's choice. */
export const DEMO_THEME_ID = "vscode.theme-kimbie-dark.kimbie-dark";

export function paintDemoTheme(): void {
  const theme = getBundledThemes().find(({ id }) => id === DEMO_THEME_ID);
  if (theme) applyTheme(theme);
}

/** The app's terminal type scale (`lib/src/theme.css`), scoped to a demo:
 *  that file would retune the whole homepage's type. */
export const APP_TYPE_SCALE = {
  "--text-xs": "0.625rem",
  "--text-xs--line-height": "1rem",
  "--text-sm": "0.75rem",
  "--text-sm--line-height": "1rem",
  "--font-mono": "var(--vscode-editor-font-family)",
  "--font-sans": "var(--vscode-editor-font-family)",
} as CSSProperties;
