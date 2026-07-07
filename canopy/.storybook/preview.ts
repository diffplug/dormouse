import type { Preview } from '@storybook/react';
import { createElement, StrictMode } from 'react';

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    // Match lib's Storybook: exercise StrictMode (dev double-invoke) so the
    // terminal setup/dispose lifecycle gets the same correctness checks.
    (Story) => createElement(StrictMode, null, createElement(Story)),
  ],
};

export default preview;
