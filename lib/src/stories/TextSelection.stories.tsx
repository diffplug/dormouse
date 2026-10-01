import type { Meta, StoryObj } from '@storybook/react';
import { TerminalPane } from '../components/TerminalPane';
import { flattenScenario, SCENARIO_LS_OUTPUT } from '../lib/platform';
import { getMouseSelectionState, setSelection, type Selection } from '../lib/mouse-selection';
import { openCopyEditor } from '../lib/copy-editor';
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
  selection: Omit<Selection, 'startedInScrollback'>;
}) {
  useStorySelection(id, (terminal) => {
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
