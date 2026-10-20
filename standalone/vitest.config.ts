import { defineConfig } from 'vitest/config';
import { workspaceSourceAliases } from '../scripts/workspace-sources.mjs';

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
