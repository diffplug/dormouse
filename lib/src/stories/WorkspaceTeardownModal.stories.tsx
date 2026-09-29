import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceTeardownModal } from '../../../standalone/src/WorkspaceTeardownModal';

// The modal reads its live running-session count from the terminal-state store
// (it tracks commands finishing while the dialog is up), so stories prime the
// store through the preview decorator's `primedTerminalState` parameter — the
// decorator clears any manually seeded state, so this is the only channel.
function runningPanes(count: number) {
  return {
    byId: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `quit-story-${i}`,
        { activity: { kind: 'running' as const } },
      ]),
    ),
  };
}

function WorkspaceTeardownModalStory() {
  // Cancel/Quit call the quit-confirm store's actions, which no-op without an
  // active quit context — the buttons are safely inert here.
  return (
    <div className="relative h-[420px] w-[720px] overflow-hidden rounded bg-app-bg p-4 font-mono text-sm text-terminal-fg">
      <div>dev@dormouse:~/repo$ pnpm test --watch</div>
      <div className="text-muted">RUN v4.1.9 …</div>
      <WorkspaceTeardownModal confirming={false} />
    </div>
  );
}

const meta: Meta<typeof WorkspaceTeardownModalStory> = {
  title: 'Modals/WorkspaceTeardownModal',
  component: WorkspaceTeardownModalStory,
};

export default meta;
type Story = StoryObj<typeof WorkspaceTeardownModalStory>;

// All termination paths use the same typed-letter Workspace confirmation.
export const RunningCommands: Story = {
  parameters: { primedTerminalState: runningPanes(3) },
};

// Singular copy ("1 running command will be stopped.").
export const OneRunningCommand: Story = {
  parameters: { primedTerminalState: runningPanes(1) },
};

// The dialog stays open when the count drops to 0 (auto-quitting out from
// under the user would surprise); copy flips to "No commands are still
// running." and the confirmation letter stays the same.
export const NoRunningCommands: Story = {
  parameters: { primedTerminalState: runningPanes(0) },
};
