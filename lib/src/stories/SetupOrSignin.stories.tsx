import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
// Importing from App.tsx runs its `index.css` side-effect import, so Tailwind's
// utilities load for these stories. Storybook manages the theme tokens
// (`--vscode-*`) itself.
import { SetupOrSignin } from '../remote/pocket-app/App';
import { PhoneFrame } from './PhoneFrame';

// On the return visit, setup is internal state (`useState(showSetup)`) behind
// the `+ First-time setup` disclosure. Click it so the setup fields render.
async function openSetup({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: /First-time setup/ }));
}

const meta: Meta<typeof SetupOrSignin> = {
  title: 'Pocket/SetupOrSignin',
  component: SetupOrSignin,
  parameters: { layout: 'centered' },
  args: {
    busy: null,
    error: null,
    // Default to the screen a phone that has never been here gets.
    firstRun: true,
    needsInstall: false,
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

// No stored passkey material: setup leads, with sign-in as the secondary path.
export const FirstRun: Story = {};

// Canonical Pocket default theme, pinned so Chromatic captures the dark shell.
export const FirstRunKimbieDark: Story = {
  globals: { theme: 'Kimbie Dark' },
};

// iOS in a browser tab: the Home Screen guidance sits above the setup fields,
// where it still precedes the passkey and device key this screen mints.
export const FirstRunNeedsInstall: Story = {
  args: { needsInstall: true },
};

// Account creation in flight: the setup button reads "Creating…".
export const CreatingAccount: Story = {
  args: { busy: 'setup' },
};

// A setup failure keeps the fields on screen; leave the password focused to
// snapshot the focus ring and the enabled setup action too.
export const SetupErrorFocused: Story = {
  args: { error: 'The setup password was rejected.' },
  play: async ({ canvasElement }) => {
    const password = within(canvasElement).getByLabelText('Setup password');
    await userEvent.type(password, 'incorrect password');
  },
};

// The return visit: welcome copy, "Sign in with passkey", setup collapsed.
export const Welcome: Story = {
  args: { firstRun: false },
};

// Return visit with the disclosure opened → setup password + label fields.
export const SetupExpanded: Story = {
  args: { firstRun: false },
  play: openSetup,
};

// Sign-in in flight: primary button reads "Signing in…" and is disabled.
export const SigningIn: Story = {
  args: { firstRun: false, busy: 'signin' },
};

// Failed sign-in: the red error text above the button.
export const Error: Story = {
  args: { firstRun: false, error: 'Passkey sign-in was cancelled.' },
};
