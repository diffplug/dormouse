/**
 * Shared class strings for the docs pages.
 *
 * One definition each, so the link, inline code, and code-block chrome render
 * identically across every reference page instead of drifting into near-copies.
 */

/**
 * Prose links take the active theme's link color, not the site's caramel.
 *
 * Caramel is 5.56:1 on the site's black but 3.43–3.78:1 on every bundled light
 * theme, so a reader who picks one would drop the whole page's links below
 * WCAG AA. The registry default behind this var is chosen per theme kind and
 * clears it. Brand caramel stays everywhere the reader cannot retheme it — the
 * wordmark, the site header, the homepage — and is the fallback here for the
 * moment before a theme is applied.
 */
export const LINK_CLASS =
  "text-[var(--vscode-textLink-foreground,var(--color-caramel))] underline-offset-2 hover:underline";

/** The same accent for callers composing their own class. Written out rather
 *  than interpolated: Tailwind scans source statically. */
export const ACCENT_TEXT_CLASS = "text-[var(--vscode-textLink-foreground,var(--color-caramel))]";
export const ACCENT_HOVER_TEXT_CLASS =
  "hover:text-[var(--vscode-textLink-foreground,var(--color-caramel))]";
export const ACCENT_HOVER_BORDER_CLASS =
  "hover:border-[var(--vscode-textLink-foreground,var(--color-caramel))]";

/** Inline `code` spans. */
export const CODE_CLASS = "text-[0.9em] bg-[var(--color-text)]/15 px-1.5 py-0.5 rounded font-mono";

/** Fenced code blocks and other monospace panels. */
export const PRE_CLASS =
  "overflow-x-auto rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.04] p-4 font-mono text-sm";

