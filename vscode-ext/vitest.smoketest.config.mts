import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The webview boot smoketest, kept out of `pnpm test` on purpose: it needs a
 * built `media/` and a Chromium, neither of which a unit-test run should
 * require. CI gives it its own parallel job (`.github/workflows/ci.yml`).
 *
 * Same `vscode` stub as the unit config — the smoketest drives the real
 * `getWebviewHtml`, so it needs `Uri.file` for exactly the same reason.
 */
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('test/vscode-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.smoketest.ts'],
    // One browser launch plus a real page load; the default 5s is not enough.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
