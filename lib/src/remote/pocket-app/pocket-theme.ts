/**
 * Pocket's theme bootstrap. The whole Pocket app — the auth/hosts chrome *and*
 * the terminal wall — is themed by the shared VSCode-token system
 * (docs/specs/theme.md): applyTheme() writes `--vscode-*` onto <body>, and
 * theme.css maps those to the `--color-*` tokens both surfaces consume.
 *
 * Kimbie Dark is the brand default — dormouse's homepage is a Kimbie Dark
 * clone — so an app-surface signin screen that renders in Kimbie Dark is also
 * on-brand. restoreActiveTheme() honors a user's persisted choice first, then
 * falls back to this default.
 */
import { restoreActiveTheme } from '../../lib/themes';

export const POCKET_THEME_ID = 'vscode.theme-kimbie-dark.kimbie-dark';

/**
 * Apply the persisted-or-default theme to <body>. Call before first paint so
 * the auth screens (not just the wall) render with `--vscode-*` / `--color-*`
 * present. Idempotent.
 */
export function restorePocketTheme(): void {
  restoreActiveTheme(POCKET_THEME_ID);
}
