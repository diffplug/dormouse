import type { Meta, StoryObj } from '@storybook/react';
import { KillConfirmCard, type KillExit } from '../components/KillConfirm';

function KillModal({ char = 'G', onCancel, exit }: { char?: string; onCancel?: () => void; exit?: KillExit }) {
  return (
    <div className="relative bg-app-bg" style={{ width: 600, height: 400 }}>
      {/* Simulated terminal content behind the overlay */}
      <div className="p-4 font-mono text-sm text-terminal-fg">
        <div>user@dormouse:~$ npm run build</div>
        <div className="text-muted">Building project...</div>
      </div>
      {/* Kill confirmation overlay — positioned over the pane */}
      <div className="absolute inset-0 flex items-center justify-center bg-app-bg/50 rounded">
        <KillConfirmCard char={char} onCancel={onCancel} exit={exit} />
      </div>
    </div>
  );
}

const meta: Meta<typeof KillModal> = {
  title: 'Components/KillModal',
  component: KillModal,
  argTypes: {
    char: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof KillModal>;

export const Default: Story = {
  args: { char: 'G' },
};

export const RandomChar: Story = {
  args: { char: 'W' },
};

export const Shaking: Story = {
  args: { char: 'G', exit: 'shake' },
};
