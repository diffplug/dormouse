/**
 * The scanning contract in docs/specs/theme.md -> Where the user picks a theme.
 * It is invisible to every other test here, which renders markup and never
 * resolves a stylesheet, and it fails silently in the browser.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("the site stylesheet", () => {
  it("scans the library it renders components from", () => {
    expect(css).toMatch(/@source\s+"\.\.\/\.\.\/lib\/src"\s*;/);
  });

  it("does not adopt the library's @theme", () => {
    expect(css).not.toMatch(/@import\s+["'][^"']*lib\/src\/theme\.css/);
  });

  it("keeps the library's tests and stories out of the scan", () => {
    // 180 of the library's 430 files, none of them rendered here.
    for (const kind of ["test.ts", "test.tsx", "stories.ts", "stories.tsx"]) {
      expect(css).toContain(`@source not "../../lib/src/**/*.${kind}"`);
    }
  });
});
