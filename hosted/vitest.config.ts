import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../scripts/workspace-sources.mjs";
export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceSourceAliases() },
  test: {
    include: ["server/tests/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    testTimeout: 60000,
    hookTimeout: 120000,
    maxWorkers: 1,
  },
});
