import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import '@xterm/xterm/css/xterm.css';
import { SelectionPopup } from '../components/SelectionPopup';
import {
  focusSession,
  getOrCreateTerminal,
  getTerminalOverlayDims,
  mountElement,
  refitSession,
  unmountElement,
} from '../lib/terminal-registry';
import { flattenScenario, SCENARIO_LS_OUTPUT } from '../lib/platform';
import { getMouseSelectionState, setSelection, type Selection } from '../lib/mouse-selection';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../components/design';
import { TouchUiContext } from '../components/touch-ui-context';
import { settleTerminals, waitForCondition } from './settle-terminals';

function SelectionPopupStory({
  id,
  selection,
  touch = false,
}: {
  id: string;
  selection: Omit<Selection, 'startedInScrollback'>;
  touch?: boolean;
}) {
  const terminalHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const terminalHost = terminalHostRef.current;
    if (!terminalHost) return;

    getOrCreateTerminal(id);
    mountElement(id, terminalHost);

    const observer = new ResizeObserver(() => refitSession(id));
    observer.observe(terminalHost);

    return () => {
      observer.disconnect();
      unmountElement(id);
    };
  }, [id]);

  useEffect(() => {
    focusSession(id, true);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const applySelection = () => {
      if (cancelled) return;
      const dims = getTerminalOverlayDims(id);
      if (!dims || dims.cellHeight === 0) {
        timer = setTimeout(applySelection, 50);
        return;
      }
      // dragging: false so the popup (shown after mouse-up) renders.
      setSelection(id, { ...selection, dragging: false, startedInScrollback: false });
    };

    timer = setTimeout(applySelection, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSelection(id, null);
    };
  }, [id, selection]);

  return (
    <TouchUiContext.Provider value={touch}>
      <div
        className={`relative bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
        style={{ width: 620, height: 340 }}
      >
        <div ref={terminalHostRef} className="h-full w-full" />
        <SelectionPopup terminalId={id} />
      </div>
    </TouchUiContext.Provider>
  );
}

const meta: Meta<typeof SelectionPopupStory> = {
  title: 'Components/SelectionPopup',
  component: SelectionPopupStory,
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) },
  },
  // Hold the snapshot until the terminal has painted AND the story's own timer has
  // applied the selection (which is what reveals the copy popup).
  play: async ({ args }) => {
    await settleTerminals();
    await waitForCondition(() => getMouseSelectionState(args.id).selection !== null);
  },
};

export default meta;
type Story = StoryObj<typeof SelectionPopupStory>;

// Desktop: copy buttons carry their keyboard shortcuts and, for a downward drag,
// sit below the selection.
export const Desktop: Story = {
  args: {
    id: 'selection-popup-desktop',
    selection: {
      startRow: 2,
      startCol: 5,
      endRow: 6,
      endCol: 24,
      shape: 'linewise',
      dragging: false,
    },
  },
};

// Mobile: no keyboard shortcuts, and the popup sits above the selection (never
// below) so the thumb that finished the drag can't cover it.
export const Mobile: Story = {
  args: {
    id: 'selection-popup-mobile',
    touch: true,
    selection: {
      startRow: 2,
      startCol: 5,
      endRow: 6,
      endCol: 24,
      shape: 'linewise',
      dragging: false,
    },
  },
};
