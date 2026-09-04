import { useLayoutEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import { NotepadArchiveView } from '../components/NotepadArchiveView';
import { getPlatform } from '../lib/platform';
import type { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { refreshArchive } from '../lib/notepad/archive-service';
import type { ArchiveBatch, NotepadArchiveV1 } from '../lib/notepad/types';
import type { CwdState } from '../lib/terminal-state';

/**
 * Batch times are frozen literals rather than offsets from `Date.now()`: the
 * header renders an absolute date, so a live clock would make every snapshot a
 * diff.
 */
const MORNING = Date.parse('2026-03-04T09:12:00Z');
const YESTERDAY = Date.parse('2026-03-03T17:41:00Z');
const LAST_WEEK = Date.parse('2026-02-26T11:05:00Z');

const LOCAL_CWD: CwdState = {
  path: '/Users/ned/projects/dormouse/lib/src/components',
  pathKind: 'posix',
  isRemote: false,
  source: 'osc7',
  updatedAt: MORNING,
};

/** A remote CWD renders its host, because `/srv/app` on the build box and
 *  `/srv/app` here are not the same directory. */
const REMOTE_CWD: CwdState = {
  path: '/srv/build/dormouse',
  host: 'build-box.tailnet.ts.net',
  scheme: 'file',
  pathKind: 'posix',
  isRemote: true,
  source: 'osc7',
  updatedAt: YESTERDAY,
};

/** A captured terminal excerpt: the four attributes capture keeps, and nothing
 *  else. Colors are the terminal's own resolved values, so they are literal
 *  here in a way no chrome would be. */
const FAILING_TEST: ArchiveBatch = {
  id: 'batch-local',
  closedAt: MORNING,
  surfaceTitle: 'pnpm test',
  surfaceKind: 'terminal',
  cwd: LOCAL_CWD,
  notes: [
    {
      id: 'note-rich',
      createdAt: MORNING,
      content: {
        kind: 'terminal',
        runs: [
          { text: ' FAIL ', bold: true, foreground: '#ffffff', background: '#c4314b' },
          { text: '  src/components/design.test.ts\n' },
          { text: '    ✕ ', foreground: '#c4314b' },
          { text: 'popover cap matches the viewport margin', italic: true },
          { text: '\n    → expected ' },
          { text: '24px', bold: true, foreground: '#4f9153' },
          { text: ' but got ' },
          { text: '16px', bold: true, foreground: '#c4314b' },
        ],
      },
    },
    {
      id: 'note-plain',
      createdAt: MORNING + 60_000,
      content: {
        kind: 'plain',
        text: 'the popover budget moved when OVERLAY_MAX_HEIGHT landed — check design.test.ts before touching the margin again',
      },
    },
  ],
};

const REMOTE_BUILD: ArchiveBatch = {
  id: 'batch-remote',
  closedAt: YESTERDAY,
  surfaceTitle: 'cargo build --release',
  surfaceKind: 'terminal',
  cwd: REMOTE_CWD,
  notes: [
    {
      id: 'note-remote',
      createdAt: YESTERDAY,
      content: {
        kind: 'terminal',
        runs: [
          { text: 'warning', bold: true, foreground: '#b08800' },
          { text: ': unused variable: ' },
          { text: '`quit_progress`', bold: true },
        ],
      },
    },
  ],
};

/** A browser Surface has no CWD at all — the header has to read as complete
 *  without one rather than leaving a hole where the path goes. */
const BROWSER_BATCH: ArchiveBatch = {
  id: 'batch-browser',
  closedAt: LAST_WEEK,
  surfaceTitle: 'xterm.js API — IBufferCell',
  surfaceKind: 'browser',
  cwd: null,
  notes: [
    {
      id: 'note-browser',
      createdAt: LAST_WEEK,
      content: {
        kind: 'plain',
        text: 'getFgColorMode() returns the palette mode; bold + palette 0-7 resolves bright while drawBoldTextInBrightColors is on.',
      },
    },
  ],
};

const POPULATED: NotepadArchiveV1 = {
  version: 1,
  // Deliberately not in closure order: the view sorts, nothing else does.
  batches: [REMOTE_BUILD, BROWSER_BATCH, FAILING_TEST],
};

/**
 * Install the story's archive into the fake platform's memory port and re-read
 * it. Both are module-global — one platform, one archive store, shared by every
 * story — so each story seeds what it wants and clears what the last one left.
 * A layout effect, so the seed lands before the view's own mount load runs.
 */
function ArchiveStory({ seed, corrupt }: { seed?: NotepadArchiveV1; corrupt?: boolean }) {
  useLayoutEffect(() => {
    const platform = getPlatform() as FakePtyAdapter;
    platform.notepadArchive.clear();
    if (corrupt) platform.corruptNotepadArchive();
    else if (seed) platform.seedNotepadArchive(seed);
    void refreshArchive();
  }, [seed, corrupt]);

  return <NotepadArchiveView onBack={() => {}} onClose={() => {}} />;
}

const meta: Meta<typeof ArchiveStory> = {
  title: 'Modals/NotepadArchiveView',
  component: ArchiveStory,
};

export default meta;
type Story = StoryObj<typeof ArchiveStory>;

/**
 * The populated archive: a local terminal batch with a rich capture and a plain
 * note, a remote one whose header carries its host, and a browser batch with no
 * CWD. Newest first.
 */
export const Populated: Story = {
  args: { seed: POPULATED },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('pnpm test');
  },
};

/**
 * Mid-deletion: one note staged, so the irreversibility bar and its Undo are
 * up. Nothing has been written yet — leaving the view is what commits it.
 */
export const StagedDeletion: Story = {
  args: { seed: POPULATED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('pnpm test');
    const deletes = await canvas.findAllByLabelText('Delete note');
    await userEvent.click(deletes[0]!);
    await canvas.findByText(/Deletion is irreversible/);
  },
};

/** Nothing has ever been archived. It has to explain where batches come from,
 *  because nothing in this view can create one. */
export const EmptyArchive: Story = {
  args: { seed: { version: 1, batches: [] } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/Nothing archived yet/);
  },
};

/**
 * Stored data the validator rejected. The copy's job is to say that nothing was
 * replaced: the button below it is the only thing in the app that ever moves an
 * archive aside, and it keeps a copy when it does.
 */
export const Unreadable: Story = {
  args: { corrupt: true },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/could not be read/);
  },
};
