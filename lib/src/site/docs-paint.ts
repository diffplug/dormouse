/**
 * Paints the docs pages' theme: the dormouse.sh reference pages and Hosted's
 * account pages, which continue them.
 *
 * site.css gives each derived token a fallback for the site's own black, so a
 * page with no JS still reads; the docs paint profile replaces them with the
 * picked theme's own accent, muted text, and verdict colors, each corrected to
 * WCAG AA (`./contrast` lives with the themes: `lib/src/lib/themes/contrast.ts`).
 */
import type { CSSProperties } from "react";
import { setThemePaintProfile, type ThemePaintProfile } from "../lib/themes/boot-paint";
import type { DormouseTheme } from "../lib/themes/types";
import { useRestoredTheme } from "../lib/themes/use-restored-theme";
import { useBrowserLayoutEffect } from "../lib/use-browser-layout-effect";
import {
  compositeColor,
  docsAccentFor,
  docsMutedTextFor,
  docsMutedTextForSurfaces,
  docsStatusColorFor,
} from "../lib/themes/contrast";
import { DOCS_STATUS_COLORS, TINTED_DOCS_SURFACES, type DocsSurfaceVariants } from "./docs-tokens";
import { DOCS_THEME_ID } from "./docs-theme";

/** Repaints the site's own tokens from the picked theme; see site.css. */
export const DOCS_THEMED_BODY_CLASS = "docs-themed";

/** The site header over a themed page is translucent, so it takes the
 *  theme's own background rather than the site's near-black. */
export const DOCS_HEADER_STYLE: CSSProperties = {
  background: "color-mix(in srgb, var(--color-bg) 85%, transparent)",
  backdropFilter: "blur(12px)",
};

/** The site's brand colour, which `./site.css` declares in its @theme and no
 *  theme overrides; `docs-accent.test.ts` pins the two equal. */
export const SITE_CARAMEL = "#b47624";

/**
 * The derived `--docs-*` tokens for `theme`, whose resolved `--vscode-*`
 * values are `resolvedVars`: the docs profile's `derive`. Pure, so a build
 * can bake them into a page's first frame.
 *
 * A tint layer's colour is what its variable resolves to on a docs page:
 * `--color-text` the theme's foreground (site.css's `.docs-themed` remap) and
 * `--color-caramel` the brand colour. A tint variable this cannot resolve
 * leaves its token on site.css's fallback.
 */
export function docsTokensFor(
  theme: DormouseTheme,
  resolvedVars: Record<string, string>,
): Record<string, string> {
  const background = resolvedVars["--vscode-editor-background"];
  const foreground = resolvedVars["--vscode-editor-foreground"];
  const accent = theme.accent;
  const tokens: Record<string, string> = {};
  if (!accent || !background || !foreground) return tokens;
  const link = docsAccentFor(accent, background);
  if (link) {
    tokens["--docs-accent"] = link;
    const actionHoverSurface = compositeColor(link, background, 0.2);
    const actionText = actionHoverSurface && docsAccentFor(link, actionHoverSurface);
    if (actionText) tokens["--docs-button-text"] = actionText;
  }
  const muted = docsMutedTextFor(foreground, background);
  if (muted) tokens["--docs-text-muted"] = muted;

  // One pass per tinted container, so a new one (or a nested tint stack) is
  // an entry in the table rather than another pair of lines whose alpha
  // has to match a class string somewhere else (./docs-tokens.ts).
  const tints: Record<string, string> = { "--color-text": foreground, "--color-caramel": SITE_CARAMEL };
  /** Each tint stack flattened onto the page, or null if any layer is unknown. */
  const resolveSurfaces = (surfaceVariants: DocsSurfaceVariants): string[] | null => {
    const surfaces = surfaceVariants.map((layers) =>
      layers.reduce<string | null>((surface, { tintVar, tintAlpha }) => {
        const tint = tints[tintVar];
        return surface && tint ? compositeColor(tint, surface, tintAlpha) : null;
      }, background),
    );
    return surfaces.every((surface): surface is string => Boolean(surface)) ? surfaces : null;
  };
  for (const { token, surfaceVariants } of TINTED_DOCS_SURFACES) {
    const surfaces = resolveSurfaces(surfaceVariants);
    const surfaceMuted = surfaces && docsMutedTextForSurfaces(foreground, surfaces);
    if (surfaceMuted) tokens[token] = surfaceMuted;
  }

  // Verdict colours take the theme's terminal hues, so red and green read
  // as that theme's own red and green.
  for (const { token, ansiVar, surfaceVariants } of DOCS_STATUS_COLORS) {
    const hue = resolvedVars[ansiVar];
    const surfaces = resolveSurfaces(surfaceVariants);
    const status = hue && surfaces && docsStatusColorFor(hue, surfaces);
    if (status) tokens[token] = status;
  }
  return tokens;
}

/** How a docs page paints: the docs default, the derived tokens, and the
 *  class that remaps the site's palette onto the theme. */
export const DOCS_PAINT_PROFILE: ThemePaintProfile = {
  defaultThemeId: DOCS_THEME_ID,
  derive: docsTokensFor,
  classes: [DOCS_THEMED_BODY_CLASS],
};

/** Puts the page on the reader's picked theme (the docs default until they
 *  pick), painted through `DOCS_PAINT_PROFILE`. */
export function useDocsThemedBody() {
  // Before the restore, which paints through it.
  setThemePaintProfile(DOCS_PAINT_PROFILE);
  useRestoredTheme(DOCS_THEME_ID);
  // A layout effect, so a hydration that resets <body> is repaired before
  // the browser draws it.
  useBrowserLayoutEffect(() => {
    document.body.classList.add(DOCS_THEMED_BODY_CLASS);
    return () => document.body.classList.remove(DOCS_THEMED_BODY_CLASS);
  }, []);
}
