import type { Meta, StoryObj } from '@storybook/react';
// Importing from App.tsx runs `pocket-chrome`'s `index.css` side-effect import,
// so Tailwind's utilities load for these stories. Storybook manages the theme
// tokens (`--vscode-*`) itself.
import { SetupOrSignin } from '../remote/pocket-app/App';
import { PASSKEY_ALREADY_REGISTERED_MESSAGE } from '../remote/client/webauthn';
import { PhoneFrame } from './PhoneFrame';

const meta: Meta<typeof SetupOrSignin> = {
  title: 'Pocket/SetupOrSignin',
  component: SetupOrSignin,
  parameters: { layout: 'centered' },
  args: {
    busy: null,
    error: null,
    // Default to the screen a phone that has never been here gets.
    hasPriorUse: false,
    arrivedByCamera: false,
    passkeyAlreadyRegistered: false,
    needsInstall: false,
    onScan: () => {},
    onSignin: () => {},
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

// No stored passkey material: scanning leads — it is the only thing a browser
// holding nothing can complete — with sign-in as the secondary path, since a
// passkey syncs and a fresh browser may already hold one.
export const FirstRun: Story = {};

// Canonical Pocket default theme, pinned so Chromatic captures the dark shell.
export const FirstRunKimbieDark: Story = {
  globals: { theme: 'Kimbie Dark' },
};

// iOS in a browser tab: the Home Screen guidance sits above the scan action,
// where it still precedes the passkey a scan mints.
export const FirstRunNeedsInstall: Story = {
  args: { needsInstall: true },
};

// Opened by the phone's own camera. The fragment is already erased and its
// token unspent, so the only thing this run can say is where the scan actually
// has to happen (`docs/specs/pocket-app.md` -> the auth screen).
export const ArrivedByCamera: Story = {
  args: { arrivedByCamera: true },
};

// The same arrival on a phone that has been here before: sign-in still leads,
// and the bootstrap notice still names the step the camera could not perform.
export const ArrivedByCameraReturning: Story = {
  args: { arrivedByCamera: true, hasPriorUse: true },
};

// The authenticator refused to duplicate a passkey the server already has. The
// only screen where nothing is stored and sign-in still leads: that refusal is
// proof this device can sign in, where an empty store is merely unproven.
export const SigninAfterPasskeyExists: Story = {
  args: {
    hasPriorUse: false,
    passkeyAlreadyRegistered: true,
    error: PASSKEY_ALREADY_REGISTERED_MESSAGE,
  },
};

// The pairing ceremony in flight, started from this screen: every action locks
// and the scan button shows its spinner.
export const Pairing: Story = {
  args: { busy: 'pair' },
};

// A failed scan or pairing keeps the screen and reports itself.
export const SetupErrorFocused: Story = {
  args: { error: 'That pairing code has expired. Show a new one on the computer and scan it again.' },
};

// The return visit: welcome copy, "Sign in with passkey", scanning below it for
// a computer this phone has not paired with yet.
export const Welcome: Story = {
  args: { hasPriorUse: true },
};

// Sign-in in flight: primary button reads "Signing in…" and is disabled.
export const SigningIn: Story = {
  args: { hasPriorUse: true, busy: 'signin' },
};

// Failed sign-in: the red error text above the button.
export const Error: Story = {
  args: { hasPriorUse: true, error: 'Passkey sign-in was cancelled.' },
};
