import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// The desktop compatibility gate alone (`pnpm test:desktop-compat`), after
// `scripts/desktop-builds.mjs` has built every supported release. A deploy
// gate, not a per-PR suite: `hosted-production.yml` runs it before deploying.
// Spread rather than `mergeConfig`, which would append to `include`.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["server/tests/desktop-compat.gate.ts"],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
