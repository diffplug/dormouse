/**
 * Shared class strings for the docs pages.
 *
 * One definition each, so the link, inline code, code-block, and table chrome
 * render identically across every reference page instead of drifting into
 * near-copies.
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
 *
 * `--docs-accent` holds that fallback chain; it is defined once in
 * website/src/index.css so the decision has one owner.
 */
export const LINK_CLASS = "text-[var(--docs-accent)] underline-offset-2 hover:underline";

/** The same accent for callers composing their own class. Written out rather
 *  than interpolated: Tailwind scans source statically. */
export const ACCENT_TEXT_CLASS = "text-[var(--docs-accent)]";
export const ACCENT_HOVER_TEXT_CLASS = "hover:text-[var(--docs-accent)]";
export const ACCENT_HOVER_BORDER_CLASS = "hover:border-[var(--docs-accent)]";

/** Inline `code` spans. */
export const CODE_CLASS = "text-[0.9em] bg-[var(--color-text)]/15 px-1.5 py-0.5 rounded font-mono";

/** Fenced code blocks and other monospace panels. */
export const PRE_CLASS =
  "overflow-x-auto rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.04] p-4 font-mono text-sm";

/** Tables: the scroll container, the table itself, and a body row's rule. A
 *  table wider than the column scrolls inside its own box rather than pushing
 *  the page sideways on a phone. */
export const TABLE_WRAP_CLASS = "overflow-x-auto";
export const TABLE_CLASS = "w-full border-collapse text-left";
export const TABLE_ROW_CLASS = "border-b border-[var(--color-text)]/10";
