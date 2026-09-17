import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["server/tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    maxWorkers: 1,
  },
});
