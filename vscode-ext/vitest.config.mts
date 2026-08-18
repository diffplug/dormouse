import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the extension host. The `vscode` module only exists inside a
 * running VS Code, so it is aliased to a stub; everything under test either
 * imports it as a type (erased) or goes through `log.ts`.
 *
 * Modules that genuinely need the real editor — commands, webview hosting — are
 * not covered here and would need `@vscode/test-electron`.
 */
export default defineConfig({
  resolve: {
    alias: {
      vscode: new URL('test/vscode-stub.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
