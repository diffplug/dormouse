import type { Meta, StoryObj } from '@storybook/react';
import { fireEvent, userEvent, within } from 'storybook/test';
import { ModalSurface } from '../components/design';
import { RemoteControlSection } from '../components/RemoteControlSection';
import {
  enrolledStatus,
  OFFER_STATUS,
  UNENROLLED_STATUS,
  setupQrResult,
} from '../host/remote/test-burrow-link';
import { TEST_SETUP_PASSWORD } from '../remote/test-setup-password';

/**
 * The Settings dialog's Remote control section — the one step a self-hoster
 * cannot skip (`docs/specs/relay.md`, "Remote control, in the Settings
 * dialog"). Rendered on its own rather than through `SettingsDialog` so these
 * stories are about the enrollment states themselves; `SettingsDialog`'s
 * `WithRemoteControl` covers it in place.
 *
 * Every state comes from the `primedBurrow` parameter, because the section
 * reads its whole world from `getPlatform().burrow` and renders nothing
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
  // reads a module-singleton store (`burrow-status-store.ts`: `state` is module
  // scope, and the link is captured only when `listeners.size === 1`), so N
  // sections sharing one JS realm share one status however many links exist —
  // and the other stories on that page reset `platform.burrow` to
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

/** {@link settled} for the states behind the setup panel, which has to be opened. */
function setupPanel(text: string | RegExp) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Set up a phone' }));
    await canvas.findByText(text);
  };
}

/** A machine that has never enrolled: server, setup password, name. */
export const Unenrolled: Story = {
  parameters: {
    primedBurrow: { status: UNENROLLED_STATUS },
    docs: { story: { height: '390px' } },
  },
  play: settled('Connect'),
};

/**
 * The refusal that matters most. A Burrow bundle only talks to the origins baked
 * into it at build time, so a stock build pointed at a self-host server fails
 * *before* the password leaves the machine — and the form has to say that,
 * rather than let it read as a wrong password.
 */
export const EnrollRefused: Story = {
  parameters: {
    primedBurrow: {
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

    await canvas.findByLabelText('Relay');
    fill('Relay', 'https://ned-mac.tail9c2f1.ts.net');
    fill('Setup password', TEST_SETUP_PASSWORD);
    fill('Name for this Burrow', 'Work laptop');
    await userEvent.click(canvas.getByRole('button', { name: 'Connect' }));
    await canvas.findByText(/This build will not connect/);
  },
};

/**
 * The installer ran on this machine, so there is nothing to type: the offer
 * card leads with the origin it found and a name already filled in, and the
 * three-field form folds away behind "Enroll with a different Relay…". The
 * refusal {@link EnrollRefused} shows reaches this card in the same words —
 * `RemoteControlSection.test.tsx` pins that.
 */
export const OfferAvailable: Story = {
  parameters: {
    primedBurrow: { status: OFFER_STATUS },
    docs: { story: { height: '300px' } },
  },
  play: settled('A Dormouse Relay is installed on this machine.'),
};

/** Enrolled, relay socket still opening. No event fires for this → the 2 s poll. */
export const Connecting: Story = {
  parameters: { primedBurrow: { status: enrolledStatus({ connection: 'connecting' }) } },
  play: settled('Connecting…'),
};

/** Connected, but nothing has paired yet — the state right after enrolling. */
export const ConnectedNoDevices: Story = {
  parameters: { primedBurrow: { status: enrolledStatus() } },
  play: settled('No phone has paired with this machine yet.'),
};

/** After a successful pairing ceremony. */
export const ConnectedOneDevice: Story = {
  parameters: { primedBurrow: { status: enrolledStatus({ pairedClients: 1 }) } },
  play: settled('1 paired phone.'),
};

/** Plural, and a long tailnet origin exercising the URL line's `break-all`. */
export const ConnectedManyDevices: Story = {
  parameters: {
    primedBurrow: {
      status: enrolledStatus({
        relayUrl: 'https://neds-16-inch-macbook-pro-2026.tail9c2f1.ts.net',
        pairedClients: 4,
      }),
    },
  },
  play: settled('4 paired phones.'),
};

/**
 * The only connection state with a button. `displaced` is terminal by design —
 * another instance took the relay slot and this one stood down — so nothing
 * brings it back on its own.
 */
export const Displaced: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus({ connection: 'displaced', pairedClients: 1 }) },
    docs: { story: { height: '280px' } },
  },
  play: settled(/Another Dormouse instance took/),
};

/** Disconnect asks first: it drops every paired phone until each pairs again. */
export const ConfirmingDisconnect: Story = {
  parameters: { primedBurrow: { status: enrolledStatus({ pairedClients: 2 }) } },
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Disconnect' }));
    await canvas.findByText('Paired phones will need to pair again.');
  },
};

/**
 * The QR-first path: the enrolled section mints a setup code and shows it, so a
 * phone is set up by pointing a camera at the laptop rather than by typing an
 * origin and a 64-hex password (`docs/specs/relay.md`, Setup tokens).
 */
export const SetupPhoneQr: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupQr: setupQrResult() },
    docs: { story: { height: '520px' } },
  },
  // The one setup-panel story that settles on the QR's accessible name rather
  // than on text, so it cannot use {@link setupPanel}.
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Set up a phone' }));
    await canvas.findByRole('img', { name: 'Setup code for this machine' });
  },
};

/**
 * The phone redeemed the code. The Relay tells the Burrow that minted it, which
 * is the only way this panel can know — the redemption happened on the phone —
 * and a spent code must stop being offered.
 */
export const SetupPhoneRedeemed: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupInvitation: 'reserved' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/This code is used up/),
};

/**
 * The code is spent and nobody decided anything — the relay socket went while
 * the request was up, or this machine stopped. Every ceremony a person *did*
 * answer carries an outcome and gets the sentence for it below, so this is the
 * one frame left where the panel can only say the code is finished.
 */
export const SetupPhoneFinished: Story = {
  parameters: {
    primedBurrow: {
      status: enrolledStatus({ pairedClients: 1 }),
      setupInvitation: 'consumed',
    },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/This setup code is finished/),
};

/**
 * The Burrow discarded the code before anyone scanned it — its relay socket went,
 * or a newer mint evicted it. **Not a scan**, so it must not send anyone to a
 * phone (`docs/specs/remote-security-model.md` → Pairing).
 */
export const SetupPhoneDropped: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupInvitation: 'dropped' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/no longer valid/),
};

/** The TTL ran out with the panel still open and nobody scanning. */
export const SetupPhoneExpired: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupInvitation: 'expired' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/This code expired/),
};

/**
 * The six ways a ceremony ends, each in its own fixed sentence.
 *
 * They all spend the code and dismiss the modal, and the paired count above is
 * absolute — so without these the panel said the same thing for a phone that
 * paired and for one whose digits were mistyped
 * (`docs/specs/relay.md` → "Remote control, in the Settings dialog").
 */
export const PairingOutcomePaired: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus({ pairedClients: 1 }), setupOutcome: 'paired' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/This phone is paired/),
};

/** The one this whole outcome exists for: one attempt, and it was spent. */
export const PairingOutcomeCodeMismatch: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'code-mismatch' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/The two digits did not match/),
};

export const PairingOutcomeCancelled: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'cancelled' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/You cancelled this request/),
};

export const PairingOutcomeExpired: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'expired' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/The request ran out of time/),
};

export const PairingOutcomeSuperseded: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'superseded' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/Another pairing request replaced this one/),
};

export const PairingOutcomeBurrowError: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'burrow-error' },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel(/could not finish pairing/),
};

/**
 * The same report with the panel shut, which is where it lands when the modal
 * was answered from a dialog that never opened one — the count is then the only
 * other thing that could have said anything, and it did not move.
 */
export const PairingOutcomeWithPanelClosed: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'code-mismatch' },
    docs: { story: { height: '260px' } },
  },
  play: settled(/The two digits did not match/),
};

/**
 * The mint failed — a relay that is down, a Relay that refused. It lands in the
 * enrolled view's one error slot, the same one Reconnect and Disconnect use.
 */
export const SetupPhoneRefused: Story = {
  parameters: {
    primedBurrow: {
      status: enrolledStatus(),
      setupQrError: 'could not mint a setup code (503)',
    },
    docs: { story: { height: '340px' } },
  },
  play: setupPanel('could not mint a setup code (503)'),
};

/**
 * There *is* a Burrow service and it refused — distinct from a build that has
 * none, which renders nothing at all rather than an error.
 */
export const BurrowServiceError: Story = {
  parameters: { primedBurrow: { statusError: 'It did not answer.' } },
  play: settled(/Could not reach this machine’s remote-control service/),
};
