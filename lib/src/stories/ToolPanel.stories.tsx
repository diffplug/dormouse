import type { Meta, StoryObj } from '@storybook/react';
import { ToolPanel } from '../components/wall/ToolPanel';
import { SCENARIO_SHELL_PROMPT } from '../lib/platform';
import { flattenScenario } from './fake-scenarios';
import { requireElement, settleTerminals } from './settle-terminals';

const TOOL_ID = 'story-tool';

/** A served Tool's identity, as a launch resolves it; no `url`, so nothing frames. */
const TOOL_PARAMS = {
  surfaceType: 'tool',
  command: 'pnpm dev',
  toolName: 'dev',
  toolRender: 'iframe',
  toolPort: 'auto',
};

function ToolPanelStory({ ports, width }: { ports?: number[]; width: number }) {
  return (
    <div style={{ width, height: 360 }} className="relative bg-terminal-bg">
      <ToolPanel id={TOOL_ID} title="dev" params={ports ? { ...TOOL_PARAMS, toolPortConflict: ports } : TOOL_PARAMS} />
    </div>
  );
}

const meta: Meta<typeof ToolPanelStory> = {
  title: 'Components/ToolPanel',
  component: ToolPanelStory,
  args: { width: 640 },
  parameters: { fakePty: { scenario: flattenScenario(SCENARIO_SHELL_PROMPT) } },
  play: () => settleTerminals(),
};

export default meta;
type Story = StoryObj<typeof ToolPanelStory>;

/** Running, not serving yet: the Tool's terminal half alone. */
export const Starting: Story = {};

/** `port: auto` saw several ports, so the browser half explains instead of framing one. */
export const PortConflict: Story = {
  args: { ports: [3000, 5173, 6006] },
  play: async () => {
    await settleTerminals();
    await requireElement('[data-tool-half="browser"]', 'port-conflict half');
  },
};

/** The conflict message in a narrow pane. */
export const PortConflictNarrow: Story = {
  ...PortConflict,
  args: { ports: [3000, 5173, 6006, 24678], width: 260 },
};
