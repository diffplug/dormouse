import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Door } from '../components/Door';
import { Baseboard } from '../components/Baseboard';
import { addPlainNote, clearAllNotepads } from '../lib/notepad/notepad-store';
import { requireElement } from './settle-terminals';

const NOTED_DOOR_ID = 'door-story';

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

/** The real baseboard, because the popover is the Baseboard's to open — the
 *  Door only asks. */
function NotedDoorStory({ noteCount = 2 }: { noteCount?: number }) {
  useEffect(() => {
    for (let i = 0; i < noteCount; i++) addPlainNote(NOTED_DOOR_ID, `note ${i + 1}`);
    return () => clearAllNotepads();
  }, [noteCount]);

  return (
    <div className="bg-app-bg flex h-40 flex-col justify-end" style={{ width: 520 }}>
      <Baseboard
        items={[{ id: NOTED_DOOR_ID, kind: 'terminal', title: 'build-server' }]}
        onReattach={() => {}}
      />
    </div>
  );
}

async function openDoorNotepad() {
  const button = await requireElement<HTMLButtonElement>(
    `[data-door-notepad-for="${NOTED_DOOR_ID}"]`,
    'Door notepad button',
  );
  button.click();
  await requireElement(`[data-notepad-popover-for="${NOTED_DOOR_ID}"]`, 'Door notepad popover');
}

const meta: Meta<typeof DoorStory> = {
  title: 'Components/Door',
  component: DoorStory,
  args: {
    title: 'build-server',
    status: 'WATCHING_DISABLED',
    ringSeq: 0,
    todo: false,
    width: 260,
    reducedMotion: false,
  },
  argTypes: {
    title: { control: 'text' },
    status: { control: 'radio', options: ['WATCHING_DISABLED', 'NOTHING_TO_SHOW', 'MIGHT_BE_BUSY', 'BUSY', 'OSC_NOTIF_BUSY', 'COMMAND_EXIT_ARMED', 'MIGHT_NEED_ATTENTION', 'ALERT_RINGING'] },
    todo: { control: 'boolean' },
    speechState: { control: 'radio', options: [undefined, 'speaking', 'spoken'] },
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
export const Speaking: Story = { args: { status: 'ALERT_RINGING', todo: true, speechState: 'speaking' } };
export const HasSpoken: Story = { args: { status: 'ALERT_RINGING', todo: true, speechState: 'spoken' } };
export const LongTitleWithIndicators: Story = {
  args: {
    title: 'my-extremely-long-running-background-process-with-a-very-descriptive-name',
    todo: true,
    status: 'NOTHING_TO_SHOW',
  },
};

/** A Door carrying notes: a second button, filled, that never reattaches. */
export const WithNotes: Story = {
  args: { noteCount: 3, status: 'NOTHING_TO_SHOW' },
};

export const WithNotesAndIndicators: Story = {
  args: { noteCount: 1, todo: true, status: 'ALERT_RINGING' },
};

export const NotepadPopover: StoryObj<typeof NotedDoorStory> = {
  render: (args) => <NotedDoorStory {...args} />,
  args: { noteCount: 2 },
  play: openDoorNotepad,
};
