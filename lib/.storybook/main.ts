import type { StorybookConfig } from '@storybook/react-vite';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: '@storybook/react-vite',
  viteFinal: (config) => {
    const stub = path.resolve(here, 'tauri-stub.ts');
    const windowMock = path.resolve(here, 'tauri-window-mock.ts');
    config.resolve ??= {};
    config.resolve.alias = {
      ...((config.resolve.alias as Record<string, string>) ?? {}),
      '@tauri-apps/api/window': windowMock,
      '@tauri-apps/api/app': stub,
      '@tauri-apps/api/core': stub,
      '@tauri-apps/plugin-shell': stub,
      '@tauri-apps/plugin-updater': stub,
      'dormouse-lib': path.resolve(here, '..', 'src'),
      // Mirror tsconfig.app.json's `dor/* → ../dor/src/*` mapping so stories
      // that import `Wall` (which pulls `dor/commands/*`, `dor/protocol`)
      // resolve. Storybook's Vite doesn't read tsconfig paths, so without this
      // any Wall-importing story fails with "Failed to resolve import 'dor/…'".
      // Safe next to `dormouse-lib`: a string alias only matches `dor` or `dor/…`.
      dor: path.resolve(here, '..', '..', 'dor', 'src'),
      // Same reason: `Wall` → `RemotePairingModalHost` pulls in the remote host
      // modules, which import `server-lib-common`. Its package `exports` point
      // at a `dist` the Storybook/Chromatic job never builds, so alias the bare
      // specifier to source too.
      'server-lib-common': path.resolve(here, '..', '..', 'server-lib-common', 'src'),
      // And `Wall` → `useDorControl` → `connect-port` imports
      // `dor-lib-common/agent-browser`, whose `exports` point at the same kind of
      // unbuilt `dist`. The directory alias covers the subpath and the bare
      // specifier both.
      'dor-lib-common': path.resolve(here, '..', '..', 'dor-lib-common', 'src'),
    };
    return config;
  },
};

export default config;
