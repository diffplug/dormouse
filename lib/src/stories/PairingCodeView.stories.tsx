import type { Meta, StoryObj } from '@storybook/react';
// Importing from App.tsx runs `pocket-chrome`'s `index.css` side-effect import,
// so Tailwind's utilities load for these stories.
import { PairingCodeView } from '../remote/pocket-app/App';
import { PhoneFrame } from './PhoneFrame';

const meta: Meta<typeof PairingCodeView> = {
  title: 'Pocket/PairingCodeView',
  component: PairingCodeView,
  parameters: { layout: 'centered' },
  args: { code: '07', onCancel: () => {} },
  decorators: [
    (Story) => (
      <PhoneFrame>
        <Story />
      </PhoneFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof PairingCodeView>;

// The whole screen: two digits, what to do with them, and a way out. The
// laptop's modal tells the user to cancel if the phone shows no code, so this
// is the screen that has to be unmistakable
// (`docs/specs/remote-security-model.md` -> Pairing).
export const Waiting: Story = {};

// Canonical Pocket default theme, pinned so Chromatic captures the dark shell.
export const WaitingKimbieDark: Story = {
  globals: { theme: 'Kimbie Dark' },
};

// A leading zero is a digit: the code is sampled uniformly over 00–99 and
// rendered as two characters either way.
export const LeadingZero: Story = {
  args: { code: '00' },
};

// The moment between the handshake completing and the code being sampled. It
// is deliberately not blank — a screen showing nothing is the state the
// laptop's copy tells the user to cancel on.
export const BeforeTheCode: Story = {
  args: { code: null },
};
