import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import { ModalSurface } from '../components/design';
import { ManagedVoiceSection } from '../components/ManagedVoiceSection';
import { DEFAULT_RELAY_ORIGIN } from '../host/relay-origin';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import { UNENROLLED_STATUS, enrolledStatus } from '../host/remote/test-burrow-link';
import { networkPolicyResult, nothingPolicy } from '../remote/network-policy';

/** Independent managed-voice approval, selection, and disconnect. */
function ManagedVoiceStory() {
  return (
    <div className="flex justify-center p-6">
      <ModalSurface padding="spacious" className="w-full max-w-[26rem]">
        <ManagedVoiceSection onShowNetwork={() => {}} />
      </ModalSurface>
    </div>
  );
}

/** The code expires against this clock, so the countdown reads the same every run. */
const STORY_NOW = Date.UTC(2026, 0, 1);

const meta: Meta<typeof ManagedVoiceStory> = {
  title: 'Modals/ManagedVoiceSection',
  component: ManagedVoiceStory,
  beforeEach: () => {
    const realNow = Date.now;
    Date.now = () => STORY_NOW;
    return () => { Date.now = realNow; };
  },
  // One frame each: the section reads module-singleton stores
  // (`RemoteControlSection.stories.tsx` says why).
  parameters: { docs: { story: { inline: false, height: '360px' } } },
};

export default meta;
type Story = StoryObj<typeof ManagedVoiceStory>;

/** Wait for the settled text, so the snapshot is never the empty first frame. */
function settled(text: string | RegExp) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await within(canvasElement).findByText(text);
  };
}

/** A Hosted build's Burrow, enrolled with Hosted and connected. */
const ENROLLED: BurrowConsoleStatus = enrolledStatus({
  relayOrigin: DEFAULT_RELAY_ORIGIN,
  relayMode: 'hosted',
  accountOrigin: 'https://hosted.dormouse.sh',
});

/** Not enrolled: the disclosure, the pitch, and the button that gets a code. */
export const NotEnrolled: Story = {
  parameters: {
    primedBurrow: { status: UNENROLLED_STATUS },
    primedManagedVoice: { configured: false },
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('button', { name: 'Turn on Natural Voice' });
  },
};

/** The digits waiting to be typed at the account, as the host reports them: remote control's view. */
export const WaitingForApproval: Story = {
  parameters: {
    primedBurrow: { status: UNENROLLED_STATUS },
    primedManagedVoice: {
      configured: false,
      enrollment: {
        status: 'waiting', confirmDigits: '47',
        verificationUrl: 'https://hosted.dormouse.sh/enroll?purpose=voice#7KQM-X4TD',
        expiresAt: STORY_NOW + 10 * 60_000, accountFull: false,
      },
    },
    docs: { story: { height: '420px' } },
  },
  play: settled('47'),
};

/** Approved with other digits: Natural Voice stays off, and Turn on gets a new code. */
export const ApprovalMismatch: Story = {
  parameters: {
    primedBurrow: { status: UNENROLLED_STATUS },
    primedManagedVoice: { configured: false, enrollment: { status: 'ended', reason: 'mismatch' } },
    docs: { story: { height: '420px' } },
  },
  play: settled(/so Natural Voice was not turned on/),
};

/** Under Nothing: why it cannot enroll, and the way to Network — never a silent policy change. */
export const UnderNothing: Story = {
  parameters: {
    primedBurrow: {
      status: UNENROLLED_STATUS,
      network: networkPolicyResult(nothingPolicy(), 'hosted', []),
    },
    primedManagedVoice: { configured: false },
  },
  play: settled(/Choose Local networks or Anywhere in/),
};

/** Enrolled, a member: the curated voices and Disconnect. */
export const Enrolled: Story = {
  parameters: {
    primedBurrow: { status: ENROLLED },
    primedManagedVoice: { configured: true },
  },
  play: settled('Natural Voice is on.'),
};

/** Disconnect's second step, which says what else it ends. */
export const DisconnectSecondStep: Story = {
  parameters: {
    primedBurrow: { status: ENROLLED },
    primedManagedVoice: { configured: true },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Turn off' }));
    await canvas.findByText(/Alarms will use your system voice/);
  },
};

/** Enrolled, but speak answered 403: the plan lapsed, and the plans are a click away. */
export const NoPlan: Story = {
  parameters: {
    primedBurrow: { status: ENROLLED },
    primedManagedVoice: { configured: true, notEntitled: true },
  },
  play: settled(/no Hosted plan/),
};

/** Remote control is enrolled while managed voice remains an independent choice. */
export const RemoteOnly: Story = {
  parameters: { primedBurrow: { status: ENROLLED }, primedManagedVoice: { configured: false } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('button', { name: 'Turn on Natural Voice' });
  },
};

/** A failed disk clear stops voice immediately and remains retryable. */
export const DisconnectFailed: Story = {
  parameters: { primedBurrow: { status: ENROLLED }, primedManagedVoice: { configured: false, disconnectFailed: true } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('button', { name: 'Retry' });
  },
};
