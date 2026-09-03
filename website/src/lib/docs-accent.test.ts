import { describe, expect, it } from "vitest";
import { getBundledThemes } from "dormouse-lib/lib/themes";
import { contrastRatio, docsAccentFor } from "./docs-accent";

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

const themes = getBundledThemes().map((theme) => ({
  id: theme.id,
  accent: theme.accent,
  background: (theme.vars ?? {})["--vscode-editor-background"],
}));

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
