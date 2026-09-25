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
    // Stories draw the static treatment; the arrival burst is frozen out by
    // `cfg.alert.ringingPaused` under Chromatic anyway.
    episode: null,
    todo: false,
    width: 260,
    reducedMotion: false,
  },
  argTypes: {
    title: { control: 'text' },
    // Only the latched ring reaches the Door; every other status draws the same
    // plain pill (`docs/specs/alert.md` -> Door).
    status: { control: 'radio', options: ['WATCHING_DISABLED', 'ALERT_RINGING'] },
    todo: { control: 'boolean' },
    speechState: { control: 'radio', options: [undefined, 'speaking', 'spoken'] },
    width: { control: 'number' },
    reducedMotion: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof DoorStory>;

export const Default: Story = {};
export const Ringing: Story = { args: { status: 'ALERT_RINGING' } };
export const TodoOnly: Story = { args: { todo: true } };
export const TodoAndRinging: Story = { args: { todo: true, status: 'ALERT_RINGING' } };
export const Speaking: Story = { args: { status: 'ALERT_RINGING', speechState: 'speaking' } };
// A TODO standing from before this ring: the speaker icon joins its pill.
export const HasSpoken: Story = { args: { status: 'ALERT_RINGING', todo: true, speechState: 'spoken' } };
export const LongTitleWithIndicators: Story = {
  args: {
    title: 'my-extremely-long-running-background-process-with-a-very-descriptive-name',
    todo: true,
    status: 'ALERT_RINGING',
  },
};

export const DirtyTool: Story = {
  // `spoken` only exists over a latched ring (`docs/specs/alert.md` -> Pane Header).
  args: { title: 'Editor', toolDirty: true, speechState: 'spoken', status: 'ALERT_RINGING' },
};
