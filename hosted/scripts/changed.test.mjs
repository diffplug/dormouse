import test from "node:test";
import assert from "node:assert/strict";
import { touchesHosted } from "./changed.mjs";
test("Hosted and shared inputs trigger previews; unrelated application changes do not", () => {
  for (const path of [
    "hosted/README.md",
    "hosted/server/worker.ts",
    "vendor/build.json",
    "pnpm-lock.yaml",
    ".github/workflows/hosted-preview.yml",
    "lib/src/theme-colors.css",
    "lib/src/lib/themes/bundled.json",
    "lib/src/lib/css-color.ts",
  ])
    assert.equal(touchesHosted([path]), true, path);
  for (const path of [
    "website/src/App.tsx",
    "standalone/src/main.tsx",
    "docs/specs/layout.md",
    ".github/workflows/ci.yml",
  ])
    assert.equal(touchesHosted([path]), false, path);
  assert.equal(touchesHosted([]), false);
});
