import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  // `remote-lib-common` from source, as `tsconfig.json`'s `paths` resolve it for
  // tsc and every esbuild bundle: its package `exports` name a `dist` a clean
  // checkout has not built.
  resolve: {
    alias: {
      "remote-lib-common": fileURLToPath(
        new URL("../remote-lib-common/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["server/tests/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    maxWorkers: 1,
  },
});
