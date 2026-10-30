import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { StrayKeyModal } from '../components/StrayKeyPrompt';

function StrayKeyFrame({ strayKey = 'l', workspaces = true }: { strayKey?: string; workspaces?: boolean }) {
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setFrameEl} className="relative bg-app-bg" style={{ width: 600, height: 400 }}>
      {/* Simulated terminal content behind the overlay */}
      <div className="p-4 font-mono text-sm text-terminal-fg">
        <div>user@dormouse:~$</div>
      </div>
      <StrayKeyModal strayKey={strayKey} workspaces={workspaces} targetElement={frameEl} />
    </div>
  );
}

const meta: Meta<typeof StrayKeyFrame> = {
  title: 'Modals/StrayKeyModal',
  component: StrayKeyFrame,
  argTypes: {
    strayKey: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof StrayKeyFrame>;

export const Default: Story = {
  args: { strayKey: 'l' },
};

export const Space: Story = {
  args: { strayKey: ' ' },
};

/** VS Code's bare Wall binds no Workspace digits, so the list leaves them out. */
export const BareWall: Story = {
  args: { strayKey: '3', workspaces: false },
};
