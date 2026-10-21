import { resolveThemeVars } from "../../lib/src/lib/themes/apply";
import { getBundledThemes } from "../../lib/src/lib/themes/store";

/** The two system-preference choices used by Hosted's production entrypoint. */
export function hostedTheme(dark: boolean) {
  const id = dark
    ? "vscode.theme-kimbie-dark.kimbie-dark"
    : "vscode.theme-defaults.light-visual-studio";
  return getBundledThemes().find((theme) => theme.id === id)!;
}

/** Puts that theme on `doc`, replacing the other one; `overrides` replace
 * individual theme variables. */
export function applyHostedTheme(doc: Document, dark: boolean, overrides: Record<string, string> = {}) {
  const theme = hostedTheme(dark);
  const { body } = doc;
  for (const name of [...body.style]) if (name.startsWith("--")) body.style.removeProperty(name);
  for (const [name, value] of Object.entries({ ...resolveThemeVars(theme), ...overrides }))
    body.style.setProperty(name, value);
  body.classList.toggle("vscode-light", theme.type === "light");
  body.classList.toggle("vscode-dark", theme.type !== "light");
  body.style.colorScheme = theme.type;
  doc.documentElement.style.colorScheme = theme.type;
}
