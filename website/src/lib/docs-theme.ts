/**
 * Theme state for the reference pages.
 *
 * The docs render long-form prose, so unlike the rest of the site they are not
 * locked to the brand's black — a reader picks what they can read. The
 * homepage keeps its own palette (docs/specs/website-docs.md -> Reference page
 * chrome).
 */
import { loadJson, saveJson } from "dormouse-lib/lib/local-json-store";

/**
 * Softer than the site's `#000`, still dark enough to arrive from a black
 * homepage without a flash. Only the pre-choice default; the picker's own
 * persistence takes over the moment someone chooses.
 */
export const DOCS_THEME_ID = "vscode.theme-defaults.dark-visual-studio";

/**
 * Whether the reader is done with the theme prompt — they picked a theme, or
 * they closed it. Either way they have seen the offer, and repeating it is a
 * nuisance rather than a service.
 *
 * Deliberately not `dormouse:active-theme`: `restoreActiveTheme` persists the
 * id it resolved, so that key exists after the first page load whether or not
 * anyone chose anything, and a prompt keyed on it would never show twice
 * (docs/specs/theme.md -> Where the user picks a theme).
 */
const DISMISSED_KEY = "dormouse:docs-theme-prompt-dismissed";

/**
 * Storage is absent in prerender and throws outright in some privacy modes;
 * `loadJson`/`saveJson` already collapse both to the fallback, so a reader with
 * no storage is prompted every visit rather than seeing the page fail.
 */
export function isThemePromptDismissed(): boolean {
  return loadJson(DISMISSED_KEY, false) === true;
}

export function dismissThemePrompt(): void {
  saveJson(DISMISSED_KEY, true);
}
