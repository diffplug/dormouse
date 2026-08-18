/**
 * Shared class strings for the docs pages.
 *
 * One definition each, so the caramel link, inline code, and code-block chrome
 * render identically across /docs, /docs/dor, and /docs/agent-skill instead of
 * drifting into three near-copies.
 */

/** Caramel link, matching the treatment used elsewhere on the site. */
export const LINK_CLASS = "text-[var(--color-caramel)] underline-offset-2 hover:underline";

/** Inline `code` spans. */
export const CODE_CLASS = "text-[0.9em] bg-[var(--color-text)]/15 px-1.5 py-0.5 rounded font-mono";

/** Fenced code blocks and other monospace panels. */
export const PRE_CLASS =
  "overflow-x-auto rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.04] p-4 font-mono text-sm";

/** The site's canonical origin, used to tell same-site links from external. */
export const SITE_ORIGIN = "https://dormouse.sh";
