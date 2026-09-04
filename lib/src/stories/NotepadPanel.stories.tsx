import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { NotepadPanel } from '../components/NotepadPanel';
import {
  addPlainNote,
  addTerminalNote,
  clearAllNotepads,
  setOpenNotepadId,
} from '../lib/notepad/notepad-store';
import type { RichTextRun, RuntimeTerminalSource } from '../lib/notepad/types';
import { requireElement } from './settle-terminals';

const SURFACE_ID = 'notepad-story';

type Seed =
  | { kind: 'plain'; text: string }
  | { kind: 'terminal'; runs: RichTextRun[]; pinned?: boolean };

/**
 * A source link with inert markers. The pin's own resolution is the capture
 * work's; what these stories show is the affordance and its failure message.
 */
function stubSource(): RuntimeTerminalSource {
  const marker = { id: 0, line: 0, isDisposed: false, dispose() {}, onDispose: () => ({ dispose() {} }) };
  return {
    terminalId: SURFACE_ID,
    startMarker: marker,
    endMarker: marker,
    startColumn: 0,
    endColumn: 40,
    shape: 'linewise',
    expectedRawText: '',
  } as unknown as RuntimeTerminalSource;
}

/**
 * The attached notepad over a stand-in Surface body — the panel corners itself
 * in it at three quarters of its width and height.
 */
function NotepadPanelStory({
  notes = [],
  width = 720,
  height = 420,
}: {
  notes?: Seed[];
  width?: number;
  height?: number;
}) {
  useEffect(() => {
    clearAllNotepads();
    for (const note of notes) {
      if (note.kind === 'plain') addPlainNote(SURFACE_ID, note.text);
      else addTerminalNote(SURFACE_ID, note.runs, note.pinned ? stubSource() : undefined);
    }
    setOpenNotepadId(SURFACE_ID);
    return () => clearAllNotepads();
  }, [notes]);

  return (
    <div className="relative overflow-hidden rounded-lg bg-terminal-bg" style={{ width, height }}>
      <NotepadPanel surfaceId={SURFACE_ID} />
    </div>
  );
}

/** Follow a pin that cannot resolve: the panel comes back saying so. */
async function clickUnavailablePin() {
  const pin = await requireElement<HTMLButtonElement>('[aria-label="Show source"]', 'source pin');
  pin.click();
  await requireElement('[role="status"]', 'source-unavailable message');
}

const meta: Meta<typeof NotepadPanelStory> = {
  title: 'Components/NotepadPanel',
  component: NotepadPanelStory,
  argTypes: {
    width: { control: 'number' },
    height: { control: 'number' },
  },
};

export default meta;
type Story = StoryObj<typeof NotepadPanelStory>;

export const Empty: Story = {
  args: { notes: [] },
};

export const PlainNotes: Story = {
  args: {
    notes: [
      { kind: 'plain', text: 'ask about the flaky resize test' },
      { kind: 'plain', text: 'PORT=5173\nDEBUG=dormouse:*' },
    ],
  },
};

export const TerminalNotes: Story = {
  args: {
    notes: [
      {
        kind: 'terminal',
        runs: [
          { text: 'FAIL ', bold: true, foreground: '#ff5f56' },
          { text: 'src/components/Wall.test.tsx' },
        ],
      },
      {
        kind: 'terminal',
        runs: [
          { text: '  ✓ ', foreground: '#27c93f' },
          { text: 'restores a door ', italic: true },
          { text: '12ms', foreground: '#8a8a8a', background: '#1f1f1f' },
        ],
      },
      { kind: 'plain', text: 'both from the same run' },
    ],
  },
};

export const SourceNoLongerAvailable: Story = {
  args: {
    notes: [
      {
        kind: 'terminal',
        runs: [{ text: 'error[E0308]: mismatched types', bold: true, foreground: '#ff5f56' }],
        pinned: true,
      },
    ],
  },
  play: clickUnavailablePin,
};
