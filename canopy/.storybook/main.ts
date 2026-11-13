import type { StorybookConfig } from '@storybook/react-vite';
import { workspaceSourceAliases } from '../../scripts/workspace-sources.mjs';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: '@storybook/react-vite',
  viteFinal: (config) => {
    config.resolve ??= {};
    config.resolve.alias = {
      ...((config.resolve.alias as Record<string, string>) ?? {}),
      ...workspaceSourceAliases(),
    };
    return config;
  },
};

export default config;
