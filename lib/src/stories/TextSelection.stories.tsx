import type { Meta, StoryObj } from '@storybook/react';
import { userEvent } from 'storybook/test';
import { TerminalPane } from '../components/TerminalPane';
import { flattenScenario, SCENARIO_LS_OUTPUT } from '../lib/platform';
import { getMouseSelectionState, setSelection, type Selection } from '../lib/mouse-selection';
import { openCopyEditor } from '../lib/copy-editor';
import { getTerminalInstance, getTerminalOverlayDims } from '../lib/terminal-registry';
import { settleTerminals, waitForCondition } from './settle-terminals';
import { useStorySelection } from './story-selection';

/**
 * Wires a programmatic selection state onto a live TerminalPane so we can
 * visualize the overlay, the Alt hint, and the copy editor in their various
 * positions without scripting a real mouse drag.
 */
function TextSelectionStory({
  id,
  selection,
}: {
  id: string;
  /** None for a story whose `play` selects with the mouse. */
  selection?: Omit<Selection, 'startedInScrollback'>;
}) {
  useStorySelection(id, (terminal) => {
    if (!selection) return;
    setSelection(id, { ...selection, startedInScrollback: false });
    // A finalized drag opens the copy editor, as mouse-up does.
    if (!selection.dragging) openCopyEditor(id, terminal);
  }, [selection]);

  return (
    <div style={{ width: 600, height: 340 }} className="bg-terminal-bg">
      <TerminalPane id={id} isFocused />
    </div>
  );
}

const meta: Meta<typeof TextSelectionStory> = {
  title: 'Terminal/TextSelection',
  component: TextSelectionStory,
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) },
  },
  // Hold the snapshot until the terminal has painted AND the story's own timer has
  // applied the selection overlay.
  play: async ({ args }) => {
    await settleTerminals();
    await waitForCondition(() => getMouseSelectionState(args.id).selection !== null);
  },
};

export default meta;
type Story = StoryObj<typeof TextSelectionStory>;

export const BlockOutline: Story = {
  args: {
    id: 'text-sel-block',
    selection: {
      startRow: 2, startCol: 6,
      endRow: 5, endCol: 26,
      shape: 'block',
      dragging: false,
    },
  },
};

// --- Alt hint positioning ------------------------------------------------

export const HintWhenDraggingDown: Story = {
  args: {
    id: 'text-sel-hint-down',
    selection: {
      startRow: 2, startCol: 5,
      endRow: 6, endCol: 24,
      shape: 'linewise',
      dragging: true,
    },
  },
};

export const HintWhenDraggingUp: Story = {
  args: {
    id: 'text-sel-hint-up',
    selection: {
      startRow: 8, startCol: 22,
      endRow: 4, endCol: 6,
      shape: 'linewise',
      dragging: true,
    },
  },
};

// --- Copy editor positioning --------------------------------------------

export const EditorAfterDragDown: Story = {
  args: {
    id: 'text-sel-editor-down',
    selection: {
      startRow: 2, startCol: 5,
      endRow: 6, endCol: 24,
      shape: 'linewise',
      dragging: false,
    },
  },
};

export const EditorAfterDragUp: Story = {
  args: {
    id: 'text-sel-editor-up',
    selection: {
      startRow: 8, startCol: 22,
      endRow: 4, endCol: 6,
      shape: 'linewise',
      dragging: false,
    },
  },
};

// --- Mouse multi-click ---------------------------------------------------

/** Double-click the middle of `word`, the first on screen, as a mouse does. */
async function doubleClickWord(id: string, word: string): Promise<{ row: number; col: number }> {
  const terminal = getTerminalInstance(id)!;
  const dims = getTerminalOverlayDims(id)!;
  const buffer = terminal.buffer.active;
  let row = buffer.viewportY;
  while (!buffer.getLine(row)!.translateToString().includes(word)) row++;
  const col = buffer.getLine(row)!.translateToString().indexOf(word);
  const screen = document.querySelector<HTMLElement>('.xterm-screen')!;
  const rect = screen.getBoundingClientRect();
  const coords = {
    clientX: rect.left + (col + word.length / 2) * dims.cellWidth,
    clientY: rect.top + (row - buffer.viewportY + 0.5) * dims.cellHeight,
  };
  await userEvent.pointer([{ target: screen, coords, keys: '[MouseLeft][MouseLeft]' }]);
  return { row, col };
}

/** A double-click selects its word as the terminal's own selection, the editor
 *  open over it, and xterm.js paints no selection of its own. */
export const EditorAfterDoubleClick: Story = {
  args: { id: 'text-sel-double-click' },
  play: async ({ args }) => {
    await settleTerminals();
    await waitForCondition(() => (getTerminalOverlayDims(args.id)?.cellHeight ?? 0) > 0);
    const word = 'package.json';
    const { row, col } = await doubleClickWord(args.id, word);
    await waitForCondition(() => getMouseSelectionState(args.id).copyEditor !== null);
    const { selection } = getMouseSelectionState(args.id);
    const want = { startRow: row, startCol: col, endRow: row, endCol: col + word.length - 1 };
    const got = selection && { startRow: selection.startRow, startCol: selection.startCol, endRow: selection.endRow, endCol: selection.endCol };
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`double-click selected ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    if (getTerminalInstance(args.id)!.hasSelection()) throw new Error('xterm.js painted its own selection');
  },
};
