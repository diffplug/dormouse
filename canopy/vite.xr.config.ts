import { defineConfig } from 'vite';
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { workspaceSourceAliases } from '../scripts/workspace-sources.mjs';

// Not `vite.config.ts`: Storybook's react-vite builder loads that name from the package root, and
// the iWSDK plugin must stay out of Storybook.
export default defineConfig({
  root: 'xr',
  resolve: { alias: workspaceSourceAliases() },
  plugins: [
    iwsdkDev({
      emulator: { device: 'metaQuest3' },
      // `ai` and `workspace` omitted: the plugin's own Playwright browser and MCP server stay off,
      // and the app is driven through `dor agent-browser`.
      // localhost is already a secure context, so WebXR needs no self-signed certificate.
      https: false,
    }),
  ],
});
