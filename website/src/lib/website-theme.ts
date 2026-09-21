/**
 * The theme every playground surface falls back to before the reader picks one.
 *
 * Taken from the real Pocket app so the playground — whose whole purpose is
 * proving out that experience — cannot drift from it. Named for the website
 * rather than for Pocket because the desktop playground restores it too, and
 * importing `POCKET_THEME_ID` there read as a bug.
 *
 * The reference pages have their own pre-choice default (`DOCS_THEME_ID` in
 * `./docs-theme`); `docs/specs/theme.md` -> "Where the user picks a theme"
 * owns how a host declares a fallback.
 */
export { POCKET_THEME_ID as WEBSITE_DEFAULT_THEME_ID } from "dormouse-lib/remote/pocket-app/pocket-theme";
