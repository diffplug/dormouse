import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TerminalPane } from '../components/TerminalPane';
import { flattenScenario, SCENARIO_LS_OUTPUT } from '../lib/platform';
import { getMouseSelectionState, setSelection, type Selection } from '../lib/mouse-selection';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { settleTerminals, waitForCondition } from './settle-terminals';

/**
 * Wires a programmatic selection state onto a live TerminalPane so we can
 * visualize the overlay, the Alt hint, and the copy popup in their various
 * positions without scripting a real mouse drag.
 */
function TextSelectionStory({
  id,
  selection,
}: {
  id: string;
  selection: Omit<Selection, 'startedInScrollback'>;
}) {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tryApply = () => {
      if (cancelled) return;
      // Wait until xterm has actually rendered — getTerminalOverlayDims
      // reads `.xterm-screen`, which doesn't exist until after the first
      // paint. Without this the overlay would compute garbage positions.
      const dims = getTerminalOverlayDims(id);
      if (!dims || dims.cellHeight === 0) {
        timer = setTimeout(tryApply, 50);
        return;
      }
      setSelection(id, { ...selection, startedInScrollback: false });
    };

    timer = setTimeout(tryApply, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSelection(id, null);
    };
  }, [id, selection]);

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

// --- Outlines ------------------------------------------------------------

export const LinewiseOutline: Story = {
  args: {
    id: 'text-sel-linewise',
    selection: {
      startRow: 2, startCol: 6,
      endRow: 5, endCol: 34,
      shape: 'linewise',
      dragging: false,
    },
  },
};

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

// --- Copy popup positioning ---------------------------------------------

export const PopupAfterDragDown: Story = {
  args: {
    id: 'text-sel-popup-down',
    selection: {
      startRow: 2, startCol: 5,
      endRow: 6, endCol: 24,
      shape: 'linewise',
      dragging: false,
    },
  },
};

export const PopupAfterDragUp: Story = {
  args: {
    id: 'text-sel-popup-up',
    selection: {
      startRow: 8, startCol: 22,
      endRow: 4, endCol: 6,
      shape: 'linewise',
      dragging: false,
    },
  },
};
