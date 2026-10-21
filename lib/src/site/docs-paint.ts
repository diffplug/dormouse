/**
 * Paints the docs pages' derived tokens from a bundled theme: the dormouse.sh
 * reference pages and Hosted's account pages, which continue them.
 *
 * site.css gives each token a fallback for the site's own black, so a page
 * with no JS still reads; this replaces them with the picked theme's own
 * accent, muted text, and verdict colors, each corrected to WCAG AA
 * (`./contrast` lives with the themes: `lib/src/lib/themes/contrast.ts`).
 */
import { useEffect, type CSSProperties } from "react";
import {
  getAppliedThemeSnapshot,
  subscribeToActiveTheme,
  useRestoredTheme,
  type DormouseTheme,
} from "../lib/themes";
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

/**
 * Writes the derived `--docs-*` tokens onto `body` for `theme`, whose
 * resolved `--vscode-*` values are `resolvedVars`. `body` must already carry
 * `DOCS_THEMED_BODY_CLASS`, since the tinted surfaces are read off it.
 *
 * Takes the body rather than reading `document`, so a story can paint a page
 * inside its own frame.
 */
export function paintDocsTokens(
  body: HTMLElement,
  theme: DormouseTheme,
  resolvedVars: Record<string, string>,
) {
  const background = resolvedVars["--vscode-editor-background"];
  const foreground = resolvedVars["--vscode-editor-foreground"];
  const accent = theme.accent;
  if (!accent || !background || !foreground) return;
  const link = docsAccentFor(accent, background);
  if (link) {
    body.style.setProperty("--docs-accent", link);
    const actionHoverSurface = compositeColor(link, background, 0.2);
    const actionText = actionHoverSurface && docsAccentFor(link, actionHoverSurface);
    if (actionText) body.style.setProperty("--docs-button-text", actionText);
  }
  const muted = docsMutedTextFor(foreground, background);
  if (muted) body.style.setProperty("--docs-text-muted", muted);

  // One pass per tinted container, so a new one (or a nested tint stack) is
  // an entry in the table rather than another pair of lines whose alpha
  // has to match a class string somewhere else (./docs-tokens.ts).
  const styles = body.ownerDocument.defaultView!.getComputedStyle(body);
  /** Each tint stack flattened onto the page, or null if any layer is unreadable. */
  const resolveSurfaces = (surfaceVariants: DocsSurfaceVariants): string[] | null => {
    const surfaces = surfaceVariants.map((layers) =>
      layers.reduce<string | null>((surface, { tintVar, tintAlpha }) => {
        const tint = styles.getPropertyValue(tintVar).trim();
        return surface && tint ? compositeColor(tint, surface, tintAlpha) : null;
      }, background),
    );
    return surfaces.every((surface): surface is string => Boolean(surface)) ? surfaces : null;
  };
  for (const { token, surfaceVariants } of TINTED_DOCS_SURFACES) {
    const surfaces = resolveSurfaces(surfaceVariants);
    const surfaceMuted = surfaces && docsMutedTextForSurfaces(foreground, surfaces);
    if (surfaceMuted) body.style.setProperty(token, surfaceMuted);
  }

  // Verdict colours take the theme's terminal hues, so red and green read
  // as that theme's own red and green.
  for (const { token, ansiVar, surfaceVariants } of DOCS_STATUS_COLORS) {
    const hue = resolvedVars[ansiVar];
    const surfaces = resolveSurfaces(surfaceVariants);
    const status = hue && surfaces && docsStatusColorFor(hue, surfaces);
    if (status) body.style.setProperty(token, status);
  }
}

/**
 * Puts the page on the reader's picked theme (the docs default until they
 * pick) and keeps the derived tokens painted from it.
 */
export function useDocsThemedBody() {
  useRestoredTheme(DOCS_THEME_ID);
  useEffect(() => {
    document.body.classList.add(DOCS_THEMED_BODY_CLASS);
    return () => document.body.classList.remove(DOCS_THEMED_BODY_CLASS);
  }, []);

  // The applied snapshot, not the stored id: `getActiveThemeId` already falls
  // back to the first bundled theme, so a reader without storage would get the
  // page painted in one theme and its links derived from another's accent the
  // moment those two stop coinciding. Left alone, `--docs-accent` keeps the
  // value site.css gives it, so a reader with no JS still gets a legible one.
  useEffect(() => {
    const paint = () => {
      const snapshot = getAppliedThemeSnapshot();
      if (snapshot) paintDocsTokens(document.body, snapshot.theme, snapshot.resolvedVars);
    };
    paint();
    return subscribeToActiveTheme(paint);
  }, []);
}
