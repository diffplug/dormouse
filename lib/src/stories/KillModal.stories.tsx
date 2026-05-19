import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { KillConfirmCard, type KillExit } from '../components/KillConfirm';
import { ModalOverlay } from '../components/design';

function KillModal({ char = 'G', onCancel, exit }: { char?: string; onCancel?: () => void; exit?: KillExit }) {
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setFrameEl} className="relative bg-app-bg" style={{ width: 600, height: 400 }}>
      {/* Simulated terminal content behind the overlay */}
      <div className="p-4 font-mono text-sm text-terminal-fg">
        <div>user@dormouse:~$ npm run build</div>
        <div className="text-muted">Building project...</div>
      </div>
      <ModalOverlay targetElement={frameEl}>
        <KillConfirmCard char={char} onCancel={onCancel} exit={exit} />
      </ModalOverlay>
    </div>
  );
}

const meta: Meta<typeof KillModal> = {
  title: 'Modals/KillModal',
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
