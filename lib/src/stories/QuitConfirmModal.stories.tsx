import type { Meta, StoryObj } from '@storybook/react';
import { QuitConfirmModal } from '../../../standalone/src/QuitConfirmModal';

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

function QuitConfirmModalStory({ confirming }: { confirming: boolean }) {
  // Cancel/Quit call the quit-confirm store's actions, which no-op without an
  // active quit context — the buttons are safely inert here.
  return (
    <div className="relative h-[420px] w-[720px] overflow-hidden rounded bg-app-bg p-4 font-mono text-sm text-terminal-fg">
      <div>dev@dormouse:~/repo$ pnpm test --watch</div>
      <div className="text-muted">RUN v4.1.9 …</div>
      <QuitConfirmModal confirming={confirming} />
    </div>
  );
}

const meta: Meta<typeof QuitConfirmModalStory> = {
  title: 'Modals/QuitConfirmModal',
  component: QuitConfirmModalStory,
};

export default meta;
type Story = StoryObj<typeof QuitConfirmModalStory>;

// Plural copy + "Quit and stop N" primary action.
export const RunningCommands: Story = {
  args: { confirming: false },
  parameters: { primedTerminalState: runningPanes(3) },
};

// Singular copy ("1 running command will be stopped.").
export const OneRunningCommand: Story = {
  args: { confirming: false },
  parameters: { primedTerminalState: runningPanes(1) },
};

// The dialog stays open when the count drops to 0 (auto-quitting out from
// under the user would surprise); copy flips to "No commands are still
// running." and the primary action to a plain "Quit".
export const NoRunningCommands: Story = {
  args: { confirming: false },
  parameters: { primedTerminalState: runningPanes(0) },
};

// Post-confirm state: both buttons disabled, Escape inert, "Quitting…" copy
// until the process exits.
export const Quitting: Story = {
  args: { confirming: true },
  parameters: { primedTerminalState: runningPanes(2) },
};
