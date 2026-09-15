import type { Meta, StoryObj } from '@storybook/react';
import { TerminalPane } from '../components/TerminalPane';
import {
  flattenScenario,
  SCENARIO_ANSI_COLORS,
  SCENARIO_FAST_OUTPUT,
} from '../lib/platform';
import { settleTerminals } from './settle-terminals';

function TerminalContainer({ id = 'story-terminal' }: { id?: string }) {
  return (
    <div style={{ width: '100%', height: '500px' }} className="bg-terminal-bg">
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
