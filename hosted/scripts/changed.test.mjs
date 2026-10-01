import test from "node:test";
import assert from "node:assert/strict";
import { touchesHosted } from "./changed.mjs";
test("Hosted and shared inputs trigger previews; unrelated application changes do not", () => {
  for (const path of [
    "hosted/README.md",
    "hosted/server/worker.ts",
    "hosted/server/relay-worker.ts",
    "hosted/server/voice-worker.ts",
    "hosted/wrangler.relay.jsonc",
    "hosted/wrangler.voice.jsonc",
    "pnpm-lock.yaml",
    ".github/workflows/hosted-preview.yml",
    "lib/src/theme-colors.css",
    "lib/src/lib/themes/bundled.json",
    "lib/src/lib/css-color.ts",
    "remote-lib-common/src/remote/one-time-wire.ts",
    "remote-lib-common/src/security/bytes.ts",
    "lib/src/remote/one-time-app/OneTimeApp.tsx",
    "lib/src/remote/pocket-app/PocketWall.tsx",
    "lib/one-time/index.html",
    "lib/vite.one-time.config.ts",
    "lib/vite.pocket.config.ts",
    "lib/scripts/assert-pocket-worker.mjs",
    "lib/package.json",
  ])
    assert.equal(touchesHosted([path]), true, path);
  for (const path of [
    "website/src/App.tsx",
    "standalone/src/main.tsx",
    "docs/specs/layout.md",
    ".github/workflows/ci.yml",
    "remote-lib-common/test/one-time-wire.test.mjs",
    "lib/pocket/index.html",
  ])
    assert.equal(touchesHosted([path]), false, path);
  assert.equal(touchesHosted([]), false);
});
