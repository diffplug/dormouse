/**
 * Shared class strings for the docs pages.
 *
 * One definition each, so the link, inline code, code-block, and table chrome
 * render identically across every reference page instead of drifting into
 * near-copies. Shared with Hosted's account pages, which continue them.
 */
/**
 * Prose links take the active theme's own accent, corrected for contrast, not
 * the site's caramel.
 *
 * Caramel is 5.56:1 on the site's black but 3.43–3.78:1 on every bundled light
 * theme, so a reader who picks one would drop the whole page's links below
 * WCAG AA. `--vscode-textLink-foreground` cannot stand in: no bundled theme
 * defines it, so it resolves to one registry default per theme kind. Brand
 * caramel stays everywhere the reader cannot retheme it — the wordmark, the
 * site header, the homepage — and is the fallback here for the moment before a
 * theme is applied.
 *
 * `--docs-accent` holds that fallback chain, defined once in
 * ./site.css; `paintDocsTokens` (./docs-paint.ts) overwrites it with the corrected
 * accent once a theme resolves (lib/src/lib/themes/contrast.ts).
 */
export const LINK_CLASS = "text-[var(--docs-accent)] underline-offset-2 hover:underline";

/** The same accent for callers composing their own class. Written out rather
 *  than interpolated: Tailwind scans source statically. */
export const ACCENT_TEXT_CLASS = "text-[var(--docs-accent)]";
export const ACCENT_HOVER_TEXT_CLASS = "hover:text-[var(--docs-accent)]";
export const ACCENT_HOVER_BORDER_CLASS = "hover:border-[var(--docs-accent)]";
export const ACCENT_BORDER_CLASS = "border-[var(--docs-accent)]";

/** Accent-derived text corrected against an accent-tinted action surface —
 *  against the stronger hover tint, so it clears WCAG AA at rest and on hover
 *  (both pinned in lib/src/site/docs-accent.test.ts). */
export const ACTION_TEXT_CLASS = "text-[var(--docs-button-text)]";

const SITE_BUTTON_BASE = "inline-flex items-center justify-center rounded-md border font-display "
  + "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--docs-accent)] "
  + "disabled:pointer-events-none disabled:opacity-50";
const SITE_BUTTON_TONE = {
  accent: `hover:underline ${ACCENT_BORDER_CLASS} ${ACCENT_TEXT_CLASS}`,
  neutral: `border-[var(--color-text)]/30 transition-colors ${ACCENT_HOVER_BORDER_CLASS} ${ACCENT_HOVER_TEXT_CLASS}`,
};
const SITE_BUTTON_SIZE = {
  full: "min-h-12 w-full px-4 py-3",
  fit: "min-h-11 px-4 py-2",
};

/** The site's buttons: an outline in the accent (the call to action,
 *  underlined on hover) or in the text colour, taking the accent on hover.
 *  The variants set disjoint properties, so they compose without a merge. */
export function siteButton({
  tone = "accent",
  size = "full",
}: { tone?: keyof typeof SITE_BUTTON_TONE; size?: keyof typeof SITE_BUTTON_SIZE } = {}): string {
  return `${SITE_BUTTON_BASE} ${SITE_BUTTON_TONE[tone]} ${SITE_BUTTON_SIZE[size]}`;
}

/** The pages' call to action, full width. */
export const ACTION_CLASS = siteButton();

/** Opaque secondary text, derived per active theme to retain body-text AA. */
export const MUTED_TEXT_CLASS = "text-[var(--docs-text-muted)]";

/** Opaque secondary text corrected for `CARD_BASE_CLASS`'s foreground tint. */
export const CARD_MUTED_TEXT_CLASS = "text-[var(--docs-card-text-muted)]";

/** Opaque secondary text corrected for `NOTE_CLASS`'s caramel tint. */
export const NOTE_MUTED_TEXT_CLASS = "text-[var(--docs-note-text-muted)]";

/** Opaque secondary text corrected for every surface an inline code span may
 *  occupy, including a card or note beneath its own foreground tint. */
export const CODE_MUTED_TEXT_CLASS = "text-[var(--docs-code-text-muted)]";

/**
 * How far a jumped-to anchor clears the chrome above it.
 *
 * Below `lg` the docs carry a sticky nav bar under the fixed site header as
 * well; at `lg` the bar is gone and only the header remains. **Must** stay
 * ahead of both, or a tapped rail entry lands the heading underneath them.
 *
 * Measured: the bar is 45px and the header 64px, 80px from `md` up (it has no
 * `lg` step). So the two steps that clear both — 112px and 128px — have 3px in
 * hand, while `lg` clears the header alone by 16px. Growing the bar's padding
 * or its type needs the two tight steps raised with it.
 */
export const SCROLL_MT_CLASS = "scroll-mt-28 md:scroll-mt-32 lg:scroll-mt-24";

/** A navigation link that sits back until hovered, as the rail's do. */
export const MUTED_ACCENT_LINK_CLASS = `${MUTED_TEXT_CLASS} ${ACCENT_HOVER_TEXT_CLASS}`;

/** The rule down the left of a nested list, indenting what hangs off it. */
export const TOC_INDENT_CLASS = "border-l border-[var(--color-text)]/15 pl-3";

/** Inline `code` spans. `break-words` is the backstop under CodeSpan's
 *  separator breaks: a token with no separator at all must still not push the
 *  page wider than the viewport. */
export const CODE_CLASS =
  `text-[0.9em] bg-[var(--color-text)]/15 px-1.5 py-0.5 rounded font-mono break-words ${CODE_MUTED_TEXT_CLASS}`;

/** A panel of prose set off from the flow — `PRE_CLASS`'s tint without the
 *  monospace. `CARD_ACCENT_CLASS` is the variant that draws attention with the
 *  theme's accent instead of the quiet rule. */
export const CARD_BASE_CLASS = "rounded-xl border bg-[var(--color-text)]/[0.04] p-5 sm:p-6";
export const CARD_CLASS = `${CARD_BASE_CLASS} border-[var(--color-text)]/15`;
export const CARD_ACCENT_CLASS = `${CARD_BASE_CLASS} ${ACCENT_BORDER_CLASS}`;

/** The caramel aside both hosting pages open with. Caramel rather than the
 *  reader's accent: it flags an editorial note, not a link target. */
export const NOTE_CLASS =
  "rounded-lg border border-[var(--color-caramel)]/30 bg-[var(--color-caramel)]/[0.06] p-4 leading-relaxed";

/** Tint stacks a docs colour token is derived over: each variant lists its layers from the page inward. */
export type DocsSurfaceVariants = readonly (readonly { tintVar: string; tintAlpha: number }[])[];

/**
 * Every tinted container muted text renders on, each pairing the tint stacks
 * the reader can see with the exact composites that derive its token.
 *
 * A tint shifts the surface out from under `--docs-text-muted`, which sits
 * *at* 4.5:1 against the untinted page: `NOTE_CLASS` paired with
 * `MUTED_TEXT_CLASS` measured 4.42:1 on the site's own palette. **Adding a
 * tinted container adds an entry here**, and nesting adds a `surfaceVariants`
 * stack — `paintDocsTokens` (./docs-paint.ts) and `lib/src/site/docs-accent.test.ts`
 * both loop this list, so the CSS variable, the static fallback, and the
 * per-theme AA check come with it.
 *
 * `tintVar` is resolved off the live `body`, so it follows the reader's theme
 * where the token does (`--color-text`) and stays fixed where it does not
 * (`--color-caramel`). The class strings above are still written out: Tailwind
 * scans source statically and never sees an interpolated utility, so the alpha
 * here is the one that must match the literal beside it.
 */
export const TINTED_DOCS_SURFACES = [
  {
    token: "--docs-card-text-muted",
    surfaceVariants: [[{ tintVar: "--color-text", tintAlpha: 0.04 }]],
  },
  {
    token: "--docs-note-text-muted",
    surfaceVariants: [[{ tintVar: "--color-caramel", tintAlpha: 0.06 }]],
  },
  {
    token: "--docs-code-text-muted",
    surfaceVariants: [
      [{ tintVar: "--color-text", tintAlpha: 0.15 }],
      [
        { tintVar: "--color-text", tintAlpha: 0.04 },
        { tintVar: "--color-text", tintAlpha: 0.15 },
      ],
      [
        { tintVar: "--color-caramel", tintAlpha: 0.06 },
        { tintVar: "--color-text", tintAlpha: 0.15 },
      ],
    ],
  },
] as const;

/**
 * Verdict colours — good, mixed, bad — from the active theme's terminal green,
 * yellow, and red, corrected to clear body-text AA on the page and on the 4%
 * card tint a highlighted table column sits on.
 *
 * `paintDocsTokens` (./docs-paint.ts) derives each token; ./site.css carries the
 * fallback for the site's own black, and `lib/src/site/docs-accent.test.ts`
 * checks both. Never let colour carry a verdict alone: pair it with a shape.
 */
export const DOCS_STATUS_COLORS = [
  { token: "--docs-status-good", ansiVar: "--vscode-terminal-ansiGreen" },
  { token: "--docs-status-mixed", ansiVar: "--vscode-terminal-ansiYellow" },
  { token: "--docs-status-bad", ansiVar: "--vscode-terminal-ansiRed" },
].map((status) => ({
  ...status,
  surfaceVariants: [[], [{ tintVar: "--color-text", tintAlpha: 0.04 }]] as DocsSurfaceVariants,
}));

/** Written out rather than interpolated: Tailwind scans source statically. */
export const STATUS_GOOD_TEXT_CLASS = "text-[var(--docs-status-good)]";
export const STATUS_MIXED_TEXT_CLASS = "text-[var(--docs-status-mixed)]";
export const STATUS_BAD_TEXT_CLASS = "text-[var(--docs-status-bad)]";

/** A docs page's own title and the muted lede under it. Callers add their
 *  own flow margin. */
export const PAGE_TITLE_CLASS = "font-display text-[clamp(1.75rem,3vw+0.5rem,2.5rem)]";
export const PAGE_INTRO_CLASS = `text-lg ${MUTED_TEXT_CLASS}`;

/** A top-level section after the first, set off by a hairline rule. */
export const SECTION_CLASS = "mt-14 border-t border-[var(--color-text)]/15 pt-10";

/** The rule between the rows of a ticked list, as the plan cards draw it. */
export const DASHED_ROW_CLASS = "border-b border-dashed border-[var(--color-text)]/15";

/** A modal's surface. It spells its own surface rather than taking
 *  `CARD_CLASS`: a card's translucent tint over a dimmed page left the
 *  content legible straight through it. */
export const PANEL_CLASS =
  "max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-xl border "
  + "border-[var(--color-text)]/15 bg-[var(--color-bg)] p-5 text-[var(--color-text)] sm:p-6";

/** A text field: the outline and size every form on the site shares, and
 *  the themed text that follows the reader's theme. */
export const FIELD_CLASS =
  "min-h-12 w-full rounded-md border border-[var(--color-text)]/50 bg-[var(--color-bg)] px-4 py-3 text-base focus:outline-none";
export const FIELD_TEXT_CLASS =
  "text-[var(--color-text)] placeholder:text-[var(--docs-text-muted)] focus:border-[var(--docs-accent)]";

/** Reference body prose: the shared size, leading, and muted colour. Callers
 *  add their own flow margin. */
export const BODY_TEXT_CLASS = `text-lg leading-relaxed ${MUTED_TEXT_CLASS}`;

/** Fenced code blocks and other monospace panels. */
export const PRE_CLASS =
  "overflow-x-auto rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.04] p-4 font-mono text-sm";

/** Tables: the scroll container, the table itself, and a body row's rule. A
 *  table wider than the column scrolls inside its own box rather than pushing
 *  the page sideways on a phone. */
export const TABLE_WRAP_CLASS = "overflow-x-auto";
export const TABLE_CLASS = "w-full border-collapse text-left";
export const TABLE_ROW_CLASS = "border-b border-[var(--color-text)]/10";
/** The header row's rule is heavier than a body row's, so the head reads as a
 *  head without a second colour level doing the work. */
export const TABLE_HEAD_ROW_CLASS = "border-b border-[var(--color-text)]/25";
export const TH_CLASS = "py-2 pr-4 font-display font-normal whitespace-nowrap";
/** A header cell of a table with weighted columns, which wraps to hold its share. */
export const TH_WRAP_CLASS = "py-2 pr-4 font-display font-normal whitespace-normal";
