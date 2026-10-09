import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPARISON_SOURCE_PATH } from "../lib/comparison";

describe("comparison page", () => {
  it("sends readers to the file that owns the table", () => {
    // The "let us know" link is built from this path; a move would 404 it.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    expect(existsSync(`${repoRoot}${COMPARISON_SOURCE_PATH}`)).toBe(true);
  });
});
