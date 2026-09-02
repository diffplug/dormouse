// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCS_THEME_ID, hasChosenDocsTheme, rememberDocsThemeChoice } from "./docs-theme";

afterEach(() => {
  // Unstub first: the storage-failure case replaces localStorage entirely.
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("docs theme choice", () => {
  it("starts unchosen and stays chosen once recorded", () => {
    expect(hasChosenDocsTheme()).toBe(false);
    rememberDocsThemeChoice();
    expect(hasChosenDocsTheme()).toBe(true);
  });

  it("does not read the theme store's own key", () => {
    // `restoreActiveTheme` persists the id it resolved, so this key exists
    // after any page load whether or not the reader chose anything. A prompt
    // keyed on it would never show twice (docs/specs/theme.md).
    localStorage.setItem("dormouse:active-theme", DOCS_THEME_ID);
    expect(hasChosenDocsTheme()).toBe(false);
  });

  it("reports unchosen rather than throwing when storage is unavailable", () => {
    // Safari in private mode throws on access; the prompt returning every
    // visit is the acceptable failure, a page that will not render is not.
    vi.stubGlobal("localStorage", {
      get getItem(): never {
        throw new DOMException("denied");
      },
    });
    expect(hasChosenDocsTheme()).toBe(false);
    expect(() => rememberDocsThemeChoice()).not.toThrow();
  });

  it("defaults to a theme that actually ships", async () => {
    // Otherwise the default silently degrades to whichever theme happens to be
    // first in the bundle, which is what `restoreActiveTheme` falls back to.
    const { getBundledThemes } = await import("dormouse-lib/lib/themes");
    expect(getBundledThemes().map((t) => t.id)).toContain(DOCS_THEME_ID);
  });
});
