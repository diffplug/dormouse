import type { Meta, StoryObj } from '@storybook/react';
// Importing from App.tsx runs its `index.css` side-effect import, loading the
// shared --color-* theme tokens. The auth chrome is built from the three VSCode
// list pairs (docs/specs/theme.md); switch themes with the Storybook toolbar.
import { SetupOrSignin } from '../remote/pocket-app/App';
import { PhoneFrame } from './PhoneFrame';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The first-time-setup panel is internal state (`useState(showSetup)`), toggled
// by the `+ First-time setup` disclosure. Click it so the setup fields render.
async function openSetup({ canvasElement }: { canvasElement: HTMLElement }) {
  await wait(50);
  const disclosure = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.includes('First-time setup'),
  );
  disclosure?.click();
  await wait(50);
}

const meta: Meta<typeof SetupOrSignin> = {
  title: 'Pocket/SetupOrSignin',
  component: SetupOrSignin,
  parameters: { layout: 'centered' },
  args: {
    busy: null,
    error: null,
    onSignin: () => {},
    onSetup: () => {},
  },
  decorators: [
    (Story) => (
      <PhoneFrame>
        <Story />
      </PhoneFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SetupOrSignin>;

// Idle: welcome copy, "Sign in with passkey", setup collapsed.
export const Welcome: Story = {};

// Disclosure opened → setup password + label fields + "Create passkey & sign in".
export const SetupExpanded: Story = {
  play: openSetup,
};

// Sign-in in flight: primary button reads "Signing in…" and is disabled.
export const SigningIn: Story = {
  args: { busy: 'signin' },
};

// Account creation in flight: setup panel open with the button reading "Creating…".
export const CreatingAccount: Story = {
  args: { busy: 'setup' },
  play: openSetup,
};

// Failed sign-in: the red error banner above the button.
export const Error: Story = {
  args: { error: 'Passkey sign-in was cancelled.' },
};
