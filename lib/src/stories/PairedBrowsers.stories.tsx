import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { PAIRING_DEVICE_LABELS, type PairedBrowserV1 } from 'remote-lib-common';
import { DEVICES_UNSUPPORTED_MESSAGE, type DeviceListing, type DeviceRevocation } from '../remote/client/pocket-client';
import {
  CONFIRM_REVOKE_LABEL,
  PairedBrowsersScreen,
  REVOKE_LABEL,
  SHOW_PAIRED_BROWSERS,
  PairedBrowsers,
} from '../remote/pocket-app/PairedBrowsers';
import { pkButton } from '../remote/pocket-app/pocket-chrome';
import { PhoneFrame } from './PhoneFrame';

const HOUR = 60 * 60_000;
const DEVICES: PairedBrowserV1[] = [
  {
    id: '3fa94c17d02be681',
    label: PAIRING_DEVICE_LABELS[0],
    approvedAt: Date.UTC(2025, 2, 3),
    lastSeenAt: Date.now() - 30_000,
    self: true,
  },
  {
    id: 'c81e7720aa5d94f3',
    label: PAIRING_DEVICE_LABELS[1],
    approvedAt: Date.UTC(2025, 4, 18),
    lastSeenAt: Date.now() - 3 * HOUR,
    self: false,
  },
  {
    id: '07bd1e64c3f2a958',
    label: 'Unknown device',
    approvedAt: Date.UTC(2024, 10, 2),
    lastSeenAt: null,
    self: false,
  },
];

function session(listing: DeviceListing, revocation: DeviceRevocation = { ok: true, self: false }) {
  return {
    listDevices: async () => listing,
    revokeDevice: async () => revocation,
  };
}

const LISTED = session({ ok: true, devices: DEVICES });

const meta: Meta<typeof PairedBrowsersScreen> = {
  title: 'Pocket/PairedBrowsers',
  component: PairedBrowsersScreen,
  parameters: { layout: 'centered' },
  args: {
    title: 'Studio iMac',
    leading: <button type="button" className={pkButton({ tone: 'ghost', size: 'sm' })}>‹ Burrows</button>,
    session: LISTED,
    onSelfRevoked: () => {},
    onAccountLost: () => {},
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
type Story = StoryObj<typeof PairedBrowsersScreen>;

/** Each record on this Burrow, this browser's marked; nothing merged across Burrows. */
export const Listed: Story = {};

/** The confirmation, inline, saying what the tap does before the passkey prompt. */
export const ConfirmingAnother: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: `${REVOKE_LABEL} ${DEVICES[1]!.label} ${DEVICES[1]!.id}` }));
    await expect(await canvas.findByRole('button', { name: CONFIRM_REVOKE_LABEL })).toBeVisible();
  },
};

/** This browser's own record, whose session ends with it. */
export const ConfirmingItself: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: `${REVOKE_LABEL} ${DEVICES[0]!.label} ${DEVICES[0]!.id}` }));
    await expect(await canvas.findByText(/this session ends/)).toBeVisible();
  },
};

/** A refused proof, in fixed words, with the confirmation left open to try again. */
export const Refused: Story = {
  args: { session: session({ ok: true, devices: DEVICES }, { ok: false, message: 'The computer could not verify your passkey, so nothing changed. Try again.' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: `${REVOKE_LABEL} ${DEVICES[1]!.label} ${DEVICES[1]!.id}` }));
    await userEvent.click(await canvas.findByRole('button', { name: CONFIRM_REVOKE_LABEL }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
  },
};

/** A Burrow older than the list: not a computer with no browsers. */
export const OlderBurrow: Story = {
  args: { session: session({ ok: false, message: DEVICES_UNSUPPORTED_MESSAGE, unsupported: true }) },
};

/** Where Settings shows it: nothing asked of the Burrow until the tap, which may prompt. */
export const InSettings: StoryObj<typeof PairedBrowsers> = {
  render: () => (
    <div className="grid gap-5 p-3 font-mono text-sm">
      <PairedBrowsers session={LISTED} onSelfRevoked={() => {}} onAccountLost={() => {}} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('button', { name: SHOW_PAIRED_BROWSERS })).toBeVisible();
  },
};
