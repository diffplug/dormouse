/**
 * Theme state for the reference pages.
 *
 * The docs render long-form prose, so unlike the rest of the site they are not
 * locked to the brand's black — a reader picks what they can read. The
 * homepage keeps its own palette (docs/specs/website-docs.md -> Reference page
 * chrome).
 */

/**
 * Softer than the site's `#000`, still dark enough to arrive from a black
 * homepage without a flash. Only the pre-choice default; the picker's own
 * persistence takes over the moment someone chooses.
 */
export const DOCS_THEME_ID = "vscode.theme-defaults.dark-visual-studio";

/**
 * Whether the reader has ever chosen a theme.
 *
 * Deliberately not `dormouse:active-theme`: `restoreActiveTheme` persists the
 * id it resolved, so that key exists after the first page load whether or not
 * anyone chose anything, and a prompt keyed on it would never show twice
 * (docs/specs/theme.md -> Where the user picks a theme).
 */
const CHOSE_KEY = "dormouse:docs-theme-chosen";

/** Storage throws in some privacy modes; a reader with no storage is prompted
 *  every visit rather than seeing the page fail to render. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function hasChosenDocsTheme(): boolean {
  try {
    return storage()?.getItem(CHOSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberDocsThemeChoice(): void {
  try {
    storage()?.setItem(CHOSE_KEY, "1");
  } catch {
    // Nothing to recover: the prompt simply returns on the next visit.
  }
}
