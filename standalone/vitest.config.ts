import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      dor: path.resolve(import.meta.dirname, '../dor/src'),
      'dormouse-lib': path.resolve(import.meta.dirname, '../lib/src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
