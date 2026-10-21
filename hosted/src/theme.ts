import { resolveThemeVars } from "../../lib/src/lib/themes/apply";
import { getBundledThemes } from "../../lib/src/lib/themes/store";
import type { DormouseTheme } from "../../lib/src/lib/themes/types";
// The docs pages' contrast corrections, so a theme's accent, muted text, and
// red read here exactly as they do on dormouse.sh/hosted.
import { docsAccentFor, docsMutedTextFor, docsStatusColorFor } from "../../website/src/lib/docs-accent";

/** The docs pages' pre-choice default (`DOCS_THEME_ID` in
 * website/src/lib/docs-theme.ts), so arriving from dormouse.sh/hosted keeps
 * its colors. */
export const DEFAULT_THEME_ID = "vscode.theme-defaults.dark-visual-studio";
export const LIGHT_THEME_ID = "vscode.theme-defaults.light-visual-studio";

/** The same bundled themes the docs picker offers, minus the theme store:
 * Hosted makes no request beyond its own origin. */
export function hostedThemes(): DormouseTheme[] {
  return getBundledThemes();
}

function hostedTheme(id: string): DormouseTheme {
  const themes = hostedThemes();
  return themes.find((theme) => theme.id === id) ?? themes.find((theme) => theme.id === DEFAULT_THEME_ID)!;
}

/** Puts theme `id` on `doc`, replacing any other, with the derived page tokens
 * style.css reads; `overrides` replace individual theme variables. */
export function applyHostedTheme(doc: Document, id: string, overrides: Record<string, string> = {}) {
  const theme = hostedTheme(id);
  const { body } = doc;
  for (const name of [...body.style]) if (name.startsWith("--")) body.style.removeProperty(name);
  const vars = { ...resolveThemeVars(theme), ...overrides };
  const background = vars["--vscode-editor-background"];
  const foreground = vars["--vscode-editor-foreground"];
  const red = vars["--vscode-terminal-ansiRed"];
  const derived = {
    "--hosted-accent": docsAccentFor(theme.accent, background),
    "--hosted-muted": docsMutedTextFor(foreground, background),
    "--hosted-bad": red ? docsStatusColorFor(red, [background]) : null,
  };
  for (const [name, value] of Object.entries({ ...vars, ...derived }))
    if (value) body.style.setProperty(name, value);
  body.classList.toggle("vscode-light", theme.type === "light");
  body.classList.toggle("vscode-dark", theme.type !== "light");
  body.style.colorScheme = theme.type;
  body.dataset.hostedTheme = theme.id;
  doc.documentElement.style.colorScheme = theme.type;
}

const THEME_KEY = "dormouse:hosted-theme";

/** The visitor's pick on this origin, or the default. */
export function storedThemeId(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function storeThemeId(id: string) {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // Storage blocked: the pick holds for this page only.
  }
}
