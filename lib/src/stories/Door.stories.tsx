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

/** A Door carrying notes: a second button, filled, that never reattaches. */
export const WithNotes: Story = {
  args: { noteCount: 3 },
};

export const WithNotesAndIndicators: Story = {
  args: { noteCount: 1, todo: true, status: 'ALERT_RINGING' },
};

export const NotepadPopover: StoryObj<typeof NotedDoorStory> = {
  render: (args) => <NotedDoorStory {...args} />,
  args: { noteCount: 2 },
  play: openDoorNotepad,
};


export const DirtyTool: Story = {
  // `spoken` only exists over a latched ring (`docs/specs/alert.md` -> Pane Header).
  args: { title: 'Editor', toolDirty: true, noteCount: 2, speechState: 'spoken', status: 'ALERT_RINGING' },
};
