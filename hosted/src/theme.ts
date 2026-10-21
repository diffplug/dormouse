import { resolveThemeVars } from "../../lib/src/lib/themes/apply";
import { getBundledThemes } from "../../lib/src/lib/themes/store";
import type { DormouseTheme } from "../../lib/src/lib/themes/types";
// The docs pages' contrast corrections, so a theme's accent, muted text, and
// red read here exactly as they do on dormouse.sh/hosted.
import { docsAccentFor, docsMutedTextFor, docsStatusColorFor } from "../../lib/src/lib/themes/contrast";

/** The docs pages' pre-choice default (`DOCS_THEME_ID` in
 * website/src/lib/docs-theme.ts; theme.test.ts pins the two together), so
 * arriving from dormouse.sh/hosted keeps its colors. */
export const DEFAULT_THEME_ID = "vscode.theme-defaults.dark-visual-studio";

/** The same bundled themes the docs picker offers, minus the theme store:
 * Hosted makes no request beyond its own origin. */
export function hostedThemes(): DormouseTheme[] {
  return getBundledThemes();
}

/** Puts theme `id` (the default when it is not bundled) on `doc`, replacing
 * any other, with the derived page tokens style.css reads. */
export function applyHostedTheme(doc: Document, id: string) {
  const themes = hostedThemes();
  const theme = themes.find((candidate) => candidate.id === id)
    ?? themes.find((candidate) => candidate.id === DEFAULT_THEME_ID)!;
  const { body } = doc;
  for (const name of [...body.style]) if (name.startsWith("--")) body.style.removeProperty(name);
  const vars = resolveThemeVars(theme);
  const background = vars["--vscode-editor-background"];
  const foreground = vars["--vscode-editor-foreground"];
  const red = vars["--vscode-terminal-ansiRed"];
  const derived: Record<string, string | null> = {
    "--hosted-accent": docsAccentFor(theme.accent, background),
    "--hosted-muted": docsMutedTextFor(foreground, background),
    "--hosted-bad": red ? docsStatusColorFor(red, [background]) : null,
  };
  for (const [name, value] of Object.entries(vars)) body.style.setProperty(name, value);
  for (const [name, value] of Object.entries(derived)) if (value) body.style.setProperty(name, value);
  body.classList.toggle("vscode-light", theme.type === "light");
  body.classList.toggle("vscode-dark", theme.type !== "light");
  body.style.colorScheme = theme.type;
  body.dataset.hostedTheme = theme.id;
  doc.documentElement.style.colorScheme = theme.type;
}
