import type { Meta, StoryObj } from '@storybook/react';
// Importing the page's screens runs `pocket-chrome`'s `index.css` side-effect
// import, so Tailwind's utilities load for these stories.
import {
  ONE_TIME_INVALID_MESSAGE,
  ONE_TIME_INVALID_TITLE,
  ONE_TIME_NOT_CONNECTED_TITLE,
  OneTimeCode,
  OneTimeConnecting,
  OneTimeNotice,
  OneTimeReady,
} from '../remote/one-time-app/OneTimeApp';
import { ONE_TIME_DIRECT_FAILED_MESSAGE } from '../remote/client/one-time-client';
import { PhoneFrame } from './PhoneFrame';

// The one-time page's screens, each on its own (`docs/specs/one-time.md` ->
// "Phone page"); the wall after them is Pocket's, in `PocketWall.stories.tsx`.
const meta: Meta = {
  title: 'Pocket/OneTimeApp',
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <PhoneFrame>
        <Story />
      </PhoneFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj;

// A live link, before the tap that opens the only socket the page ever opens.
export const Ready: Story = {
  render: () => <OneTimeReady expiresInMs={4 * 60_000 + 12_000} onConnect={() => {}} />,
};

// Canonical Pocket default theme, pinned so the dark shell is captured.
export const ReadyKimbieDark: Story = {
  ...Ready,
  globals: { theme: 'Kimbie Dark' },
};

// The two digits the person types on the computer.
export const Code: Story = {
  render: () => <OneTimeCode code="42" onCancel={() => {}} />,
};

// Confirmed on the computer; the direct path is forming.
export const Connecting: Story = {
  render: () => <OneTimeConnecting onCancel={() => {}} />,
};

// No direct path formed: the one failure with advice beyond a new link.
export const EndedDirectFailed: Story = {
  render: () => (
    <OneTimeNotice title={ONE_TIME_NOT_CONNECTED_TITLE} message={ONE_TIME_DIRECT_FAILED_MESSAGE} />
  ),
};

// A page opened with no link, or one that does not parse.
export const InvalidLink: Story = {
  render: () => <OneTimeNotice title={ONE_TIME_INVALID_TITLE} message={ONE_TIME_INVALID_MESSAGE} />,
};
