import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TerminalPane } from '../components/TerminalPane';
import {
  flattenScenario,
  SCENARIO_ANSI_COLORS,
  SCENARIO_FAST_OUTPUT,
  SCENARIO_LS_OUTPUT,
} from '../lib/platform';
import { clearSizeHold, holdSize } from '../lib/size-hold-store';
import { getTerminalInstance } from '../lib/terminal-registry';
import { settleTerminals } from './settle-terminals';

/**
 * A remote session holding the pane at its own grid, as a phone's attach leaves
 * it: the phone's size in the corner, and the strip that explains it
 * (`docs/specs/remote-api.md` → "Size authority").
 */
interface Held {
  label: string;
  cols: number;
  rows: number;
}

function TerminalContainer({
  id = 'story-terminal',
  held,
  width = '100%',
}: {
  id?: string;
  held?: Held;
  width?: number | string;
}) {
  useEffect(() => {
    if (!held) return;
    // After the pane's own mount (a child's effect runs first), before its first
    // fit: the hold makes that fit a no-op, as the phone's attach would.
    holdSize(id, { holder: 'story-session', label: held.label, lease: '1', serviceId: 'story-service', cols: held.cols, rows: held.rows });
    getTerminalInstance(id)?.resize(held.cols, held.rows);
    return () => clearSizeHold(id);
  }, [id, held]);
  return (
    <div style={{ width, height: '500px' }} className="bg-terminal-bg">
      <TerminalPane id={id} isFocused={true} />
    </div>
  );
}

const meta: Meta<typeof TerminalContainer> = {
  title: 'Terminal/TerminalPane',
  component: TerminalContainer,
  // Hold every snapshot until the terminal has written its scenario and painted,
  // so Chromatic never captures a half-rendered prompt.
  play: () => settleTerminals(),
};

export default meta;
type Story = StoryObj<typeof TerminalContainer>;

export const AnsiColors: Story = {
  args: { id: 'term-colors' },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_ANSI_COLORS) } },
};

export const FastOutput: Story = {
  args: { id: 'term-fast' },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_FAST_OUTPUT) } },
};

/** A phone holds this pane: its grid top-left, the strip bottom-right. */
export const SizedForPhone: Story = {
  args: { id: 'term-held', held: { label: 'iPhone', cols: 51, rows: 14 } },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
};

/** A paired device's own label in a narrow pane, which the strip truncates rather than wraps. */
export const SizedForLongLabel: Story = {
  args: {
    id: 'term-held-long',
    width: 360,
    held: { label: 'Ned’s iPhone 17 Pro Max (Safari, work profile)', cols: 30, rows: 14 },
  },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
};
