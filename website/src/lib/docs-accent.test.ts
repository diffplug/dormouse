import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { completeThemeVars, getBundledThemes } from "dormouse-lib/lib/themes";
import { compositeColor, contrastRatio, docsAccentFor, docsMutedTextFor } from "./docs-accent";
import { TINTED_DOCS_SURFACES } from "../components/docs-tokens";

/** The site's own palette, which `website/src/index.css` declares as literals
 *  because the marketing pages are locked to it and prerender without JS. */
const SITE_BACKGROUND = "#000000";
const SITE_FOREGROUND = "#dedede";
const SITE_CARAMEL = "#b47624";

/** `--color-text` follows the reader's theme on a docs page; `--color-caramel`
 *  is the fixed brand colour. A new `tintVar` is unmapped until it is added
 *  here, so the table cannot grow an entry these tests silently mis-cover. */
const tintFor = (tintVar: string, foreground: string): string => {
  if (tintVar === "--color-text") return foreground;
  if (tintVar === "--color-caramel") return SITE_CARAMEL;
  throw new Error(`docs-accent.test.ts has no colour for tintVar ${tintVar}`);
};

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

const themes = getBundledThemes().map((theme) => {
  const vars = completeThemeVars(theme.vars ?? {}, theme.type);
  return {
    id: theme.id,
    accent: theme.accent,
    background: vars["--vscode-editor-background"],
    foreground: vars["--vscode-editor-foreground"],
  };
});

describe("docs link colour", () => {
  it("has a theme to derive from at all", () => {
    expect(themes.length).toBeGreaterThan(0);
    for (const t of themes) {
      expect(t.accent, `${t.id} accent`).toBeTruthy();
      expect(t.background, `${t.id} background`).toBeTruthy();
    }
  });

  it("clears WCAG AA on every bundled theme", () => {
    // The raw accents do not: seven of eleven fall below 4.5:1 against their
    // own background, which is why the correction exists.
    for (const t of themes) {
      const link = docsAccentFor(t.accent, t.background);
      expect(link, t.id).not.toBeNull();
      expect(contrastRatio(rgb(link!), rgb(t.background)), `${t.id} (${link})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("actually varies by theme, not merely by light and dark", () => {
    // The defect this replaced: `--vscode-textLink-foreground` resolves to one
    // registry default per theme kind, so every dark theme shared a link
    // colour. Two distinct values would mean we had reproduced that.
    const distinct = new Set(themes.map((t) => docsAccentFor(t.accent, t.background)));
    expect(distinct.size).toBeGreaterThan(2);
  });

  it("clears AA after rounding, not merely before it", () => {
    // `toHex` rounds, so a candidate measured unrounded can clear 4.5 while the
    // colour actually returned falls under it. This pair did, at 4.479:1 — and
    // every bundled theme clears with room, so nothing else here would catch it.
    const link = docsAccentFor("#007fd4", "#c1c1c1")!;
    expect(contrastRatio(rgb(link), rgb("#c1c1c1"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps an accent that already contrasts, rather than washing it out", () => {
    // #99947c on #272822 is 4.87:1 already, so it should come back untouched.
    expect(docsAccentFor("#99947c", "#272822")).toBe("#99947c");
  });

  it("flattens alpha against the background before judging it", () => {
    // Half-transparent white over black is grey, not white.
    expect(docsAccentFor("#ffffff80", "#000000")).not.toBe("#ffffff80");
    expect(docsAccentFor("#ffffff80", "#000000")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns null on a colour it cannot read, leaving the CSS fallback", () => {
    expect(docsAccentFor("var(--nope)", "#000000")).toBeNull();
    expect(docsAccentFor("#000000", "rgb(0 0 0)")).toBeNull();
  });
});

describe("docs action colour", () => {
  it("clears WCAG AA on the resting and hover tints in every bundled theme", () => {
    for (const t of themes) {
      const accent = docsAccentFor(t.accent, t.background)!;
      const restingSurface = compositeColor(accent, t.background, 0.1)!;
      const hoverSurface = compositeColor(accent, t.background, 0.2)!;
      const action = docsAccentFor(accent, hoverSurface)!;

      expect(
        contrastRatio(rgb(action), rgb(restingSurface)),
        `${t.id} resting (${action} on ${restingSurface})`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(rgb(action), rgb(hoverSurface)),
        `${t.id} hover (${action} on ${hoverSurface})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("docs muted text colour", () => {
  it("clears WCAG AA on every bundled theme", () => {
    for (const t of themes) {
      const muted = docsMutedTextFor(t.foreground, t.background);
      expect(muted, t.id).not.toBeNull();
      expect(
        contrastRatio(rgb(muted!), rgb(t.background)),
        `${t.id} (${muted})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(TINTED_DOCS_SURFACES)(
    "clears WCAG AA on the $token surface in every bundled theme",
    ({ tintVar, tintAlpha }) => {
      for (const t of themes) {
        const tint = tintFor(tintVar, t.foreground);
        const surface = compositeColor(tint, t.background, tintAlpha)!;
        const muted = docsMutedTextFor(t.foreground, surface);
        expect(muted, t.id).not.toBeNull();
        expect(
          contrastRatio(rgb(muted!), rgb(surface)),
          `${t.id} (${muted} on ${surface})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("moves a high-contrast foreground toward its background", () => {
    const muted = docsMutedTextFor("#ffffff", "#000000")!;
    expect(muted).not.toBe("#ffffff");
    expect(contrastRatio(rgb(muted), rgb("#000000"))).toBeGreaterThanOrEqual(4.5);
  });

  it("returns null on a colour it cannot read", () => {
    expect(docsMutedTextFor("var(--nope)", "#000000")).toBeNull();
  });

  it("agrees with the static fallback index.css declares", () => {
    // The site's own palette is fixed, so its muted level is precomputed there
    // rather than left to DocsLayout's effect — otherwise the prerendered page
    // has no muted level at all. Keep the two in step.
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const declared = css.match(/--docs-text-muted:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(declared).toBe(docsMutedTextFor("#dedede", "#000000"));
  });

  it.each(TINTED_DOCS_SURFACES)(
    "agrees with the static $token fallback index.css declares",
    ({ token, tintVar, tintAlpha }) => {
      const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
      const declared = css.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
      const tint = tintFor(tintVar, SITE_FOREGROUND);
      const surface = compositeColor(tint, SITE_BACKGROUND, tintAlpha)!;
      expect(declared).toBe(docsMutedTextFor(SITE_FOREGROUND, surface));
    },
  );
});
