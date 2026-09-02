import type { Meta, StoryObj } from '@storybook/react';
import { RemotePairingModal } from '../remote/host/RemotePairingModal';

function RemotePairingModalStory({ label }: { label: string }) {
  return (
    <div className="relative h-[360px] w-[680px] overflow-hidden rounded bg-app-bg font-mono text-terminal-fg">
      {/* Simulated terminal content behind the viewport-scoped modal. */}
      <div className="p-4 text-sm">
        <div>dev@dormouse:~/repo$ dormouse remote enroll</div>
        <div className="text-muted">Waiting for a device to pair…</div>
      </div>
      <RemotePairingModal label={label} onApprove={() => {}} onDeny={() => {}} />
    </div>
  );
}

const meta: Meta<typeof RemotePairingModalStory> = {
  title: 'Modals/RemotePairingModal',
  component: RemotePairingModalStory,
};

export default meta;
type Story = StoryObj<typeof RemotePairingModalStory>;

// The whole surface: a device name, and two digits to read off the phone.
export const Default: Story = {
  args: { label: 'Ned’s iPhone' },
};

// Empty label → the `(unnamed)` fallback.
export const UnnamedDevice: Story = {
  args: { label: '' },
};

// A long label, to exercise the review block's `break-words` wrapping.
export const LongValues: Story = {
  args: {
    label:
      'Ned’s work iPhone 15 Pro Max in the downstairs office by the window (personal profile)',
  },
};
