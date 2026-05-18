import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { UpdateDebugDialog } from '../../../standalone/src/UpdateDebugDialog';

interface StoryArgs {
  failure: { version: string; error?: string };
  body: string | null;
}

function UpdateDebugDialogStory({ failure, body }: StoryArgs) {
  // Bumping `key` on close re-mounts the dialog so the story stays interactive
  // after the user dismisses it (otherwise the canvas goes blank).
  const [tick, setTick] = useState(0);
  return (
    <div className="bg-app-bg" style={{ width: 800, height: 600, position: 'relative' }}>
      <UpdateDebugDialog
        key={tick}
        open={true}
        onClose={() => setTick((t) => t + 1)}
        failure={failure}
        body={body}
      />
    </div>
  );
}

const ERROR = 'EACCES: permission denied at /Applications/Dormouse.app';

const BODY = [
  '**App version**: 0.7.0 → 0.8.0',
  '**Platform**: macOS',
  `**Error**: ${ERROR}`,
  '',
  '**Recent log:**',
  '```',
  '[42] [app] setup started',
  '[42] [sidecar] resolved script: /path/to/sidecar/main.js',
  '[42] [sidecar] spawned Node.js runtime (pid=12345)',
  '[42] [app] sidecar state registered',
  '```',
  '',
].join('\n');

const meta: Meta<typeof UpdateDebugDialogStory> = {
  title: 'Components/UpdateDebugDialog',
  component: UpdateDebugDialogStory,
};

export default meta;
type Story = StoryObj<typeof UpdateDebugDialogStory>;

export const Default: Story = {
  args: {
    failure: { version: '0.8.0', error: ERROR },
    body: BODY,
  },
};
