import type { Meta, StoryObj } from '@storybook/react';
import type { PairingRequest } from 'server-lib-common';
import { RemotePairingModal } from '../remote/host/RemotePairingModal';

// A plausible pairing request; individual stories override the fields that
// drive the visible surface (requested label, account, key fingerprint).
function pairingRequest(over: Partial<PairingRequest> = {}): PairingRequest {
  return {
    accountId: 'ned@example.com',
    passkeyCredentialId: 'cred-abc123',
    passkeyPublicKeyHash: 'ph_9f2c1a77',
    devicePublicKey: 'abcd1234ef567890deadbeefcafef00d',
    requestedLabel: 'Ned’s iPhone',
    ...over,
  };
}

function RemotePairingModalStory({ request }: { request: PairingRequest }) {
  return (
    <div className="relative h-[360px] w-[680px] overflow-hidden rounded bg-app-bg font-mono text-terminal-fg">
      {/* Simulated terminal content behind the viewport-scoped modal. */}
      <div className="p-4 text-sm">
        <div>dev@dormouse:~/repo$ dormouse remote enroll</div>
        <div className="text-muted">Waiting for a device to pair…</div>
      </div>
      <RemotePairingModal request={request} onApprove={() => {}} onDeny={() => {}} />
    </div>
  );
}

const meta: Meta<typeof RemotePairingModalStory> = {
  title: 'Modals/RemotePairingModal',
  component: RemotePairingModalStory,
};

export default meta;
type Story = StoryObj<typeof RemotePairingModalStory>;

// Named device, normal account, key long enough to show an `abcd1234…` fingerprint.
export const Default: Story = {
  args: { request: pairingRequest() },
};

// Empty requested label → the `(unnamed)` fallback.
export const UnnamedDevice: Story = {
  args: { request: pairingRequest({ requestedLabel: '' }) },
};

// Long account + long label to exercise the review block's `break-words` wrapping.
export const LongValues: Story = {
  args: {
    request: pairingRequest({
      requestedLabel:
        'Ned’s work iPhone 15 Pro Max in the downstairs office by the window (personal profile)',
      accountId: 'ned.twigg+dormouse-remote-selfhost-poc-longaddress@subdomain.example-company.com',
    }),
  },
};
