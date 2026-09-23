// Argos visual tests: every Storybook story runs in a real browser through the
// Storybook Vitest addon, and `@argos-ci/storybook` screenshots it after its
// `play` settles. Separate from `vite.config.ts` so `pnpm test` never starts a
// browser. `pnpm test:argos` writes to `./screenshots/<browser>`; it uploads only on CI.
import path from 'path';
import { defineConfig, mergeConfig, type TestProjectInlineConfiguration } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { argosVitestPlugin } from '@argos-ci/storybook/vitest-plugin';
import viteConfig from './vite.config';

const configDir = path.join(import.meta.dirname, '.storybook');

// Argos names a screenshot by story id alone, so each browser writes its own
// directory and uploads it as its own build; a shared root would let one
// browser's files overwrite the other's. Chromium and WebKit mirror Chromatic's
// Chrome and Safari.
function storybookProject(browser: 'chromium' | 'webkit'): TestProjectInlineConfiguration {
  return {
    extends: true,
    plugins: [
      storybookTest({ configDir }),
      argosVitestPlugin({
        uploadToArgos: !!process.env.CI,
        buildName: `storybook-${browser}`,
        root: `./screenshots/${browser}`,
      }),
    ],
    test: {
      name: `storybook-${browser}`,
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(
          browser === 'chromium'
            ? // Glyphs render identically on macOS and the Linux runner.
              { launchOptions: { args: ['--disable-lcd-text', '--font-render-hinting=none'] } }
            : {},
        ),
        instances: [{ browser }],
        // Chromatic's default capture width; Vitest's default is a 414px phone.
        viewport: { width: 1200, height: 900 },
      },
      setupFiles: ['.storybook/vitest.setup.ts'],
    },
  };
}

export default mergeConfig(
  viteConfig,
  defineConfig({
    // Read by `lib/.storybook/preview.ts` to apply the same snapshot freezes as
    // `isChromatic()`. A compile-time flag because the preview's freezes run at
    // import, before any setup-file code could set a global.
    define: { __ARGOS_SNAPSHOT__: 'true' },
    test: { projects: [storybookProject('chromium'), storybookProject('webkit')] },
  }),
);
