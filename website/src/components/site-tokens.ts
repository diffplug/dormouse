/**
 * Shared class strings for the site's own pages.
 *
 * The counterpart to `docs-tokens.ts`: those follow the reader's picked theme,
 * because the reference pages are long-form reading. These are the brand
 * palette, which the marketing pages are locked to.
 */

/** Links in body copy. Body copy is dimmed with a text-color alpha
 *  (`text-[…]/70`) rather than `opacity`, which would composite the link along
 *  with the surrounding text and dim it too. */
export const SITE_LINK_CLASS = "text-[var(--color-caramel)] underline-offset-2 hover:underline";

/** Inline `code` spans in body copy. */
export const SITE_CODE_CLASS = "text-sm bg-[var(--color-text)]/20 px-1.5 py-0.5 rounded";
