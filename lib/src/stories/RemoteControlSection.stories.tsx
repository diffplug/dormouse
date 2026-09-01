import type { Meta, StoryObj } from '@storybook/react';
import { fireEvent, userEvent, within } from 'storybook/test';
import { ModalSurface } from '../components/design';
import { RemoteControlSection } from '../components/RemoteControlSection';
import {
  enrolledStatus,
  OFFER_STATUS,
  UNENROLLED_STATUS,
} from '../host/remote/test-remote-host-link';

/**
 * The Settings dialog's Remote control section — the one step a self-hoster
 * cannot skip (`docs/specs/server.md`, "Remote control, in the Settings
 * dialog"). Rendered on its own rather than through `SettingsDialog` so these
 * stories are about the enrollment states themselves; `SettingsDialog`'s
 * `WithRemoteControl` covers it in place.
 *
 * Every state comes from the `primedRemoteHost` parameter, because the section
 * reads its whole world from `getPlatform().remoteHost` and renders nothing
 * without one. The leading rule is the section's own `border-t` — it normally
 * separates it from the push settings above.
 */
function RemoteControlStory() {
  return (
    <div className="flex justify-center p-6">
      <ModalSurface padding="spacious" className="w-full max-w-[26rem]">
        <RemoteControlSection />
      </ModalSurface>
    </div>
  );
}

const meta: Meta<typeof RemoteControlStory> = {
  title: 'Modals/RemoteControlSection',
  component: RemoteControlStory,
  // Embedded in a docs page, each of these needs its own frame. The section
  // reads a module-singleton store (`host-status-store.ts`: `state` is module
  // scope, and the link is captured only when `listeners.size === 1`), so N
  // sections sharing one JS realm share one status however many links exist —
  // and the other stories on that page reset `platform.remoteHost` to
  // `undefined` underneath them. Separate realms is the only fix short of
  // rebuilding the store around a docs page. An iframe does not grow to its
  // content, hence the explicit height; stories taller than this override it.
  parameters: { docs: { story: { inline: false, height: '250px' } } },
};

export default meta;
type Story = StoryObj<typeof RemoteControlStory>;

/**
 * The status command is a round trip, so every story opens on "Checking…".
 * Waiting for the settled text keeps Chromatic off that frame — and asserts the
 * story actually reached the state it claims, rather than rendering an empty
 * section because the stub never arrived.
 */
function settled(text: string | RegExp) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await within(canvasElement).findByText(text);
  };
}

/** A machine that has never enrolled: server, setup password, name. */
export const Unenrolled: Story = {
  parameters: {
    primedRemoteHost: { status: UNENROLLED_STATUS },
    docs: { story: { height: '390px' } },
  },
  play: settled('Connect'),
};

/**
 * The refusal that matters most. A Host bundle only talks to the origins baked
 * into it at build time, so a stock build pointed at a self-host server fails
 * *before* the password leaves the machine — and the form has to say that,
 * rather than let it read as a wrong password.
 */
export const EnrollRefused: Story = {
  parameters: {
    primedRemoteHost: {
      status: UNENROLLED_STATUS,
      enrollError:
        'This build will not connect to https://ned-mac.tail9c2f1.ts.net. Allowed: https://*.dormouse.sh wss://*.dormouse.sh',
    },
    docs: { story: { height: '440px' } },
  },
  // `fireEvent.change` rather than `userEvent.type`: these are controlled
  // inputs, so per-character typing costs a render each — ten seconds to fill
  // three fields, long enough that a reader scrolling past sees a half-typed
  // form — and typing them without awaiting a render between keystrokes
  // (`delay: null`) loses every character but the last. One change event with
  // the whole value is what a paste does anyway.
  play: async (context) => {
    const canvas = within(context.canvasElement);
    const fill = (label: string, value: string) =>
      fireEvent.change(canvas.getByLabelText(label), { target: { value } });

    await canvas.findByLabelText('Server');
    fill('Server', 'https://ned-mac.tail9c2f1.ts.net');
    fill('Setup password', 'correct horse battery staple');
    fill('Name for this machine', 'Work laptop');
    await userEvent.click(canvas.getByRole('button', { name: 'Connect' }));
    await canvas.findByText(/This build will not connect/);
  },
};

/**
 * The installer ran on this machine, so there is nothing to type: the offer
 * card leads with the origin it found and a name already filled in, and the
 * three-field form folds away behind "Enroll with a different server…". The
 * one-time token is not in this frame anywhere — the service keeps it off the
 * bridge and re-reads the file when Enroll is pressed.
 */
export const OfferAvailable: Story = {
  parameters: {
    primedRemoteHost: { status: OFFER_STATUS },
    docs: { story: { height: '300px' } },
  },
  play: settled('A Dormouse server is installed on this machine.'),
};

/**
 * The same refusal as {@link EnrollRefused}, reached from the one-click path: a
 * server installed *here* can still sit on an origin a stock build was never
 * compiled to reach, and the card has to say so rather than fail silently.
 */
export const OfferEnrollRefused: Story = {
  parameters: {
    primedRemoteHost: {
      status: OFFER_STATUS,
      enrollError:
        'This build will not connect to https://ned-mac.tail9c2f1.ts.net. Allowed: https://*.dormouse.sh wss://*.dormouse.sh',
    },
    docs: { story: { height: '360px' } },
  },
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Enroll' }));
    await canvas.findByText(/This build will not connect/);
  },
};

/** Enrolled, relay socket still opening. No event fires for this → the 2 s poll. */
export const Connecting: Story = {
  parameters: { primedRemoteHost: { status: enrolledStatus({ connection: 'connecting' }) } },
  play: settled('Connecting…'),
};

/** Connected, but nothing has paired yet — the state right after enrolling. */
export const ConnectedNoDevices: Story = {
  parameters: { primedRemoteHost: { status: enrolledStatus() } },
  play: settled('No phone has paired with this machine yet.'),
};

/** After a successful pairing ceremony. */
export const ConnectedOneDevice: Story = {
  parameters: { primedRemoteHost: { status: enrolledStatus({ pairedClients: 1 }) } },
  play: settled('1 paired device.'),
};

/** Plural, and a long tailnet origin exercising the URL line's `break-all`. */
export const ConnectedManyDevices: Story = {
  parameters: {
    primedRemoteHost: {
      status: enrolledStatus({
        serverUrl: 'https://neds-16-inch-macbook-pro-2026.tail9c2f1.ts.net',
        pairedClients: 4,
      }),
    },
  },
  play: settled('4 paired devices.'),
};

/**
 * The only connection state with a button. `displaced` is terminal by design —
 * another instance took the relay slot and this one stood down — so nothing
 * brings it back on its own.
 */
export const Displaced: Story = {
  parameters: {
    primedRemoteHost: { status: enrolledStatus({ connection: 'displaced', pairedClients: 1 }) },
    docs: { story: { height: '280px' } },
  },
  play: settled(/Another Dormouse instance took/),
};

/** Disconnect asks first: it drops every paired phone until each pairs again. */
export const ConfirmingDisconnect: Story = {
  parameters: { primedRemoteHost: { status: enrolledStatus({ pairedClients: 2 }) } },
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Disconnect' }));
    await canvas.findByText('Paired phones will need to pair again.');
  },
};

/**
 * There *is* a Host service and it refused — distinct from a build that has
 * none, which renders nothing at all rather than an error.
 */
export const HostServiceError: Story = {
  parameters: { primedRemoteHost: { statusError: 'The Host service did not answer.' } },
  play: settled(/Could not reach this machine’s Host service/),
};
