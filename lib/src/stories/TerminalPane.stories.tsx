import type { Meta, StoryObj } from '@storybook/react';
import { TerminalPane } from '../components/TerminalPane';
import {
  flattenScenario,
  SCENARIO_SHELL_PROMPT,
  SCENARIO_LS_OUTPUT,
  SCENARIO_ANSI_COLORS,
  SCENARIO_LONG_RUNNING,
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

export const ShellPrompt: Story = {
  args: { id: 'term-prompt' },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) } },
};

export const LsOutput: Story = {
  args: { id: 'term-ls' },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LS_OUTPUT) } },
};

export const AnsiColors: Story = {
  args: { id: 'term-colors' },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_ANSI_COLORS) } },
};

export const LongRunning: Story = {
  args: { id: 'term-long' },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_LONG_RUNNING) } },
};

export const FastOutput: Story = {
  args: { id: 'term-fast' },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_FAST_OUTPUT) } },
};
