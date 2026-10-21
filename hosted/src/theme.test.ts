import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DEFAULT_THEME_ID } from "./theme";

test("defaults to the docs pages' theme, so dormouse.sh/hosted hands off without a color change", () => {
  const docs = readFileSync(new URL("../../website/src/lib/docs-theme.ts", import.meta.url), "utf8");
  expect(docs).toContain(`export const DOCS_THEME_ID = "${DEFAULT_THEME_ID}";`);
});
