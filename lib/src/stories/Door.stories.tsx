import type { Meta, StoryObj } from '@storybook/react';
import { Door } from '../components/Door';

function DoorStory({
  width = 260,
  reducedMotion = false,
  ...props
}: React.ComponentProps<typeof Door> & {
  width?: number;
  reducedMotion?: boolean;
}) {
  return (
    <div
      className={reducedMotion ? '[&_button]:!animate-none [&_*]:!transition-none' : undefined}
      style={{ width }}
    >
      <div className="bg-app-bg flex h-16 items-end border-t border-border px-4">
        <Door {...props} />
      </div>
    </div>
  );
}

const meta: Meta<typeof DoorStory> = {
  title: 'Components/Door',
  component: DoorStory,
  args: {
    title: 'build-server',
    status: 'WATCHING_DISABLED',
    todo: false,
    width: 260,
    reducedMotion: false,
  },
  argTypes: {
    title: { control: 'text' },
    status: { control: 'radio', options: ['WATCHING_DISABLED', 'NOTHING_TO_SHOW', 'MIGHT_BE_BUSY', 'BUSY', 'OSC_NOTIF_BUSY', 'COMMAND_EXIT_ARMED', 'MIGHT_NEED_ATTENTION', 'ALERT_RINGING'] },
    todo: { control: 'boolean' },
    width: { control: 'number' },
    reducedMotion: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof DoorStory>;

export const AlertDisabled: Story = {};
export const AlertEnabled: Story = { args: { status: 'NOTHING_TO_SHOW' } };
export const AlertMightBeBusy: Story = { args: { status: 'MIGHT_BE_BUSY' } };
export const AlertBusy: Story = { args: { status: 'BUSY' } };
export const ProgressBusy: Story = { args: { status: 'OSC_NOTIF_BUSY' } };
export const CommandExitArmed: Story = { args: { status: 'COMMAND_EXIT_ARMED' } };
export const AlertMightNeedAttention: Story = { args: { status: 'MIGHT_NEED_ATTENTION' } };
export const AlertRinging: Story = { args: { status: 'ALERT_RINGING' } };
export const TodoOnly: Story = { args: { todo: true } };
export const TodoAndAlertEnabled: Story = { args: { todo: true, status: 'NOTHING_TO_SHOW' } };
export const TodoAndAlertRinging: Story = { args: { todo: true, status: 'ALERT_RINGING' } };
export const LongTitleWithIndicators: Story = {
  args: {
    title: 'my-extremely-long-running-background-process-with-a-very-descriptive-name',
    todo: true,
    status: 'NOTHING_TO_SHOW',
  },
};
