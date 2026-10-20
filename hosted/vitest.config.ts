import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../scripts/workspace-sources.mjs";
export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    include: ["server/tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    maxWorkers: 1,
  },
});
