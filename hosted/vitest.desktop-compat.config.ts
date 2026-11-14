import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../scripts/workspace-sources.mjs";

// The desktop compatibility gate alone (`pnpm test:desktop-compat`), after
// `scripts/desktop-builds.mjs` has built every supported release. A deploy
// gate, not a per-PR suite: `hosted-production.yml` runs it before deploying.
export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    globalSetup: ["./scripts/test-databases.mjs"],
    setupFiles: ["./scripts/test-database-env.mjs"],
    include: ["server/tests/desktop-compat.gate.ts"],
    testTimeout: 180000,
    hookTimeout: 180000,
    maxWorkers: 1,
  },
});
