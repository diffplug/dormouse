import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
// Importing from App.tsx runs its `index.css` side-effect import, so Tailwind's
// utilities load for these stories. Storybook manages the theme tokens
// (`--vscode-*`) itself.
import { SetupOrSignin } from '../remote/pocket-app/App';
import { PhoneFrame } from './PhoneFrame';

// The first-time-setup panel is internal state (`useState(showSetup)`), toggled
// by the `+ First-time setup` disclosure. Click it so the setup fields render.
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

// Canonical Pocket default theme, pinned so Chromatic captures the dark shell.
export const WelcomeKimbieDark: Story = {
  globals: { theme: 'Kimbie Dark' },
};

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

// Failed sign-in: the red error text above the button.
export const Error: Story = {
  args: { error: 'Passkey sign-in was cancelled.' },
};

// A setup failure keeps the disclosure open; leave the password focused to
// snapshot the focus ring and enabled setup action too.
export const SetupErrorFocused: Story = {
  args: { error: 'The setup password was rejected.' },
  play: async (context) => {
    await openSetup(context);
    const password = within(context.canvasElement).getByLabelText('Setup password');
    await userEvent.type(password, 'incorrect password');
  },
};
