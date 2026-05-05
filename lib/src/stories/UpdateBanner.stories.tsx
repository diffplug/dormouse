import type { Meta, StoryObj } from '@storybook/react';
import { UpdateBanner, type UpdateBannerState } from '../../../standalone/src/UpdateBanner';

function UpdateBannerStory({ state, expectedNullReason }: { state: UpdateBannerState; expectedNullReason?: string }) {
  return (
    <div className="bg-app-bg" style={{ width: '100%' }}>
      <UpdateBanner
        state={state}
        onDismiss={() => console.log('Dismiss')}
        onOpenChangelog={() => console.log('Open changelog')}
        onOpenDebug={() => console.log('Open debug')}
      />
      {expectedNullReason ? (
        <div className="inline-flex border border-dashed border-border bg-surface-raised px-2 py-1 font-mono text-xs text-muted">
          Expected empty banner: {expectedNullReason}
        </div>
      ) : null}
    </div>
  );
}

const meta: Meta<typeof UpdateBannerStory> = {
  title: 'Components/UpdateBanner',
  component: UpdateBannerStory,
};

export default meta;
type Story = StoryObj<typeof UpdateBannerStory>;

export const Downloaded: Story = {
  args: {
    state: { status: 'downloaded', version: '0.5.0' },
  },
};

export const PostUpdateSuccess: Story = {
  args: {
    state: { status: 'post-update-success', from: '0.4.0', to: '0.5.0' },
  },
};

export const PostUpdateFailure: Story = {
  args: {
    state: { status: 'post-update-failure', version: '0.5.0' },
  },
};

export const Idle: Story = {
  args: {
    state: { status: 'idle' },
    expectedNullReason: 'idle has no update notice to show.',
  },
};

export const Dismissed: Story = {
  args: {
    state: { status: 'dismissed' },
    expectedNullReason: 'the user has already dismissed this notice.',
  },
};

export const NarrowViewport: Story = {
  args: {
    state: { status: 'downloaded', version: '0.5.0' },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 400 }}>
        <Story />
      </div>
    ),
  ],
};
