import type { StorybookConfig } from '@storybook/react-vite';
import path from 'path';
import { createRequire } from 'module';
import remarkGfm from 'remark-gfm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

const config: StorybookConfig = {
  // The narrative walkthrough in `docs/stories/` lives outside this package on
  // purpose: it is a doc about the product, not about `lib`, and it references
  // stories from here rather than defining any (MDX has not been able to define
  // a story since Storybook 7).
  stories: ['../src/**/*.stories.@(ts|tsx)', '../../docs/stories/**/*.mdx'],
  addons: [
    {
      name: '@storybook/addon-docs',
      // MDX is CommonMark only out of the box, so a GFM table renders as its own
      // pipes-and-dashes source text. The walkthrough opens on two of them (the
      // three parties, the four trust layers), which is the worst place in the
      // doc to print raw markdown at the reader.
      options: { mdxPluginOptions: { mdxCompileOptions: { remarkPlugins: [remarkGfm] } } },
    },
  ],
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
      // `docs/stories/*.mdx` lives outside this package, so Node resolution
      // from that file never reaches `lib/node_modules` and the docs blocks
      // fail to resolve. Resolve them here, where the package *is* installed,
      // and alias the exact specifier the MDX imports.
      '@storybook/addon-docs/blocks': requireFromHere.resolve(
        '@storybook/addon-docs/blocks',
      ),
    };
    return config;
  },
};

export default config;
