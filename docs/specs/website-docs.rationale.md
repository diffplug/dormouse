# website-docs rationale

Evidence behind the rules in [website-docs.md](website-docs.md), keyed by that
file's headings. Informative, not normative.

## Canonical product guide

`vsce` and `ovsx` both infer an image base from the repository root, and this
extension lives in a subdirectory, so inference resolves the guide's
repo-relative `images/x` against the wrong path. A packaging invocation missing
`--baseImagesUrl` therefore ships a Marketplace listing whose images 404, and
nothing in CI or a local build notices — only a human opening the live listing
does. An invocation with `--packagePath` republishes an already-built VSIX,
whose URLs were rewritten when it was packaged.

Generated guide media gets `public/guide/` to itself because `syncGuideMedia`
deletes that directory wholesale on every build. It previously wrote to
`public/images/`, which is the natural home for hand-authored site assets, and
the whole path was gitignored — so an `og-card.png` dropped there would have
worked locally, never been staged, and vanished on the next build.

## Per-page head tags

The two-`<title>` failure was observed rather than reasoned about: with a
hardcoded title in `root.tsx`'s `<head>`, every page that exported `meta`
emitted two `<title>` elements, and a minimal two-title page confirmed in
Chrome that `document.title` and the tab both take the *first*. Each reference
page therefore advertised itself as "Dormouse — A dormouse knows when to wake
up" to anything that did not run the page's JavaScript.

The canonical collapse was worse because it was uniform: all ten prerendered
pages carried `canonical="https://dormouse.sh/"`, verified in the live
production HTML for `/supply-chain/`. A self-referential canonical on every URL
tells search engines the subpages duplicate the homepage.

The SPA-fallback rule came from the fix making things briefly worse.
`/changelog/after/*` is served by rewriting to `__spa-fallback.html`, whose
static head carries the homepage's tags. Giving the route its own `meta` fixed
the `<title>` — a text child React reconciles — but left **two** conflicting
canonicals in the hydrated DOM, measured on the deployed preview. Search
engines discard a conflicting pair, so that is worse than the single wrong tag
it replaced.

## Reference page chrome

Brand caramel measures 5.56:1 on the site's black but 3.43–3.78:1 on every
bundled light theme, which is why prose links could not keep it once the docs
pages started following the reader's theme.

`--vscode-textLink-foreground` looked like the replacement and was not: none of
the 11 bundled themes defines `textLink.foreground`, so the variable always
resolves to the colour registry's default for the theme's *kind*. Every dark
theme shared one blue.

The theme's own `accent` varies per theme but cannot be used raw — measured
against each theme's `--vscode-editor-background`, 7 of the 11 fall below 4.5:1
and four carry alpha. Hence the correction, which walks the accent toward
whichever of white or black contrasts more and stops at the first step that
clears the threshold. Direction is measured rather than taken from a luminance
midpoint, which is not where the contrast crossover sits: `#808080` needs to
darken, and a luminance test sends it toward white.

Muted reference text originally used `opacity-50` through `opacity-80` over
the picked foreground. On Solarized Light that reduced 5.03:1 base contrast to
2.01:1–3.40:1, including the Hosted signup disclosure. Several dark themes
failed too. The opaque derived token walks the foreground toward its background
only while the rounded returned color stays at or above 4.5:1. The base page,
foreground-tinted cards and code spans, and caramel-tinted notes therefore
derive separate muted tokens against the surfaces that actually carry them.

The signup action originally reused the corrected link color on 10% and 20%
tints of itself. Those composites pulled every bundled theme below AA, so its
foreground is corrected against the stronger hover tint and checked on both.

Anchor offsets are tight by measurement, not by estimate. The mobile bar is
45px and the site header 64px, 80px from `md` up with no `lg` step, so the two
steps that clear both have 3px in hand and `lg` clears the header alone by
16px.

## Markdown rendering contract

Long paths in prose scrolled `/docs/self-host` sideways on a phone: ten
space-free tokens sit in its paragraphs, the longest 47 characters — about
404px of monospace against the 343px a 375px phone leaves after padding. One
unbreakable word to the line breaker, so it widened the article rather than
only itself. The same tokens inside tables were already contained by the
table's own scroller, which is why only that page showed it.

Breaking after every separator rather than after each run was the first attempt
and read badly: `--watch` parted at its dashes, `https://` at its slashes.
