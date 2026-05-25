import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'dormouse-lib': path.resolve(__dirname, '../lib/src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
