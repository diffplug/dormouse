import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the extension host. The `vscode` module only exists inside a
 * running VS Code, so it is aliased to a stub; everything under test either
 * imports it as a type (erased) or touches the small surface the stub carries
 * (the `log.ts` output channel, and `Uri.file` for `webview-html.ts`).
 *
 * Modules that genuinely need the real editor — commands, webview hosting — are
 * not covered here and would need `@vscode/test-electron`.
 */
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('test/vscode-stub.ts', import.meta.url)),
      // Shared `lib/` modules the extension host bundles reach the `dor` CLI's
      // types through the `dor/*` tsconfig path. Vite reads no tsconfig paths and
      // `dor` has no package exports, so resolve it to source — the same alias
      // `lib/vite.config.ts` and standalone use.
      dor: fileURLToPath(new URL('../dor/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
