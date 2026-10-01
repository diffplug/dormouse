import type { Meta, StoryObj } from '@storybook/react';
import { fireEvent, userEvent, within } from 'storybook/test';
import { ModalSurface } from '../components/design';
import { RemoteControlSection } from '../components/RemoteControlSection';
import {
  ANYWHERE_ON,
  enrolledStatus,
  OFFER_STATUS,
  SELF_HOST_RELAY_ORIGIN,
  SELF_HOST_UNENROLLED_STATUS,
  UNENROLLED_STATUS,
} from '../host/remote/test-burrow-link';
import { DEFAULT_RELAY_ORIGIN } from '../host/relay-origin';
import type { HostedEnrollmentState } from '../host/remote/service-protocol';
import { networkPolicyResult } from '../remote/network-policy';
import { TEST_SETUP_PASSWORD } from '../remote/test-setup-password';

/**
 * The Remote control choices in Settings → Network's Phones section — the one
 * step a self-hoster cannot skip (`docs/specs/relay.md`, "Remote control, in
 * the Settings dialog"). Rendered on its own rather than through
 * `SettingsDialog` so these stories are about the enrollment states
 * themselves; `SettingsDialog`'s `WithRemoteControl` covers it in place.
 *
 * Every state comes from the `primedBurrow` parameter, because the section
 * reads its whole world from `getPlatform().burrow` and renders nothing
 * without one.
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

/** The clock every story here reads. A setup code encodes its expiry, so a real
 *  clock would draw a different QR on every run. */
const STORY_NOW = Date.UTC(2026, 0, 1);

const meta: Meta<typeof RemoteControlStory> = {
  title: 'Modals/RemoteControlSection',
  component: RemoteControlStory,
  beforeEach: () => {
    const realNow = Date.now;
    Date.now = () => STORY_NOW;
    return () => { Date.now = realNow; };
  },
  // Embedded in a docs page, each of these needs its own frame. The section
  // reads a module-singleton store (`burrow-status-store.ts`: `state` is module
  // scope, and the link is captured only when `listeners.size === 1`), so N
  // sections sharing one JS realm share one status however many links exist —
  // and the other stories on that page reset `platform.burrow` to
  // `undefined` underneath them. Separate realms is the only fix short of
  // rebuilding the store around a docs page. An iframe does not grow to its
  // content, hence the explicit height; stories taller than this override it.
  parameters: { docs: { story: { inline: false, height: '410px' } } },
};

export default meta;
type Story = StoryObj<typeof RemoteControlStory>;

/**
 * The status command is a round trip, so every story opens empty. Waiting for
 * the settled text keeps the snapshot off that frame — and asserts the story
 * actually reached the state it claims, rather than rendering an empty section
 * because the stub never arrived.
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

/** Unfold Persistent Relay the way a user does; un-enrolled with no offer, it starts folded. */
async function openPersistent(canvasElement: HTMLElement) {
  await userEvent.click(
    await within(canvasElement).findByRole('button', { name: 'Persistent Relay' }),
  );
}

/**
 * What a stock build that has never enrolled opens on: a one-time connection and
 * a folded Persistent Relay.
 */
export const Choices: Story = {
  parameters: {
    primedBurrow: { status: UNENROLLED_STATUS },
    docs: { story: { height: '310px' } },
  },
  play: settled('Persistent Relay'),
};

/**
 * A stock build, Persistent Relay unfolded: its one Relay is Hosted's, which
 * it enrolls with by a code approved at the account (`docs/specs/hosted.md` →
 * "Burrow enrollment") — the name to keep, and the button that gets one.
 */
export const HostedPersistentRelay: Story = {
  parameters: {
    primedBurrow: { status: UNENROLLED_STATUS },
    docs: { story: { height: '470px' } },
  },
  play: async ({ canvasElement }) => {
    await openPersistent(canvasElement);
    await within(canvasElement).findByRole('button', { name: 'Enroll with hosted.dormouse.sh' });
  },
};

/** A Hosted enrollment waiting at the account, as `status` reports it. */
function hostedWaiting(accountFull = false): HostedEnrollmentState {
  return {
    status: 'waiting',
    userCode: '7KQM-X4TD',
    verificationUrl: 'https://hosted.dormouse.sh/enroll#7KQM-X4TD',
    expiresAt: STORY_NOW + 10 * 60_000,
    accountFull,
  };
}

/**
 * The code waiting for approval, in large type: the account page shows the
 * same one beside Approve. Open opens the page the service composed; the
 * service polls, so nothing here waits on a click but the person's.
 */
export const HostedEnrollWaiting: Story = {
  parameters: {
    primedBurrow: { status: { ...UNENROLLED_STATUS, hostedEnrollment: hostedWaiting() } },
    docs: { story: { height: '500px' } },
  },
  play: settled('7KQM-X4TD'),
};

/**
 * Approved by an account that already has as many computers as it may enroll:
 * the Relay keeps the approval, so the service polls on and this computer
 * enrolls once one is removed.
 */
export const HostedEnrollAccountFull: Story = {
  parameters: {
    primedBurrow: { status: { ...UNENROLLED_STATUS, hostedEnrollment: hostedWaiting(true) } },
    docs: { story: { height: '540px' } },
  },
  play: settled(/already has as many computers/),
};

/** Redeemed, and then refused here — the service's own sentence under the fixed one. */
export const HostedEnrollFailed: Story = {
  parameters: {
    primedBurrow: {
      status: {
        ...UNENROLLED_STATUS,
        hostedEnrollment: {
          status: 'ended',
          reason: 'failed',
          message:
            'keychain is locked Your account holds Burrow T7lzkkrPT8nx4m9zf90V4h, which this computer could ' +
            'not keep; remove it at https://hosted.dormouse.sh/account.',
        },
      },
    },
    docs: { story: { height: '560px' } },
  },
  play: settled(/keychain is locked/),
};

/** Approved, and the enrollment being saved and started: no code, nothing to cancel. */
export const HostedEnrollRedeeming: Story = {
  parameters: {
    primedBurrow: { status: { ...UNENROLLED_STATUS, hostedEnrollment: { status: 'redeeming' } } },
    docs: { story: { height: '420px' } },
  },
  play: settled('Approved. Enrolling this computer…'),
};

/**
 * The Relay says an earlier poll redeemed the code, whose answer never
 * arrived: the Burrow it names is the account's to remove.
 */
export const HostedEnrollAnswerLost: Story = {
  parameters: {
    primedBurrow: {
      status: {
        ...UNENROLLED_STATUS,
        hostedEnrollment: { status: 'ended', reason: 'answer-lost', burrowId: 'T7lzkkrPT8nx4m9zf90V4h' },
      },
    },
    docs: { story: { height: '560px' } },
  },
  play: settled('Manage computers at hosted.dormouse.sh'),
};

/**
 * Enrolled with Hosted: the self-host view, with the account that manages
 * this computer a link away. Held without a socket under Local networks.
 */
export const HostedEnrolled: Story = {
  parameters: {
    primedBurrow: {
      status: enrolledStatus({
        relayOrigin: DEFAULT_RELAY_ORIGIN,
        relayMode: 'hosted',
        accountOrigin: 'https://hosted.dormouse.sh',
        connection: 'stopped',
      }),
    },
  },
  play: settled('Manage computers at hosted.dormouse.sh'),
};

/**
 * A self-host build that has never enrolled, Persistent Relay unfolded: the
 * origin it was built for over the typed form — setup password, name. Its
 * one-time connection is off.
 */
export const Unenrolled: Story = {
  parameters: {
    primedBurrow: { status: SELF_HOST_UNENROLLED_STATUS },
    docs: { story: { height: '640px' } },
  },
  play: async ({ canvasElement }) => {
    await openPersistent(canvasElement);
    await within(canvasElement).findByRole('button', { name: 'Connect' });
  },
};

/**
 * A Relay whose `DORMOUSE_ORIGIN` is not the origin this build was made for:
 * enrollment is refused, naming both, and nothing is saved — and the form says
 * so in the service's words rather than letting it read as a wrong password.
 */
export const EnrollRefused: Story = {
  parameters: {
    primedBurrow: {
      status: SELF_HOST_UNENROLLED_STATUS,
      enrollError:
        `The Relay says its origin is https://ned-mac.local, but this build was made for ${SELF_HOST_RELAY_ORIGIN}. ` +
        'Rebuild Dormouse with DORMOUSE_RELAY_ORIGIN=https://ned-mac.local, or set the Relay\'s ' +
        `DORMOUSE_ORIGIN to ${SELF_HOST_RELAY_ORIGIN}.`,
    },
    docs: { story: { height: '740px' } },
  },
  // `fireEvent.change` rather than `userEvent.type`: these are controlled
  // inputs, so per-character typing costs a render each — long enough that a
  // reader scrolling past sees a half-typed form — and typing them without
  // awaiting a render between keystrokes (`delay: null`) loses every character
  // but the last. One change event with the whole value is what a paste does
  // anyway.
  play: async (context) => {
    const canvas = within(context.canvasElement);
    const fill = (label: string, value: string) =>
      fireEvent.change(canvas.getByLabelText(label), { target: { value } });

    await openPersistent(context.canvasElement);
    await canvas.findByLabelText('Setup password');
    fill('Setup password', TEST_SETUP_PASSWORD);
    fill('Name for this Burrow', 'Work laptop');
    await userEvent.click(canvas.getByRole('button', { name: 'Connect' }));
    await canvas.findByText(/The Relay says its origin is/);
  },
};

/**
 * The installer ran on this machine, so once Persistent Relay is unfolded there
 * is nothing to type: the offer card leads with the origin it found — the one
 * this build was made for — and a name already filled in, and the typed form
 * folds away behind "Enroll with the setup password…". The refusal
 * {@link EnrollRefused} shows reaches this card in the same words —
 * `RemoteControlSection.test.tsx` pins that.
 */
export const OfferAvailable: Story = {
  parameters: {
    primedBurrow: { status: OFFER_STATUS },
    docs: { story: { height: '650px' } },
  },
  play: async ({ canvasElement }) => {
    await openPersistent(canvasElement);
    await within(canvasElement).findByText('A Dormouse Relay is installed on this machine.');
  },
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
        relayOrigin: 'https://neds-16-inch-macbook-pro-2026.tail9c2f1.ts.net',
        pairedClients: 4,
      }),
    },
  },
  play: settled('4 paired phones.'),
};

/**
 * A latched state, so it gets a button. `displaced` is terminal by design —
 * another instance took the relay slot and this one stood down — so nothing
 * brings it back on its own.
 */
export const Displaced: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus({ connection: 'displaced', pairedClients: 1 }) },
    docs: { story: { height: '410px' } },
  },
  play: settled(/Another Dormouse instance took/),
};

/** The Hosted status a removed or de-entitled Burrow reports. */
const HOSTED_ENROLLED = {
  relayOrigin: DEFAULT_RELAY_ORIGIN,
  relayMode: 'hosted',
  accountOrigin: 'https://hosted.dormouse.sh',
  pairedClients: 1,
} as const;

/**
 * Removed from the account page: the Relay closed the socket 4001, and this
 * machine stood down. Enroll again clears the dead enrollment and begins a
 * new code.
 */
export const RemovedHosted: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus({ ...HOSTED_ENROLLED, connection: 'removed' }) },
    docs: { story: { height: '450px' } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('This computer was removed from your account at hosted.dormouse.sh.');
    await canvas.findByRole('button', { name: 'Enroll again' });
  },
};

/** A self-host Burrow its operator removed: Disconnect, then enroll again from the form. */
export const RemovedSelfHost: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus({ connection: 'removed', pairedClients: 1 }) },
  },
  play: settled(/This computer was removed from .* Disconnect to enroll it again\./),
};

/** The account lost its plan: the Relay closed the socket 4002. Reconnect tries again. */
export const NotEntitled: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus({ ...HOSTED_ENROLLED, connection: 'not-entitled' }) },
    docs: { story: { height: '450px' } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Your Hosted plan doesn’t include remote control right now.');
    await canvas.findByRole('button', { name: 'Reconnect' });
  },
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
    // No `setupQr`: the stub's default mints at request time, under the frozen
    // clock, where one built here would read the real clock at import.
    primedBurrow: { status: enrolledStatus() },
    docs: { story: { height: '720px' } },
  },
  // The one setup-panel story that settles on the QR's accessible name rather
  // than on text, so it cannot use {@link setupPanel}.
  play: async (context) => {
    // The QR is a lazily-imported chunk. Fetched cold after the click, it can
    // outlast `findByRole`'s 1 s on a loaded WebKit runner; loaded here first,
    // the panel's own import resolves from the module cache.
    await import('../components/QrCode');
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
    docs: { story: { height: '540px' } },
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
    docs: { story: { height: '500px' } },
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
    docs: { story: { height: '530px' } },
  },
  play: setupPanel(/no longer valid/),
};

/** The TTL ran out with the panel still open and nobody scanning. */
export const SetupPhoneExpired: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupInvitation: 'expired' },
    docs: { story: { height: '500px' } },
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
    docs: { story: { height: '480px' } },
  },
  play: setupPanel(/This phone is paired/),
};

/** The one this whole outcome exists for: one attempt, and it was spent. */
export const PairingOutcomeCodeMismatch: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'code-mismatch' },
    docs: { story: { height: '520px' } },
  },
  play: setupPanel(/The two digits did not match/),
};

export const PairingOutcomeCancelled: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'cancelled' },
    docs: { story: { height: '520px' } },
  },
  play: setupPanel(/You cancelled this request/),
};

export const PairingOutcomeExpired: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'expired' },
    docs: { story: { height: '520px' } },
  },
  play: setupPanel(/The request ran out of time/),
};

export const PairingOutcomeSuperseded: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'superseded' },
    docs: { story: { height: '520px' } },
  },
  play: setupPanel(/Another pairing request replaced this one/),
};

export const PairingOutcomeBurrowError: Story = {
  parameters: {
    primedBurrow: { status: enrolledStatus(), setupOutcome: 'burrow-error' },
    docs: { story: { height: '520px' } },
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
    docs: { story: { height: '440px' } },
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
    docs: { story: { height: '480px' } },
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

/**
 * A one-time link waiting for its phone: the code for the phone's camera, the
 * link as text to send it, and New link and Cancel — no auto-refresh, since a
 * link is single-use (`docs/specs/one-time.md` -> "Laptop UI"). Reached by the
 * button, like {@link SetupPhoneQr}, so the stub mints the link under the frozen
 * clock and the code draws the same every run.
 */
export const OneTimeWaiting: Story = {
  parameters: {
    primedBurrow: { status: UNENROLLED_STATUS },
    docs: { story: { height: '720px' } },
  },
  play: async (context) => {
    await import('../components/QrCode');
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'One-time connection' }));
    await canvas.findByRole('img', { name: 'One-time link for this machine' });
  },
};

/** A phone used the link and its request is up in the approval modal. */
export const OneTimeConfirming: Story = {
  parameters: {
    primedBurrow: {
      status: UNENROLLED_STATUS,
      oneTime: { status: 'confirming', label: 'Android phone', expiresAt: STORY_NOW + 60_000 },
    },
    docs: { story: { height: '380px' } },
  },
  play: settled('Type the two digits your phone shows into the dialog.'),
};

/** Confirmed; the phone is setting up the direct path over an allowed network. */
export const OneTimeConnecting: Story = {
  parameters: {
    primedBurrow: {
      status: UNENROLLED_STATUS,
      oneTime: { status: 'connecting', label: 'Android phone' },
    },
    docs: { story: { height: '360px' } },
  },
  play: settled('Connecting directly…'),
};

/** Live: the phone has every terminal here until either end stops it. */
export const OneTimeConnected: Story = {
  parameters: {
    primedBurrow: {
      status: UNENROLLED_STATUS,
      oneTime: { status: 'connected', label: 'Android phone', since: STORY_NOW },
    },
    docs: { story: { height: '360px' } },
  },
  play: settled('Android phone has full control of your terminals.'),
};

/**
 * The failure this feature is likeliest to hit: the phone is on another
 * network, or one that keeps devices apart, so no direct path formed. The
 * sentence names the fix.
 */
export const OneTimeEndedDirectFailed: Story = {
  parameters: {
    primedBurrow: {
      status: UNENROLLED_STATUS,
      oneTime: { status: 'ended', reason: 'direct-failed' },
    },
    docs: { story: { height: '380px' } },
  },
  play: settled(/couldn’t reach this computer directly/),
};

/**
 * The same failure under Anywhere, which has no allowed network to name: the
 * sentence suggests another network instead.
 */
export const OneTimeEndedDirectFailedAnywhere: Story = {
  parameters: {
    primedBurrow: {
      status: UNENROLLED_STATUS,
      network: networkPolicyResult(ANYWHERE_ON, 'hosted', []),
      oneTime: { status: 'ended', reason: 'direct-failed' },
    },
    docs: { story: { height: '380px' } },
  },
  play: settled(/such as cellular/),
};

/**
 * Local networks ended it for the path: the sentence names the address the
 * Burrow saw, in Settings → Network's words.
 */
export const OneTimeEndedNetworkNotAllowed: Story = {
  parameters: {
    primedBurrow: {
      status: UNENROLLED_STATUS,
      oneTime: {
        status: 'ended',
        reason: 'network-not-allowed',
        refusal: { at: Date.now(), kind: 'path-refused', end: 'remote', address: '172.58.12.9', addressSource: 'observed' },
      },
    },
    docs: { story: { height: '360px' } },
  },
  play: settled(
    'The phone tried to connect from 172.58.12.9, which isn’t on one of your allowed networks, so the connection ended.',
  ),
};

/** The one attempt was spent on digits the phone was not showing. */
export const OneTimeEndedMismatch: Story = {
  parameters: {
    primedBurrow: {
      status: UNENROLLED_STATUS,
      oneTime: { status: 'ended', reason: 'confirmation-mismatch' },
    },
    docs: { story: { height: '360px' } },
  },
  play: settled('The two digits did not match, so nothing connected.'),
};

/**
 * A self-host build reaches nothing of Dormouse's, the rendezvous included, so
 * it offers the button disabled and says why.
 */
export const OneTimeUnavailable: Story = {
  parameters: {
    primedBurrow: { status: SELF_HOST_UNENROLLED_STATUS },
    docs: { story: { height: '330px' } },
  },
  play: settled(/Not available in a self-host build/),
};
