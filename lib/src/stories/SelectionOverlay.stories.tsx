import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import '@xterm/xterm/css/xterm.css';
import { SelectionOverlay } from '../components/SelectionOverlay';
import {
  focusSession,
  getOrCreateTerminal,
  getTerminalOverlayDims,
  mountElement,
  refitSession,
  unmountElement,
} from '../lib/terminal-registry';
import { flattenScenario, SCENARIO_LS_OUTPUT } from '../lib/platform';
import {
  setHintToken,
  setSelection,
  type Selection,
  type TokenHint,
} from '../lib/mouse-selection';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../components/design';
import { TouchUiContext } from '../components/touch-ui-context';

function SelectionOverlayStory({
  id,
  selection,
  hintToken = null,
  touch = false,
}: {
  id: string;
  selection: Omit<Selection, 'startedInScrollback'>;
  hintToken?: TokenHint | null;
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

      setSelection(id, { ...selection, startedInScrollback: false });
      setHintToken(id, hintToken);
    };

    timer = setTimeout(applySelection, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSelection(id, null);
      setHintToken(id, null);
    };
  }, [id, selection, hintToken]);

  return (
    <TouchUiContext.Provider value={touch}>
      <div
        className={`relative bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
        style={{ width: 620, height: 340 }}
      >
        <div ref={terminalHostRef} className="h-full w-full" />
        <SelectionOverlay terminalId={id} />
      </div>
    </TouchUiContext.Provider>
  );
}

const meta: Meta<typeof SelectionOverlayStory> = {
  title: 'Components/SelectionOverlay',
  component: SelectionOverlayStory,
  parameters: {
    fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) },
  },
};

export default meta;
type Story = StoryObj<typeof SelectionOverlayStory>;

export const LinewiseDrag: Story = {
  args: {
    id: 'selection-overlay-linewise-drag',
    selection: {
      startRow: 2,
      startCol: 5,
      endRow: 6,
      endCol: 24,
      shape: 'linewise',
      dragging: true,
    },
  },
};

export const BlockDrag: Story = {
  args: {
    id: 'selection-overlay-block-drag',
    selection: {
      startRow: 2,
      startCol: 6,
      endRow: 5,
      endCol: 26,
      shape: 'block',
      dragging: true,
    },
  },
};

// Mobile: the block-selection hint reads "double-tap" instead of "Hold Opt", and
// sits above the selection (never below) so the dragging thumb can't cover it.
export const MobileLinewiseDrag: Story = {
  args: {
    id: 'selection-overlay-mobile-linewise-drag',
    touch: true,
    selection: {
      startRow: 2,
      startCol: 5,
      endRow: 6,
      endCol: 24,
      shape: 'linewise',
      dragging: true,
    },
  },
};

export const MobileBlockDrag: Story = {
  args: {
    id: 'selection-overlay-mobile-block-drag',
    touch: true,
    selection: {
      startRow: 2,
      startCol: 6,
      endRow: 5,
      endCol: 26,
      shape: 'block',
      dragging: true,
    },
  },
};

export const SmartPathHint: Story = {
  args: {
    id: 'selection-overlay-smart-path-hint',
    selection: {
      startRow: 2,
      startCol: 5,
      endRow: 6,
      endCol: 24,
      shape: 'linewise',
      dragging: true,
    },
    hintToken: {
      kind: 'path',
      row: 8,
      startCol: 35,
      endCol: 38,
      text: 'src',
    },
  },
};
