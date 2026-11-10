import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { touchesHosted } from "./changed.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
test("Hosted and shared inputs trigger previews; unrelated application changes do not", () => {
  for (const path of [
    "hosted/README.md",
    "hosted/server/worker.ts",
    "hosted/server/relay-worker.ts",
    "hosted/server/voice-worker.ts",
    "hosted/wrangler.relay.jsonc",
    "hosted/wrangler.voice.jsonc",
    "pnpm-lock.yaml",
    "website/public/favicon.svg",
    "website/src/lib/hosted-pricing.ts",
    "website/src/lib/hosted-withdrawal.ts",
    "website/src/lib/hosted-cohorts.ts",
    ".github/workflows/hosted-preview.yml",
    "lib/src/theme-colors.css",
    "lib/src/lib/themes/bundled.json",
    "lib/src/lib/css-color.ts",
    "remote-lib-common/src/remote/one-time-wire.ts",
    "remote-lib-common/src/security/bytes.ts",
    "lib/src/remote/one-time-app/OneTimeApp.tsx",
    "lib/src/remote/pocket-app/PocketWall.tsx",
    "lib/one-time/index.html",
    "lib/pocket/index.html",
    "lib/pocket/diagnostics/page.js",
    "lib/vite.sw.config.ts",
    "lib/vite.one-time.config.ts",
    "lib/vite.pocket.config.ts",
    "lib/scripts/assert-pocket-worker.mjs",
    "lib/package.json",
    // Pocket's whole import graph, not only its remote modules.
    "lib/src/components/wall/MobileWall.tsx",
    "lib/src/lib/platform/types.ts",
    "lib/src/index.css",
    "dor-lib-common/src/spawn.ts",
    "dor-lib-common/package.json",
    "remote-lib-common/package.json",
    "remote-lib-common/test/harness/actors.mjs",
    "lib/tsconfig.app.json",
  ])
    assert.equal(touchesHosted([path]), true, path);
  for (const path of [
    "website/src/App.tsx",
    "standalone/src/main.tsx",
    "docs/specs/layout.md",
    ".github/workflows/ci.yml",
    "lib/pocketbook.md",
    "lib/scripts/other.mjs",
    "relay/src/app.ts",
    "vscode-ext/src/extension.ts",
  ])
    assert.equal(touchesHosted([path]), false, path);
  assert.equal(touchesHosted([]), false);
});

test("every website module Hosted imports triggers a preview", () => {
  const targets = new Set();
  for (const dir of ["hosted/server", "hosted/src"]) {
    for (const entry of readdirSync(path.join(repo, dir), { recursive: true })) {
      if (!/\.tsx?$/.test(entry)) continue;
      const file = path.join(repo, dir, entry);
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/from\s+["']([./]+website\/[^"']+)["']/g)) {
        const target = path.relative(repo, path.resolve(path.dirname(file), spec)).split(path.sep).join("/");
        targets.add(/\.tsx?$/.test(target) ? target : `${target}.ts`);
      }
    }
  }
  assert.ok(targets.size > 0, "found no website imports");
  for (const target of targets) assert.equal(touchesHosted([target]), true, target);
});
